// Authoritative game simulation. Pure functions over `World`.
// The server owns the only real World; clients receive fog-filtered snapshots.

import {
  BASE_POP_CAP,
  BUILDING_DEFS,
  CARRY_CAPACITY,
  HARD_POP_CAP,
  STARTING_RESOURCES,
  TICK_DT,
  UNIT_DEFS,
  UPGRADE_DEFS,
  canAfford,
  damageMultiplier,
  emptyResources,
  gatherRate,
  incomingDamage,
  payCost,
  unitDamage,
} from "./constants";
import { Fog, updateVision } from "./fog";
import { dist, inBounds, rectContains, tileIndex } from "./geometry";
import { generateMap } from "./map";
import { findPath, isWalkable } from "./pathfinding";
import {
  bytesToBase64,
  type BuildingDTO,
  type Command,
  type Snapshot,
  type UnitDTO,
} from "./protocol";
import type {
  Building,
  BuildingType,
  EntityId,
  PlayerId,
  QueuedOrder,
  ResourceKind,
  ResourceNode,
  Unit,
  UnitType,
  Vec2,
  World,
} from "./types";

export interface PlayerSeed {
  name: string;
  color: string;
  /** team id; omit/duplicate-per-player for FFA */
  team?: number;
}

/** Two players are allies if they share a team. */
export function sameTeam(world: World, a: PlayerId, b: PlayerId): boolean {
  if (a === b) return true;
  const pa = world.players[a];
  const pb = world.players[b];
  return !!pa && !!pb && pa.team === pb.team;
}

const ARRIVE_EPS = 0.06;
// How close a unit must be to act on a target. Must exceed sqrt(2) so a worker
// standing diagonally-adjacent to a node tucked under a building (a farm's
// hosted food node) still counts as in reach.
const REACH_DIST = 1.5;
const RETALIATE_TTL_MS = 4000; // how long an idle unit remembers who hit it

// ---------------------------------------------------------------- world setup

export function createWorld(seed: number, playerSeeds: PlayerSeed[]): World {
  const gen = generateMap(seed, playerSeeds.length);
  const world: World = {
    seed,
    tick: 0,
    map: gen.map,
    players: [],
    units: [],
    buildings: [],
    resourceNodes: gen.resourceNodes,
    nextEntityId: gen.nextEntityId,
    winner: null,
    stats: playerSeeds.map(() => ({
      unitsTrained: 0,
      unitsLost: 0,
      resourcesGathered: 0,
      buildingsBuilt: 0,
      peakPop: 0,
    })),
  };

  playerSeeds.forEach((ps, i) => {
    world.players.push({
      id: i,
      name: ps.name,
      color: ps.color,
      team: ps.team ?? i, // FFA default: each player is their own team
      resources: { ...STARTING_RESOURCES },
      pop: 0,
      popCap: BASE_POP_CAP,
      alive: true,
      conceded: false,
      upgrades: [],
    });
    const spawn = gen.spawns[i];
    // Town center
    const tc: Building = {
      id: world.nextEntityId++,
      owner: i,
      type: "town_center",
      tile: { x: spawn.x, y: spawn.y },
      hp: BUILDING_DEFS.town_center.hp,
      progress: 1,
      queue: [],
      produceTimer: 0,
      rally: null,
      research: null,
      researchTimer: 0,
      attackCooldown: 0,
    };
    world.buildings.push(tc);
    // Three starting workers near the town center
    for (let k = 0; k < 3; k++) {
      world.units.push(makeUnit(world, i, "worker", {
        x: spawn.x + 4 + k * 0.6,
        y: spawn.y + 4,
      }));
    }
  });

  recomputePop(world);
  return world;
}

function makeUnit(world: World, owner: PlayerId, type: UnitType, pos: Vec2): Unit {
  return {
    id: world.nextEntityId++,
    owner,
    type,
    pos: { ...pos },
    hp: UNIT_DEFS[type].hp,
    state: "idle",
    path: [],
    carry: null,
    targetEntity: null,
    targetTile: null,
    attackCooldown: 0,
    stuck: 0,
    repaths: 0,
    aggro: null,
    attackedBy: null,
    attackedTtl: 0,
    retaliating: false,
    lastGatherNode: null,
    orders: [],
  };
}

// ---------------------------------------------------------------- lookups

const unitById = (w: World, id: EntityId) => w.units.find((u) => u.id === id);
const buildingById = (w: World, id: EntityId) => w.buildings.find((b) => b.id === id);
const nodeById = (w: World, id: EntityId) => w.resourceNodes.find((n) => n.id === id);

function buildingCenter(b: Building): Vec2 {
  const d = BUILDING_DEFS[b.type].size;
  return { x: b.tile.x + d.w / 2, y: b.tile.y + d.h / 2 };
}

function distToBuilding(pos: Vec2, b: Building): number {
  const d = BUILDING_DEFS[b.type].size;
  // distance to nearest point of the footprint rectangle
  const cx = Math.max(b.tile.x, Math.min(pos.x, b.tile.x + d.w));
  const cy = Math.max(b.tile.y, Math.min(pos.y, b.tile.y + d.h));
  return dist(pos, { x: cx, y: cy });
}

function buildingBlocker(world: World, ignore?: EntityId) {
  return (x: number, y: number): boolean => {
    for (const b of world.buildings) {
      if (b.id === ignore) continue;
      const d = BUILDING_DEFS[b.type].size;
      if (rectContains(b.tile.x, b.tile.y, d.w, d.h, x, y)) return true;
    }
    return false;
  };
}

