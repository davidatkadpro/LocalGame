// Worker task lifecycle — the economy state machine for a single worker, with
// one owner instead of five. The loop: gather → return → deposit → resume the
// same node / seek the next same-kind patch; plus the build/repair detour
// (construct, chain along a dragged wall line, then resume gathering). The plan
// (§5) pulls this out of the sim so "what a worker does next" reads top-to-bottom
// in one place rather than being reconstructed across `updateUnit`, `doGather`,
// `tryDeposit`, `doBuild`, and the command arms.
//
// Pathfinding is the only sim service it borrows, injected as `WorkerServices`
// so this module stays acyclic with `sim.ts` (which owns building-blocker
// geometry). Everything else is pure world queries (`./query`) and tuning
// (`./constants`).

import {
  BUILDING_DEFS,
  CARRY_CAPACITY,
  REACH_DIST,
  TICK_DT,
  WONDER_COUNTDOWN_MS,
  campBonusFor,
  gatherRate,
  isWall,
} from "./constants";
import { buildingById, buildingNeedsWork, distToBuilding, distToTile, nodeById } from "./query";
import type {
  Building,
  BuildingType,
  PlayerId,
  ResourceKind,
  ResourceNode,
  Unit,
  Vec2,
  World,
} from "./types";

const REPAIR_HP_PER_SEC = 20; // hp a worker restores per second when repairing
const REPAIR_COST_RATIO = 0.5; // repairing 0 -> full costs half the build cost
const AUTO_GATHER_SEEK = 18; // tiles a depleted worker searches for the next same-kind node

/** Pathfinding the worker loop needs from the sim — deliberately tiny. The sim
 *  owns building-blocker geometry, so the worker borrows just "path to a
 *  building" and "path to a tile" rather than reaching into that geometry. */
export interface WorkerServices {
  pathToBuilding(world: World, u: Unit, b: Building): Vec2[];
  pathToTile(world: World, u: Unit, tile: Vec2): Vec2[];
}

/** The worker state machine, bound to its pathfinding services. The three drivers
 *  (`doGather`/`tryDeposit`/`doBuild`) are the sim's `updateUnit` entry points;
 *  the transitions between them are internal. */
export interface WorkerSystem {
  doGather(world: World, u: Unit): void;
  tryDeposit(world: World, u: Unit): void;
  doBuild(world: World, u: Unit): void;
}

