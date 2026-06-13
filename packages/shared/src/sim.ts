// Authoritative game simulation. Pure functions over `World`.
// The server owns the only real World; clients receive fog-filtered snapshots.

import {
  BASE_POP_CAP,
  BUILDING_DEFS,
  CARRY_CAPACITY,
  GATHER_PER_SEC,
  HARD_POP_CAP,
  STARTING_RESOURCES,
  TICK_DT,
  UNIT_DEFS,
  canAfford,
  emptyResources,
  payCost,
} from "./constants";
import { Fog, isExplored, isVisible, updateVision } from "./fog";
import { dist, inBounds, tileIndex } from "./geometry";
import { generateMap } from "./map";
import { findPath } from "./pathfinding";
import {
  bytesToBase64,
  type Command,
  type Snapshot,
} from "./protocol";
import type {
  Building,
  BuildingType,
  EntityId,
  PlayerId,
  Unit,
  UnitType,
  Vec2,
  World,
} from "./types";

export interface PlayerSeed {
  name: string;
  color: string;
}

const ARRIVE_EPS = 0.06;
const REACH_DIST = 1.2; // how close a unit must be to act on a target

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
  };

  playerSeeds.forEach((ps, i) => {
    world.players.push({
      id: i,
      name: ps.name,
      color: ps.color,
      resources: { ...STARTING_RESOURCES },
      pop: 0,
      popCap: BASE_POP_CAP,
      alive: true,
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
      if (x >= b.tile.x && x < b.tile.x + d.w && y >= b.tile.y && y < b.tile.y + d.h) {
        return true;
      }
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

// ---------------------------------------------------------------- commands

export function applyCommand(world: World, playerId: PlayerId, cmd: Command): void {
  if (world.winner !== null) return;
  const player = world.players[playerId];
  if (!player || !player.alive) return;

  switch (cmd.c) {
    case "move": {
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId) continue;
        orderMove(world, u, cmd.tile);
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
      }
      break;
    }
    case "gather": {
      const node = nodeById(world, cmd.node);
      if (!node) break;
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId || u.type !== "worker") continue;
        u.targetEntity = node.id;
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
      };
      world.buildings.push(b);
      u.targetEntity = b.id;
      u.state = "moving";
      u.path = findPath(world.map, u.pos, buildingCenter(b), buildingBlocker(world, b.id));
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
    case "attack": {
      for (const id of cmd.units) {
        const u = unitById(world, id);
        if (!u || u.owner !== playerId) continue;
        u.targetEntity = cmd.target;
        u.state = "attacking";
        u.targetTile = null;
        u.path = [];
      }
      break;
    }
  }
}

function orderMove(world: World, u: Unit, tile: Vec2) {
  u.state = "moving";
  u.targetEntity = null;
  u.targetTile = { ...tile };
  u.path = findPath(world.map, u.pos, tileCenterOf(tile), buildingBlocker(world));
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
        if (x >= b.tile.x && x < b.tile.x + bd.w && y >= b.tile.y && y < b.tile.y + bd.h) {
          return false;
        }
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

  // cleanup dead units, depleted nodes, destroyed buildings
  world.units = world.units.filter((u) => u.hp > 0);
  world.resourceNodes = world.resourceNodes.filter((n) => n.amount > 0);
  world.buildings = world.buildings.filter((b) => b.hp > 0);

  recomputePop(world);
  updateWinState(world);
  updateVision(world, fog);
}

function spawnFromBuilding(world: World, b: Building, type: UnitType) {
  const d = BUILDING_DEFS[b.type].size;
  const pos = { x: b.tile.x + d.w + 0.5, y: b.tile.y + d.h / 2 };
  world.units.push(makeUnit(world, b.owner, type, pos));
}

function updateUnit(world: World, u: Unit): void {
  if (u.attackCooldown > 0) u.attackCooldown -= TICK_DT * 1000;

  switch (u.state) {
    case "idle":
      return;
    case "moving":
      stepAlongPath(u);
      if (u.path.length === 0) onArrive(world, u);
      return;
    case "returning":
      stepAlongPath(u);
      if (u.path.length === 0) tryDeposit(world, u);
      return;
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

function stepAlongPath(u: Unit): void {
  if (u.path.length === 0) return;
  const speed = UNIT_DEFS[u.type].speed * TICK_DT;
  let budget = speed;
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
      u.pos.x += (dx / d) * budget;
      u.pos.y += (dy / d) * budget;
      budget = 0;
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
  if (!u.carry || u.carry.kind !== node.kind) u.carry = { kind: node.kind, amount: 0 };
  const take = Math.min(GATHER_PER_SEC * TICK_DT, node.amount, CARRY_CAPACITY - u.carry.amount);
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
  u.path = findPath(world.map, u.pos, buildingCenter(drop), buildingBlocker(world, drop.id));
}

function tryDeposit(world: World, u: Unit): void {
  const drop = nearestDropOff(world, u.owner, u.pos);
  if (drop && distToBuilding(u.pos, drop) <= REACH_DIST && u.carry) {
    world.players[u.owner].resources[u.carry.kind] += u.carry.amount;
    u.carry = null;
    // go back to the node if it still exists
    const node = u.targetEntity !== null ? nodeById(world, u.targetEntity) : null;
    if (node && node.amount > 0) {
      u.state = "moving";
      u.path = findPath(world.map, u.pos, tileCenterOf(node.tile), buildingBlocker(world));
    } else {
      u.state = "idle";
      u.targetEntity = null;
    }
  } else if (drop) {
    u.state = "returning";
    u.path = findPath(world.map, u.pos, buildingCenter(drop), buildingBlocker(world, drop.id));
  } else {
    u.state = "idle";
  }
}

function doBuild(world: World, u: Unit): void {
  const b = u.targetEntity !== null ? buildingById(world, u.targetEntity) : null;
  if (!b || b.progress >= 1) {
    u.state = "idle";
    u.targetEntity = null;
    return;
  }
  if (distToBuilding(u.pos, b) > REACH_DIST + 0.6) {
    u.state = "moving";
    u.path = findPath(world.map, u.pos, buildingCenter(b), buildingBlocker(world, b.id));
    return;
  }
  const def = BUILDING_DEFS[b.type];
  b.progress = Math.min(1, b.progress + (TICK_DT * 1000) / def.buildMs);
  b.hp = Math.max(b.hp, Math.floor(def.hp * (0.1 + 0.9 * b.progress)));
  if (b.progress >= 1) {
    b.hp = def.hp;
    u.state = "idle";
    u.targetEntity = null;
  }
}

function doAttack(world: World, u: Unit): void {
  if (u.targetEntity === null) {
    u.state = "idle";
    return;
  }
  const def = UNIT_DEFS[u.type];
  const targetUnit = unitById(world, u.targetEntity);
  const targetBuilding = targetUnit ? null : buildingById(world, u.targetEntity);
  if (!targetUnit && !targetBuilding) {
    u.state = "idle";
    u.targetEntity = null;
    return;
  }

  const targetPos = targetUnit ? targetUnit.pos : buildingCenter(targetBuilding!);
  const range = targetUnit
    ? dist(u.pos, targetPos)
    : distToBuilding(u.pos, targetBuilding!);

  if (range > def.range) {
    // close in
    u.path = findPath(
      world.map,
      u.pos,
      targetUnit ? targetUnit.pos : buildingCenter(targetBuilding!),
      buildingBlocker(world, targetBuilding?.id),
    );
    stepAlongPath(u);
    return;
  }
  // in range: attack on cooldown
  if (u.attackCooldown <= 0) {
    if (targetUnit) targetUnit.hp -= def.damage;
    else if (targetBuilding) targetBuilding.hp -= def.damage;
    u.attackCooldown = def.attackMs;
  }
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
  }
}

function updateWinState(world: World): void {
  for (const p of world.players) {
    const hasBuilding = world.buildings.some((b) => b.owner === p.id);
    if (!hasBuilding) p.alive = false;
  }
  const alive = world.players.filter((p) => p.alive);
  if (world.players.length >= 2 && alive.length <= 1) {
    world.winner = alive.length === 1 ? alive[0].id : null;
  }
}

// ---------------------------------------------------------------- snapshot view

export function viewFor(world: World, fog: Fog, player: PlayerId): Snapshot {
  const me = world.players[player];
  const visMask = fog.visible.get(player) ?? new Uint8Array(world.map.width * world.map.height);
  const expMask = fog.explored.get(player) ?? new Uint8Array(world.map.width * world.map.height);

  const units = world.units
    .filter((u) => u.owner === player || isVisible(fog, player, Math.floor(u.pos.x), Math.floor(u.pos.y)))
    .map((u) => ({
      id: u.id,
      owner: u.owner,
      type: u.type,
      x: u.pos.x,
      y: u.pos.y,
      hp: u.hp,
      state: u.state,
      carry: u.carry ? u.carry.kind : null,
    }));

  const buildings = world.buildings
    .filter((b) => b.owner === player || buildingFootprintVisible(fog, player, b))
    .map((b) => ({
      id: b.id,
      owner: b.owner,
      type: b.type,
      tx: b.tile.x,
      ty: b.tile.y,
      hp: b.hp,
      progress: b.progress,
    }));

  const resources = world.resourceNodes
    .filter((n) => isExplored(fog, player, n.tile.x, n.tile.y))
    .map((n) => ({ id: n.id, kind: n.kind, tx: n.tile.x, ty: n.tile.y, amount: n.amount }));

  return {
    tick: world.tick,
    visible: bytesToBase64(visMask),
    explored: bytesToBase64(expMask),
    me: {
      playerId: player,
      resources: me ? { ...me.resources } : emptyResources(),
      pop: me ? me.pop : 0,
      popCap: me ? me.popCap : 0,
    },
    units,
    buildings,
    resources,
  };
}

function buildingFootprintVisible(fog: Fog, player: PlayerId, b: Building): boolean {
  const d = BUILDING_DEFS[b.type].size;
  for (let y = b.tile.y; y < b.tile.y + d.h; y++) {
    for (let x = b.tile.x; x < b.tile.x + d.w; x++) {
      if (isVisible(fog, player, x, y)) return true;
    }
  }
  return false;
}