function nearestDropOff(world: World, owner: PlayerId, pos: Vec2): Building | null {
  let best: Building | null = null;
  let bestD = Infinity;
  for (const b of world.buildings) {
    if (b.owner !== owner) continue;
    if (b.progress < 1) continue;
    if (!BUILDING_DEFS[b.type].isDropOff) continue;
    const d = distToBuilding(pos, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Nearest walkable tile on the ring just outside a building's footprint.
 * Units must stand adjacent to a building (not on it) to deposit or construct,
 * otherwise they get trapped on interior tiles whose neighbours are all blocked.
 */
function approachTile(world: World, b: Building, from: Vec2): Vec2 | null {
  const d = BUILDING_DEFS[b.type].size;
  const blocked = buildingBlocker(world, b.id);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (let y = b.tile.y - 1; y <= b.tile.y + d.h; y++) {
    for (let x = b.tile.x - 1; x <= b.tile.x + d.w; x++) {
      const inside = x >= b.tile.x && x < b.tile.x + d.w && y >= b.tile.y && y < b.tile.y + d.h;
      if (inside) continue;
      if (!isWalkable(world.map, x, y) || blocked(x, y)) continue;
      const c = { x: x + 0.5, y: y + 0.5 };
      const dd = dist(from, c);
      if (dd < bestD) {
        bestD = dd;
        best = c;
      }
    }
  }
  return best;
}

function pathToBuilding(world: World, u: Unit, b: Building): Vec2[] {
  const target = approachTile(world, b, u.pos) ?? buildingCenter(b);
  return findPath(world.map, u.pos, target, buildingBlocker(world, b.id));
}

// ---------------------------------------------------------------- commands

export function applyCommand(world: World, playerId: PlayerId, cmd: Command): void {
  if (world.winner !== null) return;
  const player = world.players[playerId];
  if (!player || !player.alive) return;

  switch (cmd.c) {
    case "move": {
      const movers: Unit[] = [];
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId) continue;
        movers.push(u);
      }
      if (cmd.queue) {
        for (const u of movers) u.orders.push({ k: "move", tile: { ...cmd.tile } });
        break;
      }
      for (const u of movers) u.orders = [];
      if (movers.length === 1) {
        orderMove(world, movers[0], cmd.tile);
      } else if (movers.length > 1) {
        // Spread the group into a formation around the click so they arrive as a
        // block instead of all converging on one tile and shoving each other.
        const slots = formationSlots(world, cmd.tile, movers);
        for (let i = 0; i < movers.length; i++) orderMove(world, movers[i], slots[i]);
      }
      break;
    }
    case "stop": {
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId) continue;
        u.state = "idle";
        u.path = [];
        u.targetEntity = null;
        u.targetTile = null;
        u.aggro = null;
        u.attackedBy = null;
        u.retaliating = false;
        u.orders = [];
      }
      break;
    }
    case "gather": {
      const node = nodeById(world, cmd.node);
      if (!node) break;
      if (node.owner !== undefined && node.owner !== playerId) break; // enemy farm
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId || u.type !== "worker") continue;
        if (cmd.queue) {
          u.orders.push({ k: "gather", node: node.id });
          continue;
        }
        u.orders = [];
        u.targetEntity = node.id;
        u.lastGatherNode = node.id;
        u.state = "moving";
        u.path = findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
      }
      break;
    }
    case "build": {
      const u = unitById(world, cmd.unit);
      if (!u || u.owner !== playerId || u.type !== "worker") break;
      const def = BUILDING_DEFS[cmd.building];
      if (!placementValid(world, cmd.building, cmd.tile)) break;
      if (!canAfford(player.resources, def.cost)) break;
      payCost(player.resources, def.cost);
      const b: Building = {
        id: world.nextEntityId++,
        owner: playerId,
        type: cmd.building,
        tile: { x: cmd.tile.x, y: cmd.tile.y },
        hp: Math.max(1, Math.floor(def.hp * 0.1)),
        progress: 0,
        queue: [],
        produceTimer: 0,
        rally: null,
        research: null,
        researchTimer: 0,
        attackCooldown: 0,
      };
      world.buildings.push(b);
      u.targetEntity = b.id;
      u.state = "moving";
      u.path = pathToBuilding(world, u, b);
      break;
    }
    case "construct": {
      // Send workers to (resume) constructing an existing, unfinished building —
      // e.g. one whose original builder was re-tasked away.
      const b = buildingById(world, cmd.building);
      if (!b || b.owner !== playerId || b.progress >= 1) break;
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId || u.type !== "worker") continue;
        u.targetEntity = b.id;
        u.targetTile = null;
        u.aggro = null;
        u.state = "moving";
        u.path = pathToBuilding(world, u, b);
      }
      break;
    }
    case "train": {
      const b = buildingById(world, cmd.building);
      if (!b || b.owner !== playerId || b.progress < 1) break;
      const bdef = BUILDING_DEFS[b.type];
      if (!bdef.canTrain.includes(cmd.unit)) break;
      const udef = UNIT_DEFS[cmd.unit];
      if (!canAfford(player.resources, udef.cost)) break;
      if (player.pop + countQueued(player, world) + udef.popCost > player.popCap) break;
      payCost(player.resources, udef.cost);
      b.queue.push(cmd.unit);
      if (b.queue.length === 1) b.produceTimer = udef.trainMs;
      break;
    }
    case "cancelTrain": {
      const b = buildingById(world, cmd.building);
      if (!b || b.owner !== playerId || b.queue.length === 0) break;
      // Refund the last-queued unit and remove it.
      const removed = b.queue.pop()!;
      const rdef = UNIT_DEFS[removed];
      player.resources.wood += rdef.cost.wood ?? 0;
      player.resources.food += rdef.cost.food ?? 0;
      player.resources.gold += rdef.cost.gold ?? 0;
      if (b.queue.length === 0) b.produceTimer = 0;
      break;
    }
    case "research": {
      const b = buildingById(world, cmd.building);
      if (!b || b.owner !== playerId || b.progress < 1) break;
      if (b.research !== null) break; // already researching here
      const udef = UPGRADE_DEFS[cmd.upgrade];
      if (!udef || udef.building !== b.type) break;
      if (player.upgrades.includes(cmd.upgrade)) break; // already have it
      // not already being researched elsewhere
      if (world.buildings.some((x) => x.owner === playerId && x.research === cmd.upgrade)) break;
      if (!canAfford(player.resources, udef.cost)) break;
      payCost(player.resources, udef.cost);
      b.research = cmd.upgrade;
      b.researchTimer = udef.researchMs;
      break;
    }
    case "rally": {
      const b = buildingById(world, cmd.building);
      if (!b || b.owner !== playerId) break;
      b.rally = tileCenterOf(cmd.tile);
      break;
    }
    case "attack": {
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId) continue;
        if (cmd.queue) {
          u.orders.push({ k: "attack", target: cmd.target });
          continue;
        }
        u.orders = [];
        u.targetEntity = cmd.target;
        u.state = "attacking";
        u.targetTile = null;
        u.aggro = null;
        u.attackedBy = null;
        u.retaliating = false; // explicit attack: chase, don't treat as retaliation
        u.path = [];
      }
      break;
    }
    case "attackMove": {
      const goal = tileCenterOf(cmd.tile);
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId) continue;
        if (cmd.queue) {
          u.orders.push({ k: "attackMove", tile: { ...cmd.tile } });
          continue;
        }
        u.orders = [];
        u.state = "moving";
        u.targetEntity = null;
        u.targetTile = { ...cmd.tile };
        u.aggro = { ...goal };
        u.attackedBy = null;
        u.retaliating = false;
        u.path = findPath(world.map, u.pos, goal, buildingBlocker(world));
      }
      break;
    }
    case "demolish": {
      const b = buildingById(world, cmd.building);
      if (!b || b.owner !== playerId) break;
      const cost = BUILDING_DEFS[b.type].cost;
      // Reclaim half the materials (rounded down) — rewards fixing a misplaced
      // building without making demolish-and-rebuild cycles free.
      player.resources.wood += Math.floor((cost.wood ?? 0) * 0.5);
      player.resources.food += Math.floor((cost.food ?? 0) * 0.5);
      player.resources.gold += Math.floor((cost.gold ?? 0) * 0.5);
      // A farm takes its hosted food node down with it.
      if (b.farmNodeId != null) {
        world.resourceNodes = world.resourceNodes.filter((n) => n.id !== b.farmNodeId);
      }
      world.buildings = world.buildings.filter((x) => x.id !== b.id);
      // Release any of our units that were building or walking to it.
      for (const u of world.units) {
        if (u.owner === playerId && u.targetEntity === b.id) {
          u.targetEntity = null;
          if (u.state === "building" || u.state === "moving") {
            u.state = "idle";
            u.path = [];
          }
        }
      }
      break;
    }
    case "concede": {
      player.conceded = true; // resolved by updateWinState next tick
      break;
    }
  }
}

