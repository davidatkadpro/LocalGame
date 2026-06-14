// The placement rule (plan §1), exercised directly through a hand-built
// PlacementView — the same interface the sim and client adapters fill in. This is
// the test surface that the old client-side copy never had: it's now reachable
// without driving PixiJS.
import { canPlaceBuilding, type GameMap, type PlacementView, type Terrain } from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

// A small all-grass map; tests carve in water/rock and place footprints as needed.
function grassMap(w = 8, h = 8): GameMap {
  return { width: w, height: h, tiles: new Array<Terrain>(w * h).fill("grass") };
}
function set(map: GameMap, x: number, y: number, t: Terrain) {
  map.tiles[y * map.width + x] = t;
}

function view(map: GameMap, opts: Partial<PlacementView> = {}): PlacementView {
  return {
    map,
    hasResourceAt: opts.hasResourceAt ?? (() => false),
    buildingFootprints: opts.buildingFootprints ?? [],
  };
}

// "house" is a buildable building; size is read from BUILDING_DEFS inside the rule.
const HOUSE = "house" as const;

// Clear ground -> valid.
{
  const map = grassMap();
  check("clear grass is placeable", canPlaceBuilding(view(map), HOUSE, { x: 2, y: 2 }));
}

// Out of bounds (negative and past the far edge) -> invalid.
{
  const map = grassMap();
  check("negative tile rejected", !canPlaceBuilding(view(map), HOUSE, { x: -1, y: 2 }));
  check(
    "footprint past the edge rejected",
    !canPlaceBuilding(view(map), HOUSE, { x: map.width - 1, y: 2 }),
  );
}

// Water or rock anywhere under the footprint -> invalid.
{
  const map = grassMap();
  set(map, 3, 2, "water");
  check("water under footprint rejected", !canPlaceBuilding(view(map), HOUSE, { x: 2, y: 2 }));
}
{
  const map = grassMap();
  set(map, 2, 3, "rock");
  check("rock under footprint rejected", !canPlaceBuilding(view(map), HOUSE, { x: 2, y: 2 }));
}
{
  const map = grassMap();
  set(map, 2, 2, "forest"); // forest is buildable (only water/rock block)
  check("forest is placeable", canPlaceBuilding(view(map), HOUSE, { x: 2, y: 2 }));
}

// A resource node on any covered tile -> invalid.
{
  const map = grassMap();
  const v = view(map, { hasResourceAt: (x, y) => x === 3 && y === 3 });
  check("resource node under footprint rejected", !canPlaceBuilding(v, HOUSE, { x: 2, y: 2 }));
  check("resource node just outside is fine", canPlaceBuilding(v, HOUSE, { x: 4, y: 4 }));
}

// Overlapping an existing building footprint -> invalid; adjacent is fine.
{
  const map = grassMap();
  const v = view(map, { buildingFootprints: [{ x: 2, y: 2, w: 2, h: 2 }] });
  check("overlapping a building rejected", !canPlaceBuilding(v, HOUSE, { x: 3, y: 3 }));
  check("flush-adjacent building is fine", canPlaceBuilding(v, HOUSE, { x: 4, y: 2 }));
}

console.log(pass ? "PLACEMENT: PASS ✅" : "PLACEMENT: FAIL ❌");
process.exit(pass ? 0 : 1);
