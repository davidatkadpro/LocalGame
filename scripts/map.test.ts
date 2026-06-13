// Map-generation checks: the world should be densely wooded, and no resource
// node may sit on a town-center footprint (which would corrupt the spawn).
import { BUILDING_DEFS, createWorld } from "@bg/shared";

const PS = [
  { name: "A", color: "#e6492d" },
  { name: "B", color: "#2d7fe6" },
  { name: "C", color: "#27ae60" },
  { name: "D", color: "#f1c40f" },
];

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

for (const seed of [1, 7, 11, 42]) {
  const world = createWorld(seed, PS);
  const wood = world.resourceNodes.filter((n) => n.kind === "wood").length;
  check(`seed ${seed}: densely wooded map`, wood >= 70, `wood=${wood}`);

  let overlap = false;
  const d = BUILDING_DEFS.town_center.size;
  for (const b of world.buildings) {
    if (b.type !== "town_center") continue;
    for (const n of world.resourceNodes) {
      if (
        n.tile.x >= b.tile.x &&
        n.tile.x < b.tile.x + d.w &&
        n.tile.y >= b.tile.y &&
        n.tile.y < b.tile.y + d.h
      ) {
        overlap = true;
      }
    }
  }
  check(`seed ${seed}: no resource node under a town center`, !overlap);
}

console.log(pass ? "MAP: PASS ✅" : "MAP: FAIL ❌");
process.exit(pass ? 0 : 1);