function orderMove(world: World, u: Unit, tile: Vec2) {
  u.state = "moving";
  u.targetEntity = null;
  u.targetTile = { ...tile };
  u.aggro = null;
  u.attackedBy = null;
  u.retaliating = false;
  u.repaths = 0;
  u.path = findPath(world.map, u.pos, tileCenterOf(tile), buildingBlocker(world));
}

/** Begin a single queued order on a unit (does not touch its remaining queue).
 *  Invalid orders (dead node/wrong type) are skipped by going idle so the next
 *  order is picked up on the following tick. */
function startOrder(world: World, u: Unit, order: QueuedOrder): void {
  switch (order.k) {
    case "move":
      orderMove(world, u, order.tile);
      break;
    case "gather": {
      const node = nodeById(world, order.node);
      if (!node || u.type !== "worker" || (node.owner !== undefined && node.owner !== u.owner)) {
        u.state = "idle";
        return;
      }
      u.targetEntity = node.id;
      u.lastGatherNode = node.id;
      u.targetTile = null;
      u.aggro = null;
      u.attackedBy = null;
      u.retaliating = false;
      u.state = "moving";
      u.path = findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
      break;
    }
    case "attack":
      u.targetEntity = order.target;
      u.state = "attacking";
      u.targetTile = null;
      u.aggro = null;
      u.attackedBy = null;
      u.retaliating = false;
      u.path = [];
      break;
    case "attackMove": {
      const goal = tileCenterOf(order.tile);
      u.state = "moving";
      u.targetEntity = null;
      u.targetTile = { ...order.tile };
      u.aggro = { ...goal };
      u.attackedBy = null;
      u.retaliating = false;
      u.path = findPath(world.map, u.pos, goal, buildingBlocker(world));
      break;
    }
  }
}

/**
 * Assign each unit its own destination tile in a compact block around `anchor`,
 * so a group move spreads into a formation instead of stacking on one tile.
 * Returns a tile per input unit (same order). Deterministic: candidate tiles are
 * the nearest walkable tiles to the anchor (expanding ring), and units claim
 * them greedily by id, each taking the closest free slot to where it stands now
 * (which keeps the group's relative layout and limits path crossing).
 */
function formationSlots(world: World, anchor: Vec2, units: Unit[]): Vec2[] {
  const n = units.length;
  const ax = Math.floor(anchor.x);
  const ay = Math.floor(anchor.y);
  const blocked = buildingBlocker(world);
  const cand: Vec2[] = [];
  const seen = new Set<number>();
  const pushTile = (x: number, y: number) => {
    if (!inBounds(world.map, x, y)) return;
    const k = y * world.map.width + x;
    if (seen.has(k)) return;
    seen.add(k);
    if (!isWalkable(world.map, x, y) || blocked(x, y)) return;
    cand.push({ x, y });
  };
  // Grow square rings outward from the anchor until we have enough open tiles.
  for (let r = 0; cand.length < n && r <= 32; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring at radius r
        pushTile(ax + dx, ay + dy);
      }
    }
  }
  while (cand.length < n) cand.push({ x: ax, y: ay }); // degenerate fallback

  const claimed = new Array<boolean>(cand.length).fill(false);
  const slotFor = new Map<number, Vec2>();
  for (const u of [...units].sort((a, b) => a.id - b.id)) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < cand.length; i++) {
      if (claimed[i]) continue;
      const d = dist(u.pos, { x: cand[i].x + 0.5, y: cand[i].y + 0.5 });
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      claimed[best] = true;
      slotFor.set(u.id, cand[best]);
    }
  }
  return units.map((u) => slotFor.get(u.id) ?? { x: ax, y: ay });
}

/** Recompute a path toward whatever this moving unit is heading for — its order
 *  target entity (node/building), attack-move destination, or plain target tile.
 *  Used to re-route a jammed unit regardless of move kind. */
function repathForMove(world: World, u: Unit): Vec2[] {
  if (u.targetEntity !== null) {
    const node = nodeById(world, u.targetEntity);
    if (node) return findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
    const b = buildingById(world, u.targetEntity);
    if (b) return pathToBuilding(world, u, b);
  }
  if (u.aggro) return findPath(world.map, u.pos, u.aggro, buildingBlocker(world));
  if (u.targetTile) return findPath(world.map, u.pos, tileCenterOf(u.targetTile), buildingBlocker(world));
  return [];
}

/**
 * Find the nearest enemy unit (preferred) or building within this unit's sight
 * radius, for attack-move target acquisition. Returns its entity id, or null.
 */
function acquireTarget(world: World, u: Unit): EntityId | null {
  const sight = UNIT_DEFS[u.type].sight;
  let best: EntityId | null = null;
  let bestD = sight;
  for (const e of world.units) {
    if (sameTeam(world, e.owner, u.owner) || e.hp <= 0) continue;
    const d = dist(u.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e.id;
    }
  }
  if (best !== null) return best;
  // no enemy units in range — look for an enemy building
  bestD = sight;
  for (const b of world.buildings) {
    if (sameTeam(world, b.owner, u.owner)) continue;
    const d = distToBuilding(u.pos, b);
    if (d < bestD) {
      bestD = d;
      best = b.id;
    }
  }
  return best;
}

/** Nearest enemy *unit* (not building) within this unit's sight, or null. Used
 *  to keep a player-issued attacker swinging onto the next foe after a kill. */
function nearestEnemyUnit(world: World, u: Unit): EntityId | null {
  const sight = UNIT_DEFS[u.type].sight;
  let best: EntityId | null = null;
  let bestD = sight;
  for (const e of world.units) {
    if (sameTeam(world, e.owner, u.owner) || e.hp <= 0) continue;
    const d = dist(u.pos, e.pos);
    if (d < bestD) {
      bestD = d;
      best = e.id;
    }
  }
  return best;
}

function tileCenterOf(tile: Vec2): Vec2 {
  return { x: Math.floor(tile.x) + 0.5, y: Math.floor(tile.y) + 0.5 };
}

function countQueued(player: { id: PlayerId }, world: World): number {
  let n = 0;
  for (const b of world.buildings) {
    if (b.owner === player.id) n += b.queue.length;
  }
  return n;
}

