// Pure world queries shared by the sim and the worker-task module: entity
// lookups by id and footprint/tile distances. No mutation, no pathfinding, no
// other sim state — a leaf both `sim.ts` and `worker.ts` depend on, so the
// worker loop can read the world without importing the sim back (no cycle).

import { BUILDING_DEFS } from "./constants";
import { dist } from "./geometry";
import type { Building, EntityId, ResourceNode, Unit, Vec2, World } from "./types";

export const unitById = (w: World, id: EntityId): Unit | undefined => w.units.find((u) => u.id === id);
export const buildingById = (w: World, id: EntityId): Building | undefined =>
  w.buildings.find((b) => b.id === id);
export const nodeById = (w: World, id: EntityId): ResourceNode | undefined =>
  w.resourceNodes.find((n) => n.id === id);
export const animalById = (w: World, id: EntityId) => w.animals.find((a) => a.id === id);

/** A building a worker can still work on: unfinished, or finished but damaged. */
export function buildingNeedsWork(b: Building): boolean {
  return b.progress < 1 || b.hp < BUILDING_DEFS[b.type].hp;
}

/** Distance from a point to the nearest point of a building's footprint rectangle. */
export function distToBuilding(pos: Vec2, b: Building): number {
  const d = BUILDING_DEFS[b.type].size;
  const cx = Math.max(b.tile.x, Math.min(pos.x, b.tile.x + d.w));
  const cy = Math.max(b.tile.y, Math.min(pos.y, b.tile.y + d.h));
  return dist(pos, { x: cx, y: cy });
}

/** Distance from a point to a tile's center. */
export function distToTile(pos: Vec2, tile: Vec2): number {
  return dist(pos, { x: tile.x + 0.5, y: tile.y + 0.5 });
}
