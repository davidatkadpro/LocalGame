import { BUILDING_DEFS, UNIT_DEFS } from "./constants";
import { inBounds, tileIndex } from "./geometry";
import type { BuildingType, EntityId, PlayerId, World } from "./types";

/** A player's last-seen snapshot of an enemy building — drawn as a fog "ghost"
 *  once the live building leaves their vision. Frozen at the moment last seen. */
export interface RememberedBuilding {
  id: EntityId;
  owner: PlayerId;
  type: BuildingType;
  tx: number;
  ty: number;
  hp: number;
  progress: number;
}

/**
 * Per-player fog of war.
 * - `visible`: tiles currently in sight of one of the player's entities.
 * - `explored`: tiles the player has ever seen (terrain is remembered).
 * - `buildings`: last-seen state of each enemy building the player has spotted,
 *   so a base they once scouted stays drawn (stale) after they leave (§7 fog memory).
 * Masks are flat Uint8Array (1 = set) indexed like map tiles.
 */
export interface Fog {
  width: number;
  height: number;
  visible: Map<PlayerId, Uint8Array>;
  explored: Map<PlayerId, Uint8Array>;
  buildings: Map<PlayerId, Map<EntityId, RememberedBuilding>>;
}

export function createFog(world: World): Fog {
  const { width, height } = world.map;
  const visible = new Map<PlayerId, Uint8Array>();
  const explored = new Map<PlayerId, Uint8Array>();
  const buildings = new Map<PlayerId, Map<EntityId, RememberedBuilding>>();
  for (const p of world.players) {
    visible.set(p.id, new Uint8Array(width * height));
    explored.set(p.id, new Uint8Array(width * height));
    buildings.set(p.id, new Map());
  }
  return { width, height, visible, explored, buildings };
}

/** True if any tile of a building footprint (at tx,ty of the given type) is set
 *  in the player's mask. */
function footprintInMask(mask: Uint8Array, width: number, tx: number, ty: number, type: BuildingType): boolean {
  const d = BUILDING_DEFS[type].size;
  for (let y = ty; y < ty + d.h; y++) for (let x = tx; x < tx + d.w; x++) if (mask[y * width + x]) return true;
  return false;
}

/**
 * Refresh each player's memory of enemy buildings (§7 fog memory). For every enemy
 * (non-team) building whose footprint the player currently sees, store its current
 * state; when the player can see a remembered building's footprint but it's no
 * longer there (razed), forget it. Buildings out of sight keep their stale entry,
 * so a scouted base lingers until re-seen. Read-only over the world — never mutates
 * the sim, so it can't affect determinism.
 */
export function updateBuildingMemory(world: World, fog: Fog): void {
  const w = world.map.width;
  for (const p of world.players) {
    const mem = fog.buildings.get(p.id);
    const vis = fog.visible.get(p.id);
    if (!mem || !vis) continue;
    const live = new Set<EntityId>();
    for (const b of world.buildings) {
      const owner = world.players[b.owner];
      if (!owner || owner.team === p.team) continue; // only enemies get ghosts
      live.add(b.id);
      if (footprintInMask(vis, w, b.tile.x, b.tile.y, b.type)) {
        mem.set(b.id, { id: b.id, owner: b.owner, type: b.type, tx: b.tile.x, ty: b.tile.y, hp: b.hp, progress: b.progress });
      }
    }
    // Forget a ghost once the player can see its old footprint is empty (razed).
    for (const [id, g] of mem) {
      if (!live.has(id) && footprintInMask(vis, w, g.tx, g.ty, g.type)) mem.delete(id);
    }
  }
}

function reveal(
  world: World,
  vis: Uint8Array,
  exp: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
): void {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
      if (!inBounds(world.map, x, y)) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) {
        const idx = tileIndex(world.map, x, y);
        vis[idx] = 1;
        exp[idx] = 1;
      }
    }
  }
}

/** Recompute current visibility for every player from their units and buildings. */
export function updateVision(world: World, fog: Fog): void {
  for (const p of world.players) {
    fog.visible.get(p.id)!.fill(0);
  }
  for (const u of world.units) {
    const vis = fog.visible.get(u.owner);
    const exp = fog.explored.get(u.owner);
    if (!vis || !exp) continue;
    reveal(world, vis, exp, u.pos.x, u.pos.y, UNIT_DEFS[u.type].sight);
  }
  for (const b of world.buildings) {
    const vis = fog.visible.get(b.owner);
    const exp = fog.explored.get(b.owner);
    if (!vis || !exp) continue;
    const def = BUILDING_DEFS[b.type];
    reveal(
      world,
      vis,
      exp,
      b.tile.x + def.size.w / 2,
      b.tile.y + def.size.h / 2,
      def.sight,
    );
  }
}

export function isVisible(fog: Fog, player: PlayerId, x: number, y: number): boolean {
  const vis = fog.visible.get(player);
  if (!vis) return false;
  if (x < 0 || y < 0 || x >= fog.width || y >= fog.height) return false;
  return vis[y * fog.width + x] === 1;
}

export function isExplored(fog: Fog, player: PlayerId, x: number, y: number): boolean {
  const exp = fog.explored.get(player);
  if (!exp) return false;
  if (x < 0 || y < 0 || x >= fog.width || y >= fog.height) return false;
  return exp[y * fog.width + x] === 1;
}