export function placementValid(world: World, type: BuildingType, tile: Vec2): boolean {
  const d = BUILDING_DEFS[type].size;
  for (let y = tile.y; y < tile.y + d.h; y++) {
    for (let x = tile.x; x < tile.x + d.w; x++) {
      if (!inBounds(world.map, x, y)) return false;
      const terr = world.map.tiles[tileIndex(world.map, x, y)];
      if (terr === "water" || terr === "rock") return false;
      if (world.resourceNodes.some((n) => n.tile.x === x && n.tile.y === y)) return false;
      for (const b of world.buildings) {
        const bd = BUILDING_DEFS[b.type].size;
        if (rectContains(b.tile.x, b.tile.y, bd.w, bd.h, x, y)) return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------- tick

export function tick(world: World, fog: Fog): void {
  if (world.winner !== null) return;
  world.tick++;

  for (const u of world.units) updateUnit(world, u);
  resolveCollisions(world);

  // production
  for (const b of world.buildings) {
    if (b.progress < 1 || b.queue.length === 0) continue;
    b.produceTimer -= TICK_DT * 1000;
    if (b.produceTimer <= 0) {
      const type = b.queue.shift()!;
      spawnFromBuilding(world, b, type);
      if (b.queue.length > 0) b.produceTimer = UNIT_DEFS[b.queue[0]].trainMs;
    }
  }

  // research
  for (const b of world.buildings) {
    if (b.progress < 1 || b.research === null) continue;
    b.researchTimer -= TICK_DT * 1000;
    if (b.researchTimer <= 0) {
      const p = world.players[b.owner];
      if (p && !p.upgrades.includes(b.research)) p.upgrades.push(b.research);
      b.research = null;
      b.researchTimer = 0;
    }
  }

  // farms slowly replenish their hosted food node up to capacity
  for (const b of world.buildings) {
    if (b.progress < 1 || b.farmNodeId == null) continue;
    const fdef = BUILDING_DEFS[b.type].farm;
    if (!fdef) continue;
    const node = nodeById(world, b.farmNodeId);
    if (node) node.amount = Math.min(fdef.capacity, node.amount + fdef.regenPerSec * TICK_DT);
  }

  // defensive buildings (towers) auto-attack the nearest enemy in range
  tickTowers(world);

  // cleanup dead units, depleted nodes, destroyed buildings. A destroyed farm
  // takes its hosted food node with it; farm nodes (owned) otherwise persist
  // even at 0 so they can regrow.
  const orphanedFarmNodes = new Set<number>();
  for (const b of world.buildings) {
    if (b.hp <= 0 && b.farmNodeId != null) orphanedFarmNodes.add(b.farmNodeId);
  }
  for (const u of world.units) if (u.hp <= 0) world.stats[u.owner].unitsLost++;
  world.units = world.units.filter((u) => u.hp > 0);
  world.resourceNodes = world.resourceNodes.filter(
    (n) => (n.amount > 0 || n.owner !== undefined) && !orphanedFarmNodes.has(n.id),
  );
  world.buildings = world.buildings.filter((b) => b.hp > 0);

  recomputePop(world);
  updateWinState(world);
  updateVision(world, fog);
}

/** A gatherable node sitting on tile (x,y) for `owner`: neutral (any non-empty)
 *  or the owner's own farm node. Used for rally-to-resource auto-gathering. */
function gatherableNodeAt(world: World, x: number, y: number, owner: PlayerId) {
  return (
    world.resourceNodes.find(
      (n) => n.tile.x === x && n.tile.y === y && (n.amount > 0 || n.owner === owner),
    ) ?? null
  );
}

// How far a worker will roam on its own to find the next node of the same kind
// after exhausting one, before giving up and going idle.
const AUTO_GATHER_SEEK = 18;

/** Nearest non-empty node of `kind` a worker may harvest (neutral, or its own
 *  farm), within `maxDist`. Drives auto-advance to the next tree/gold/bush. */
function nearestGatherNode(
  world: World,
  owner: PlayerId,
  pos: Vec2,
  kind: ResourceKind,
  maxDist: number,
): ResourceNode | null {
  let best: ResourceNode | null = null;
  let bestD = maxDist;
  for (const n of world.resourceNodes) {
    if (n.kind !== kind || n.amount <= 0) continue;
    if (n.owner !== undefined && n.owner !== owner) continue; // enemy farm
    const d = distToTile(pos, n.tile);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

function spawnFromBuilding(world: World, b: Building, type: UnitType) {
  const d = BUILDING_DEFS[b.type].size;
  // spawn just outside the footprint, on a walkable tile if possible
  const exit = approachTile(world, b, { x: b.tile.x + d.w + 0.5, y: b.tile.y + d.h / 2 });
  const pos = exit ?? { x: b.tile.x + d.w + 0.5, y: b.tile.y + d.h / 2 };
  const u = makeUnit(world, b.owner, type, pos);
  world.stats[b.owner].unitsTrained++;
  if (b.rally) {
    const rt = { x: Math.floor(b.rally.x), y: Math.floor(b.rally.y) };
    // Worker rallied onto a resource node? Auto-start gathering it instead of
    // just walking to the flag and idling.
    const node = type === "worker" ? gatherableNodeAt(world, rt.x, rt.y, b.owner) : null;
    if (node) {
      u.state = "moving";
      u.targetEntity = node.id;
      u.lastGatherNode = node.id;
      u.path = findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
    } else {
      u.state = "moving";
      u.targetTile = rt;
      u.path = findPath(world.map, u.pos, b.rally, buildingBlocker(world));
    }
  }
  world.units.push(u);
}

/** Towers (and any building with an `attack` def) shoot the nearest enemy unit. */
function tickTowers(world: World): void {
  for (const b of world.buildings) {
    const def = BUILDING_DEFS[b.type];
    if (!def.attack || b.progress < 1) continue;
    if (b.attackCooldown > 0) b.attackCooldown -= TICK_DT * 1000;
    if (b.attackCooldown > 0) continue;
    let target: Unit | null = null;
    let bestD = def.attack.range;
    for (const u of world.units) {
      if (sameTeam(world, u.owner, b.owner) || u.hp <= 0) continue;
      const d = distToBuilding(u.pos, b);
      if (d <= bestD) {
        bestD = d;
        target = u;
      }
    }
    if (target) {
      target.hp -= incomingDamage(world.players[target.owner], target.type, def.attack.damage);
      b.attackCooldown = def.attack.attackMs;
    }
  }
}

const STUCK_LIMIT = 8; // ticks (~0.8s) of no progress before we re-path
const MAX_REPATHS = 4; // re-path attempts on a plain move before giving up

/** Distance from a unit to the end of its current path (its real destination). */
function pathGoalDist(u: Unit): number {
  if (u.path.length === 0) return 0;
  return dist(u.pos, u.path[u.path.length - 1]);
}

/**
 * Bump/reset the stuck counter based on *progress toward the destination*, not
 * raw movement: a unit being jostled in place by neighbours still "moves" a
 * little each tick, which used to mask a jam forever. If it isn't getting closer
 * to its goal, it's stuck (and will re-path).
 */
function bumpStuck(u: Unit, beforeGoalDist: number): void {
  if (u.path.length > 0 && beforeGoalDist - pathGoalDist(u) < 0.01) {
    u.stuck++;
  } else {
    u.stuck = 0;
    u.repaths = 0; // made progress — refresh the re-path budget for later jams
  }
}

/**
 * Engage a target as soon as we're close enough, instead of requiring the unit
 * to reach the exact target tile (which may be occupied by another unit).
 * Returns true if it transitioned to an action state.
 */
function tryEngageTarget(world: World, u: Unit): boolean {
  if (u.targetEntity === null) return false;
  const node = nodeById(world, u.targetEntity);
  if (node) {
    if (distToTile(u.pos, node.tile) <= REACH_DIST) {
      u.state = "gathering";
      u.path = [];
      u.stuck = 0;
      return true;
    }
    return false;
  }
  const b = buildingById(world, u.targetEntity);
  if (b && b.owner === u.owner && b.progress < 1) {
    if (distToBuilding(u.pos, b) <= REACH_DIST + 0.6) {
      u.state = "building";
      u.path = [];
      u.stuck = 0;
      return true;
    }
  }
  return false;
}

function updateUnit(world: World, u: Unit): void {
  if (u.attackCooldown > 0) u.attackCooldown -= TICK_DT * 1000;
  // Let the "who hit me" memory lapse only while not actively retaliating, so a
  // unit mid-fight doesn't forget its foe and disengage early.
  if (u.attackedTtl > 0 && u.state !== "attacking") {
    u.attackedTtl -= TICK_DT * 1000;
    if (u.attackedTtl <= 0) u.attackedBy = null;
  }

  switch (u.state) {
    case "idle":
      // Pick up the next queued order (shift-click) before considering defence.
      if (u.orders.length > 0) {
        startOrder(world, u, u.orders.shift()!);
        return;
      }
      tryRetaliate(world, u);
      return;
    case "moving": {
      // Attack-move: engage any enemy that comes into sight while travelling.
      if (u.aggro) {
        const tid = acquireTarget(world, u);
        if (tid !== null) {
          u.targetEntity = tid;
          u.state = "attacking";
          u.path = [];
          u.stuck = 0;
          return;
        }
      }
      const beforeDist = pathGoalDist(u);
      stepAlongPath(world, u);
      bumpStuck(u, beforeDist);
      if (tryEngageTarget(world, u)) return;
      const arrived = u.path.length === 0;
      // Jammed mid-route (a building dropped on our path, a crowd, etc.): re-path
      // toward the goal a bounded number of times instead of giving up. Applies
      // to every kind of move — plain, attack-move, and gather/build approaches —
      // not just plain moves.
      if (!arrived && u.stuck >= STUCK_LIMIT && u.repaths < MAX_REPATHS) {
        u.stuck = 0;
        u.repaths++;
        u.path = repathForMove(world, u);
        return;
      }
      if (arrived || u.stuck >= STUCK_LIMIT) {
        u.stuck = 0;
        u.repaths = 0;
        if (u.aggro) {
          // reached the attack-move destination (or gave up re-pathing to it)
          u.aggro = null;
          u.state = "idle";
          u.targetTile = null;
        } else {
          onArrive(world, u);
        }
      }
      return;
    }
    case "returning": {
      const beforeDist = pathGoalDist(u);
      stepAlongPath(world, u);
      bumpStuck(u, beforeDist);
      if (u.path.length === 0 || u.stuck >= STUCK_LIMIT) {
        u.stuck = 0;
        tryDeposit(world, u);
      }
      return;
    }
    case "gathering":
      doGather(world, u);
      return;
    case "building":
      doBuild(world, u);
      return;
    case "attacking":
      doAttack(world, u);
      return;
  }
}

function stepAlongPath(world: World, u: Unit): void {
  if (u.path.length === 0) return;
  // 1) Pure straight path-following. Untouched by avoidance so a unit always
  //    advances along its waypoints and actually reaches its goal.
  let budget = UNIT_DEFS[u.type].speed * TICK_DT;
  let hx = 0;
  let hy = 0; // heading of the last (non-snap) step — drives avoidance below
  while (budget > 0 && u.path.length > 0) {
    const target = u.path[0];
    const dx = target.x - u.pos.x;
    const dy = target.y - u.pos.y;
    const d = Math.hypot(dx, dy);
    if (d <= ARRIVE_EPS || d <= budget) {
      u.pos.x = target.x;
      u.pos.y = target.y;
      u.path.shift();
      budget -= d;
    } else {
      hx = dx / d;
      hy = dy / d;
      u.pos.x += hx * budget;
      u.pos.y += hy * budget;
      budget = 0;
    }
  }
  // 2) Separate lateral avoidance: slide around any unit in the corridor ahead
  //    without consuming path budget or dropping waypoints (A* ignores units, so
  //    this is what makes crowds flow past each other instead of jamming).
  //    Skip it on the final leg so units settle onto their goal/formation slot
  //    instead of orbiting it forever when neighbours are nearby.
  if ((hx !== 0 || hy !== 0) && u.path.length > 1) {
    const avoid = avoidanceSteer(world, u, hx, hy);
    if (avoid.x !== 0 || avoid.y !== 0) {
      const lateral = UNIT_DEFS[u.type].speed * TICK_DT;
      const nx = u.pos.x + avoid.x * lateral;
      const ny = u.pos.y + avoid.y * lateral;
      if (stepOpen(world, nx, ny)) {
        u.pos.x = nx;
        u.pos.y = ny;
      }
    }
  }
}

// Local-avoidance tuning.
const AVOID_LOOKAHEAD = 1.1; // tiles ahead we watch for a blocking unit
const AVOID_STRENGTH = 0.6; // fraction of a step spent sliding sideways

/** True if a unit may occupy the point (walkable terrain, no building footprint). */
function stepOpen(world: World, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!isWalkable(world.map, tx, ty)) return false;
  for (const b of world.buildings) {
    const d = BUILDING_DEFS[b.type].size;
    if (rectContains(b.tile.x, b.tile.y, d.w, d.h, tx, ty)) return false;
  }
  return true;
}

/**
 * Lateral steering to slide a moving unit around the nearest other unit directly
 * ahead of it. Returns a perpendicular unit-ish vector (magnitude 0..1, zero if
 * the corridor is clear). Deterministic: a head-on pair always yields to mirrored
 * sides, so they pass each other instead of bouncing back along their approach.
 */
function avoidanceSteer(world: World, u: Unit, hx: number, hy: number): { x: number; y: number } {
  const minSep = UNIT_RADIUS * 2;
  let bestProj = Infinity;
  let bestPerp = 0;
  let found = false;
  for (const v of world.units) {
    if (v === u || v.hp <= 0) continue;
    const rx = v.pos.x - u.pos.x;
    const ry = v.pos.y - u.pos.y;
    if (Math.abs(rx) > AVOID_LOOKAHEAD || Math.abs(ry) > AVOID_LOOKAHEAD) continue; // cheap cull
    const proj = rx * hx + ry * hy; // distance ahead along our heading
    if (proj <= 0 || proj > AVOID_LOOKAHEAD) continue; // behind us or too far
    const perp = rx * -hy + ry * hx; // signed lateral offset (left = positive)
    if (Math.abs(perp) > minSep) continue; // outside our corridor — no conflict
    if (proj < bestProj) {
      bestProj = proj;
      bestPerp = perp;
      found = true;
    }
  }
  if (!found) return { x: 0, y: 0 };
  // Yield away from the blocker's side; a dead-ahead blocker (perp ~ 0) defaults
  // to one fixed side so a head-on pair picks mirrored world-sides and separates.
  const sideSign = bestPerp > 0 ? -1 : 1; // blocker on our left -> veer right
  const lx = -hy; // left-perpendicular unit vector
  const ly = hx;
  const urgency = 1 - bestProj / AVOID_LOOKAHEAD; // closer blockers slide harder
  const s = AVOID_STRENGTH * urgency * sideSign;
  return { x: lx * s, y: ly * s };
}

const UNIT_RADIUS = 0.32; // min separation between unit centres = 2 * radius

/**
 * Soft separation so units don't stack on the same point. Uses a per-tile
 * spatial hash and pushes overlapping pairs apart, never into walls/buildings.
 * Deterministic (no RNG) so the authoritative sim stays reproducible.
 */
function resolveCollisions(world: World): void {
  const minSep = UNIT_RADIUS * 2;
  const w = world.map.width;
  const blocked = buildingBlocker(world);
  const open = (x: number, y: number) =>
    isWalkable(world.map, x, y) && !blocked(x, y);

  const cells = new Map<number, Unit[]>();
  for (const u of world.units) {
    const k = Math.floor(u.pos.y) * w + Math.floor(u.pos.x);
    const arr = cells.get(k);
    if (arr) arr.push(u);
    else cells.set(k, [u]);
  }

  const push = (u: Unit, dx: number, dy: number) => {
    const nx = u.pos.x + dx;
    if (open(Math.floor(nx), Math.floor(u.pos.y))) u.pos.x = nx;
    const ny = u.pos.y + dy;
    if (open(Math.floor(u.pos.x), Math.floor(ny))) u.pos.y = ny;
  };
  // Gathering/constructing units are "anchored": others flow around them, but
  // they aren't displaced (which otherwise causes gather/move state flicker).
  const anchored = (x: Unit) => x.state === "gathering" || x.state === "building";

  for (const u of world.units) {
    const cx = Math.floor(u.pos.x);
    const cy = Math.floor(u.pos.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = cells.get((cy + dy) * w + (cx + dx));
        if (!arr) continue;
        for (const v of arr) {
          if (v.id <= u.id) continue; // resolve each pair once
          let ox = u.pos.x - v.pos.x;
          let oy = u.pos.y - v.pos.y;
          let d = Math.hypot(ox, oy);
          if (d >= minSep) continue;
          if (d < 1e-4) {
            // exactly coincident: deterministic nudge derived from ids
            ox = ((u.id % 7) - 3) * 0.01 + 0.005;
            oy = ((v.id % 5) - 2) * 0.01 + 0.005;
            d = Math.hypot(ox, oy) || 1;
          }
          const overlap = minSep - d;
          const nx = ox / d;
          const ny = oy / d;
          const au = anchored(u);
          const av = anchored(v);
          if (au && av) continue;
          if (au) {
            push(v, -nx * overlap, -ny * overlap);
          } else if (av) {
            push(u, nx * overlap, ny * overlap);
          } else {
            push(u, (nx * overlap) / 2, (ny * overlap) / 2);
            push(v, (-nx * overlap) / 2, (-ny * overlap) / 2);
          }
        }
      }
    }
  }
}

function onArrive(world: World, u: Unit): void {
  // Decide what to do based on the order target.
  if (u.targetEntity !== null) {
    const node = nodeById(world, u.targetEntity);
    if (node) {
      u.state = "gathering";
      return;
    }
    const b = buildingById(world, u.targetEntity);
    if (b && b.owner === u.owner && b.progress < 1) {
      u.state = "building";
      return;
    }
  }
  u.state = "idle";
  u.targetTile = null;
}

function doGather(world: World, u: Unit): void {
  const node = u.targetEntity !== null ? nodeById(world, u.targetEntity) : null;
  if (!node) {
    u.state = "idle";
    return;
  }
  if (distToTile(u.pos, node.tile) > REACH_DIST) {
    // walk to it
    u.state = "moving";
    u.path = findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
    return;
  }
  u.lastGatherNode = node.id; // remember it so we can resume after a build detour
  if (!u.carry || u.carry.kind !== node.kind) u.carry = { kind: node.kind, amount: 0 };
  const rate = gatherRate(world.players[u.owner]);
  const take = Math.min(rate * TICK_DT, node.amount, CARRY_CAPACITY - u.carry.amount);
  node.amount -= take;
  u.carry.amount += take;
  if (u.carry.amount >= CARRY_CAPACITY || node.amount <= 0) {
    startReturn(world, u);
  }
}

function startReturn(world: World, u: Unit): void {
  const drop = nearestDropOff(world, u.owner, u.pos);
  if (!drop) {
    u.state = "idle";
    return;
  }
  u.state = "returning";
  u.path = pathToBuilding(world, u, drop);
}

function tryDeposit(world: World, u: Unit): void {
  const drop = nearestDropOff(world, u.owner, u.pos);
  if (drop && distToBuilding(u.pos, drop) <= REACH_DIST + 0.6 && u.carry) {
    const res = world.players[u.owner].resources;
    // Round to kill floating-point dust accumulated from per-tick (rate * TICK_DT) gathers,
    // which otherwise surfaces as 360.000000000001 / 494.99999999999625 in the HUD.
    res[u.carry.kind] = Math.round((res[u.carry.kind] + u.carry.amount) * 1000) / 1000;
    world.stats[u.owner].resourcesGathered += u.carry.amount;
    const kind = u.carry.kind;
    u.carry = null;
    const node = u.targetEntity !== null ? nodeById(world, u.targetEntity) : null;
    // Resume the same node if it still has anything left. Owned farm nodes
    // persist even at 0 (they regrow), so stick with them too.
    if (node && (node.amount > 0 || node.owner !== undefined)) {
      u.state = "moving";
      u.path = findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
    } else {
      // Node exhausted/gone: auto-advance to the nearest same-kind node within
      // reach and keep gathering, instead of standing idle by an empty patch.
      const next = nearestGatherNode(world, u.owner, u.pos, kind, AUTO_GATHER_SEEK);
      if (next) {
        u.targetEntity = next.id;
        u.lastGatherNode = next.id;
        u.state = "moving";
        u.path = findPath(world.map, u.pos, tileCenterOf(next.tile), buildingBlocker(world));
      } else {
        u.state = "idle";
        u.targetEntity = null;
      }
    }
  } else if (drop) {
    u.state = "returning";
    u.path = pathToBuilding(world, u, drop);
  } else {
    u.state = "idle";
  }
}

function doBuild(world: World, u: Unit): void {
  const b = u.targetEntity !== null ? buildingById(world, u.targetEntity) : null;
  if (!b || b.progress >= 1) {
    // Finished (by us or someone else) / gone. Chaining along a wall line keeps a
    // single worker building the whole run; otherwise go back to gathering.
    if (b && b.type === "wall" && chainToNextWall(world, u)) return;
    resumeGatherOrIdle(world, u);
    return;
  }
  if (distToBuilding(u.pos, b) > REACH_DIST + 0.6) {
    u.state = "moving";
    u.path = pathToBuilding(world, u, b);
    return;
  }
  const def = BUILDING_DEFS[b.type];
  b.progress = Math.min(1, b.progress + (TICK_DT * 1000) / def.buildMs);
  b.hp = Math.max(b.hp, Math.floor(def.hp * (0.1 + 0.9 * b.progress)));
  if (b.progress >= 1) {
    b.hp = def.hp;
    onBuildingComplete(world, b);
    if (b.type === "wall" && chainToNextWall(world, u)) return;
    resumeGatherOrIdle(world, u);
  }
}

/**
 * After finishing a wall, send the builder to the nearest unfinished friendly
 * wall nearby so one worker constructs a whole dragged wall line on its own.
 */
function chainToNextWall(world: World, u: Unit): boolean {
  let best: Building | null = null;
  let bestD = 12; // only chain to walls within a dozen tiles
  for (const b of world.buildings) {
    if (b.owner !== u.owner || b.type !== "wall" || b.progress >= 1) continue;
    const d = distToBuilding(u.pos, b);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (!best) return false;
  u.targetEntity = best.id;
  u.state = "moving";
  u.path = pathToBuilding(world, u, best);
  return true;
}

/** One-time setup when a building finishes: farms spawn their food node. */
function onBuildingComplete(world: World, b: Building): void {
  world.stats[b.owner].buildingsBuilt++;
  const def = BUILDING_DEFS[b.type];
  if (def.farm && (b.farmNodeId === undefined || b.farmNodeId === null)) {
    const node = {
      id: world.nextEntityId++,
      kind: "food" as const,
      tile: { x: b.tile.x, y: b.tile.y },
      amount: def.farm.capacity,
      owner: b.owner,
    };
    world.resourceNodes.push(node);
    b.farmNodeId = node.id;
  }
}

/**
 * After a worker finishes (or abandons) a build, send it back to the resource
 * node it was last gathering if that node still has anything left — otherwise
 * just go idle. Saves the player from re-tasking every builder by hand.
 */
function resumeGatherOrIdle(world: World, u: Unit): void {
  u.targetEntity = null;
  if (u.type === "worker" && u.lastGatherNode !== null) {
    const node = nodeById(world, u.lastGatherNode);
    if (node && node.amount > 0) {
      u.targetEntity = node.id;
      u.state = "moving";
      u.path = findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
      return;
    }
  }
  u.state = "idle";
}

function doAttack(world: World, u: Unit): void {
  if (u.targetEntity === null) {
    if (resumeAggro(world, u)) return;
    u.state = "idle";
    return;
  }
  const def = UNIT_DEFS[u.type];
  const targetUnit = unitById(world, u.targetEntity);
  const targetBuilding = targetUnit ? null : buildingById(world, u.targetEntity);
  if (!targetUnit && !targetBuilding) {
    u.targetEntity = null;
    // Re-acquire the next foe (or march on) if this was an attack-move.
    if (resumeAggro(world, u)) return;
    // Player-issued attack (not leashed retaliation): having felled its target,
    // the unit keeps fighting — it swings onto the nearest enemy unit still in
    // sight so a melee scrum doesn't stall after each kill. Bounded to sight, so
    // it falls idle once no foes remain nearby.
    if (!isRetaliation(u)) {
      const next = nearestEnemyUnit(world, u);
      if (next !== null) {
        u.targetEntity = next;
        u.state = "attacking";
        u.path = [];
        return;
      }
    }
    u.state = "idle";
    return;
  }
  // No friendly fire: never damage an ally even if explicitly ordered to.
  const targetOwner = targetUnit ? targetUnit.owner : targetBuilding!.owner;
  if (sameTeam(world, targetOwner, u.owner)) {
    u.targetEntity = null;
    if (resumeAggro(world, u)) return;
    u.state = "idle";
    return;
  }

  const targetPos = targetUnit ? targetUnit.pos : buildingCenter(targetBuilding!);
  const range = targetUnit
    ? dist(u.pos, targetPos)
    : distToBuilding(u.pos, targetBuilding!);

  if (range > def.range) {
    // Auto-retaliation is leashed: stand and fight, but don't pursue a foe that
    // has fled beyond our sight (otherwise units get kited across the map).
    if (isRetaliation(u) && range > UNIT_DEFS[u.type].sight) {
      u.targetEntity = null;
      u.attackedBy = null;
      u.retaliating = false;
      u.state = "idle";
      u.path = [];
      return;
    }
    // close in
    u.path = findPath(
      world.map,
      u.pos,
      targetUnit ? targetUnit.pos : buildingCenter(targetBuilding!),
      buildingBlocker(world, targetBuilding?.id),
    );
    stepAlongPath(world, u);
    return;
  }
  // in range: attack on cooldown
  if (u.attackCooldown <= 0) {
    const dmg = unitDamage(world.players[u.owner], u.type);
    if (targetUnit) {
      const dealt = dmg * damageMultiplier(u.type, targetUnit.type);
      targetUnit.hp -= incomingDamage(world.players[targetUnit.owner], targetUnit.type, dealt);
      // Remember the attacker so an idle victim fights back (auto-retaliation).
      targetUnit.attackedBy = u.id;
      targetUnit.attackedTtl = RETALIATE_TTL_MS;
    } else if (targetBuilding) targetBuilding.hp -= dmg * damageMultiplier(u.type, "building");
    u.attackCooldown = def.attackMs;
  }
}

/**
 * For an attack-move unit whose target is gone: grab the next enemy in sight,
 * otherwise resume walking toward the attack-move destination. Returns true if
 * the unit was kept busy (caller should not fall through to idle).
 */
function resumeAggro(world: World, u: Unit): boolean {
  if (!u.aggro) return false;
  const next = acquireTarget(world, u);
  if (next !== null) {
    u.targetEntity = next;
    u.state = "attacking";
    u.path = [];
    return true;
  }
  u.state = "moving";
  u.path = findPath(world.map, u.pos, u.aggro, buildingBlocker(world));
  return true;
}

/** True if this unit's current engagement came from auto-retaliation, not a
 * player-issued attack/attack-move (which are allowed to chase across the map).
 * Tracked with an explicit flag rather than inferred from `attackedBy`, because
 * a player-ordered target that hits back would otherwise look like retaliation. */
function isRetaliation(u: Unit): boolean {
  return u.aggro === null && u.retaliating;
}

/**
 * An idle unit that was recently attacked turns to fight back. It does not chase
 * across the map: engagement is dropped once the attacker leaves the unit's
 * sight (see the leash in `doAttack`), and with no `aggro` set the unit falls
 * back to idle when the foe dies — it won't wander off.
 */
function tryRetaliate(world: World, u: Unit): void {
  if (u.attackedBy === null) return;
  const foe = unitById(world, u.attackedBy);
  if (!foe || foe.hp <= 0 || sameTeam(world, foe.owner, u.owner)) {
    u.attackedBy = null;
    return;
  }
  if (dist(u.pos, foe.pos) > UNIT_DEFS[u.type].sight) return; // too far — hold position
  u.targetEntity = foe.id;
  u.state = "attacking";
  u.retaliating = true; // leashed engagement (see isRetaliation / doAttack)
  u.path = [];
}

function distToTile(pos: Vec2, tile: Vec2): number {
  return dist(pos, { x: tile.x + 0.5, y: tile.y + 0.5 });
}

function recomputePop(world: World): void {
  for (const p of world.players) {
    p.pop = 0;
    let cap = BASE_POP_CAP;
    for (const u of world.units) if (u.owner === p.id) p.pop += UNIT_DEFS[u.type].popCost;
    for (const b of world.buildings) {
      if (b.owner === p.id && b.progress >= 1) cap += BUILDING_DEFS[b.type].providesPop;
    }
    p.popCap = Math.min(HARD_POP_CAP, cap);
    if (world.stats[p.id]) world.stats[p.id].peakPop = Math.max(world.stats[p.id].peakPop, p.pop);
  }
}

function updateWinState(world: World): void {
  for (const p of world.players) {
    if (!p.alive) continue;
    // Resigned -> eliminated (sticky, regardless of remaining buildings/units).
    if (p.conceded) {
      p.alive = false;
      continue;
    }
    // No buildings -> eliminated (the classic last-building-standing rule).
    if (!world.buildings.some((b) => b.owner === p.id)) {
      p.alive = false;
      continue;
    }
    // Economic collapse: no food and no units (and nothing queued) is
    // unrecoverable — every unit costs food, so they can never gather or train
    // again. Don't count a player whose building still has a unit queued (its
    // food was already paid; that unit will pop).
    const hasUnit = world.units.some((u) => u.owner === p.id);
    const hasQueued = world.buildings.some((b) => b.owner === p.id && b.queue.length > 0);
    if (p.resources.food < 1 && !hasUnit && !hasQueued) {
      p.alive = false;
    }
  }
  // Game ends when every surviving player belongs to a single team (last team
  // standing). winner is a representative of that team (FFA: the sole survivor).
  const alive = world.players.filter((p) => p.alive);
  const teams = new Set(alive.map((p) => p.team));
  if (world.players.length >= 2 && teams.size <= 1) {
    world.winner = alive.length > 0 ? alive[0].id : null;
  }
}

// ---------------------------------------------------------------- snapshot view

/** World position a queued order points at, for drawing the command-queue path. */
function orderPoint(world: World, o: QueuedOrder): { x: number; y: number } | null {
  switch (o.k) {
    case "move":
    case "attackMove":
      return { x: o.tile.x + 0.5, y: o.tile.y + 0.5 };
    case "gather": {
      const n = nodeById(world, o.node);
      return n ? { x: n.tile.x + 0.5, y: n.tile.y + 0.5 } : null;
    }
    case "attack": {
      const t = unitById(world, o.target);
      if (t) return { x: t.pos.x, y: t.pos.y };
      const b = buildingById(world, o.target);
      if (b) {
        const d = BUILDING_DEFS[b.type].size;
        return { x: b.tile.x + d.w / 2, y: b.tile.y + d.h / 2 };
      }
      return null;
    }
  }
}

/** OR several players' fog masks into one (team-shared vision). Returns a single
 *  player's mask directly when there's only one teammate, to avoid a copy. */
function orMasks(
  masks: Map<PlayerId, Uint8Array>,
  ids: PlayerId[],
  size: number,
  solo?: Uint8Array,
): Uint8Array {
  if (ids.length <= 1) return solo ?? masks.get(ids[0]) ?? new Uint8Array(size);
  const out = new Uint8Array(size);
  for (const id of ids) {
    const m = masks.get(id);
    if (!m) continue;
    for (let i = 0; i < size; i++) if (m[i]) out[i] = 1;
  }
  return out;
}

export function viewFor(world: World, fog: Fog, player: PlayerId): Snapshot {
  const me = world.players[player];
  const w = world.map.width;
  const h = world.map.height;
  const size = w * h;
  // Eliminated players spectate the whole match: reveal the full map and all
  // entities rather than leaving them staring at fog with no vision sources.
  const reveal = !me || !me.alive;
  const myTeam = me ? me.team : -1;
  // Team-shared vision: OR the masks of every teammate (FFA = just this player).
  const mates = me ? world.players.filter((p) => p.team === me.team).map((p) => p.id) : [player];
  const visMask = reveal
    ? new Uint8Array(size).fill(1)
    : orMasks(fog.visible, mates, size, fog.visible.get(player));
  const expMask = reveal
    ? new Uint8Array(size).fill(1)
    : orMasks(fog.explored, mates, size, fog.explored.get(player));
  const seesTile = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && visMask[y * w + x] === 1;
  const expTile = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && expMask[y * w + x] === 1;
  const footprintSeen = (b: Building) => {
    const d = BUILDING_DEFS[b.type].size;
    for (let y = b.tile.y; y < b.tile.y + d.h; y++)
      for (let x = b.tile.x; x < b.tile.x + d.w; x++) if (seesTile(x, y)) return true;
    return false;
  };
  const isAlly = (owner: PlayerId) => world.players[owner]?.team === myTeam;

  const units = world.units
    .filter((u) => isAlly(u.owner) || reveal || seesTile(Math.floor(u.pos.x), Math.floor(u.pos.y)))
    .map((u) => {
      const dto: UnitDTO = {
        id: u.id,
        owner: u.owner,
        type: u.type,
        x: u.pos.x,
        y: u.pos.y,
        hp: u.hp,
        state: u.state,
        carry: u.carry ? u.carry.kind : null,
      };
      // Own units carry their queued-order waypoints for the command-queue overlay.
      if (u.owner === player && u.orders.length > 0) {
        const pts = u.orders
          .map((o) => orderPoint(world, o))
          .filter((p): p is { x: number; y: number } => p !== null);
        if (pts.length > 0) dto.orders = pts;
      }
      return dto;
    });

  const buildings = world.buildings
    .filter((b) => isAlly(b.owner) || reveal || footprintSeen(b))
    .map((b) => {
      const dto: BuildingDTO = {
        id: b.id,
        owner: b.owner,
        type: b.type,
        tx: b.tile.x,
        ty: b.tile.y,
        hp: b.hp,
        progress: b.progress,
      };
      if (b.owner === player) {
        dto.queue = b.queue.slice();
        dto.produceTimer = b.produceTimer;
        dto.produceMs = b.queue.length ? UNIT_DEFS[b.queue[0]].trainMs : 0;
        if (b.rally) {
          dto.rallyX = b.rally.x;
          dto.rallyY = b.rally.y;
        }
        dto.research = b.research;
        dto.researchTimer = b.researchTimer;
        dto.researchMs = b.research ? UPGRADE_DEFS[b.research].researchMs : 0;
      }
      return dto;
    });

  const resources = world.resourceNodes
    .filter((n) => reveal || expTile(n.tile.x, n.tile.y))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      tx: n.tile.x,
      ty: n.tile.y,
      amount: n.amount,
      ...(n.owner !== undefined ? { owner: n.owner } : {}),
    }));

  return {
    tick: world.tick,
    visible: bytesToBase64(visMask),
    explored: bytesToBase64(expMask),
    me: {
      playerId: player,
      resources: me ? { ...me.resources } : emptyResources(),
      pop: me ? me.pop : 0,
      popCap: me ? me.popCap : 0,
      upgrades: me ? me.upgrades.slice() : [],
      alive: me ? me.alive : false,
    },
    players: world.players.map((p) => ({ id: p.id, alive: p.alive })),
    units,
    buildings,
    resources,
  };
}