export function createWorkerSystem(svc: WorkerServices): WorkerSystem {
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

  /** Charge the proportional cost of repairing `heal` hp of `b`. Returns false if
   *  the owner can't afford it (the repair should then stop). Repairing a building
   *  from 0 to full costs REPAIR_COST_RATIO of its build cost. */
  function payRepair(world: World, b: Building, heal: number): boolean {
    const def = BUILDING_DEFS[b.type];
    const frac = (heal / def.hp) * REPAIR_COST_RATIO;
    const wood = (def.cost.wood ?? 0) * frac;
    const food = (def.cost.food ?? 0) * frac;
    const gold = (def.cost.gold ?? 0) * frac;
    const res = world.players[b.owner].resources;
    if (res.wood < wood || res.food < food || res.gold < gold) return false;
    res.wood -= wood;
    res.food -= food;
    res.gold -= gold;
    return true;
  }

  /** One-time setup when a building finishes: farms spawn their food node. */
  function onBuildingComplete(world: World, b: Building): void {
    world.stats[b.owner].buildingsBuilt++;
    // §7.10: a finished Wonder starts ticking its victory countdown.
    if (b.type === "wonder") b.wonderTimer = WONDER_COUNTDOWN_MS;
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

  function startReturn(world: World, u: Unit): void {
    const drop = nearestDropOff(world, u.owner, u.pos);
    if (!drop) {
      u.state = "idle";
      return;
    }
    u.state = "returning";
    u.path = svc.pathToBuilding(world, u, drop);
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
      u.path = svc.pathToTile(world, u, node.tile);
      return;
    }
    u.lastGatherNode = node.id; // remember it so we can resume after a build detour
    if (!u.carry || u.carry.kind !== node.kind) u.carry = { kind: node.kind, amount: 0 };
    // A specialised camp boosts its resource when it's the nearest drop-off, so
    // placing the right camp by the right patch pays off (§7.2).
    const drop = nearestDropOff(world, u.owner, u.pos);
    const camp = drop ? campBonusFor(drop.type, node.kind) : 1;
    const rate = gatherRate(world.players[u.owner]) * camp;
    const take = Math.min(rate * TICK_DT, node.amount, CARRY_CAPACITY - u.carry.amount);
    node.amount -= take;
    u.carry.amount += take;
    if (u.carry.amount >= CARRY_CAPACITY || node.amount <= 0) {
      startReturn(world, u);
    }
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
        u.path = svc.pathToTile(world, u, node.tile);
      } else {
        // Node exhausted/gone: auto-advance to the nearest same-kind node within
        // reach and keep gathering, instead of standing idle by an empty patch.
        const next = nearestGatherNode(world, u.owner, u.pos, kind, AUTO_GATHER_SEEK);
        if (next) {
          u.targetEntity = next.id;
          u.lastGatherNode = next.id;
          u.state = "moving";
          u.path = svc.pathToTile(world, u, next.tile);
        } else {
          u.state = "idle";
          u.targetEntity = null;
        }
      }
    } else if (drop) {
      u.state = "returning";
      u.path = svc.pathToBuilding(world, u, drop);
    } else {
      u.state = "idle";
    }
  }

  function doBuild(world: World, u: Unit): void {
    const b = u.targetEntity !== null ? buildingById(world, u.targetEntity) : null;
    if (!b || !buildingNeedsWork(b)) {
      // Whole (finished and undamaged) or gone. Chaining along a wall line keeps a
      // single worker building the whole run; otherwise go back to gathering.
      if (b && isWall(b.type) && chainToNextWall(world, u, b.type)) return;
      resumeGatherOrIdle(world, u);
      return;
    }
    if (distToBuilding(u.pos, b) > REACH_DIST + 0.6) {
      u.state = "moving";
      u.path = svc.pathToBuilding(world, u, b);
      return;
    }
    const def = BUILDING_DEFS[b.type];
    if (b.progress < 1) {
      // Construction: advance progress, scaling hp with it.
      b.progress = Math.min(1, b.progress + (TICK_DT * 1000) / def.buildMs);
      b.hp = Math.max(b.hp, Math.floor(def.hp * (0.1 + 0.9 * b.progress)));
      if (b.progress >= 1) {
        b.hp = def.hp;
        onBuildingComplete(world, b);
        if (isWall(b.type) && chainToNextWall(world, u, b.type)) return;
        resumeGatherOrIdle(world, u);
      }
      return;
    }
    // Repair: a finished but damaged building. Restore hp over time, paying a
    // proportional materials cost; stop if the owner can't afford it.
    const heal = Math.min(REPAIR_HP_PER_SEC * TICK_DT, def.hp - b.hp);
    if (!payRepair(world, b, heal)) {
      resumeGatherOrIdle(world, u);
      return;
    }
    b.hp = Math.min(def.hp, b.hp + heal);
    if (b.hp >= def.hp) {
      b.hp = def.hp;
      resumeGatherOrIdle(world, u);
    }
  }

  /**
   * After finishing a wall, send the builder to the nearest unfinished friendly
   * wall nearby so one worker constructs a whole dragged wall line on its own.
   */
  function chainToNextWall(world: World, u: Unit, wallType: BuildingType): boolean {
    let best: Building | null = null;
    let bestD = 12; // only chain to walls within a dozen tiles
    for (const b of world.buildings) {
      // Same tier only, so a dragged line of one wall kind builds as a unit and a
      // worker doesn't hop onto a different-tier wall it wasn't dragging.
      if (b.owner !== u.owner || b.type !== wallType || b.progress >= 1) continue;
      const d = distToBuilding(u.pos, b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best) return false;
    u.targetEntity = best.id;
    u.state = "moving";
    u.path = svc.pathToBuilding(world, u, best);
    return true;
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
        u.path = svc.pathToTile(world, u, node.tile);
        return;
      }
    }
    u.state = "idle";
  }

  return { doGather, tryDeposit, doBuild };
}
