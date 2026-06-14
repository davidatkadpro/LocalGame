// The one true building-placement rule, shared by the server (authority) and the
// client (the green/red ghost). It lives behind a thin read-only view so both can
// satisfy it: the sim builds a view over its full `World`, the client builds one
// over the fogged `Snapshot`. Single-sourcing the rule means the ghost can never
// disagree with what the server will actually accept.

import { BUILDING_DEFS } from "./constants";
import { inBounds, rectContains, tileIndex } from "./geometry";
import type { BuildingType, GameMap, Vec2 } from "./types";

/** A footprint rectangle in tile coordinates. */
export interface Footprint {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The minimal world a placement check reads. Adapters on each side fill it in
 *  from whatever data they hold (`World` on the server, `Snapshot` on the
 *  client). */
export interface PlacementView {
  map: GameMap;
  /** True if a resource node sits on tile (x, y). */
  hasResourceAt(x: number, y: number): boolean;
  /** Footprints of every existing building that could block placement. */
  buildingFootprints: readonly Footprint[];
}

/** Whether `type`'s footprint, top-left at `tile`, is a legal placement:
 *  fully in-bounds, on buildable terrain (not water/rock), and clear of resource
 *  nodes and other buildings. Call this from both the sim and the client ghost. */
export function canPlaceBuilding(view: PlacementView, type: BuildingType, tile: Vec2): boolean {
  const d = BUILDING_DEFS[type].size;
  for (let y = tile.y; y < tile.y + d.h; y++) {
    for (let x = tile.x; x < tile.x + d.w; x++) {
      if (!inBounds(view.map, x, y)) return false;
      const terr = view.map.tiles[tileIndex(view.map, x, y)];
      if (terr === "water" || terr === "rock") return false;
      if (view.hasResourceAt(x, y)) return false;
      for (const f of view.buildingFootprints) {
        if (rectContains(f.x, f.y, f.w, f.h, x, y)) return false;
      }
    }
  }
  return true;
}
