// §7.6 Wall tiers: palisade (wood, Dark) → stone wall (stone, Feudal) →
// fortified wall (more stone, Imperial). All behave like a wall (1×1, block
// pathing, drag-line + auto-connect); they differ in cost / build time / hp /
// age. Auto-tile graphics + per-tier tint are client-only and not covered here.
import {
  BUILDING_DEFS,
  WALL_TYPES,
  applyCommand,
  createFog,
  createWorld,
  isWall,
  placementValid,
  tick,
  tileBlockedFor,
  type Building,
  type BuildingType,
  type World,
} from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

function addBuilding(world: World, owner: number, type: BuildingType, x: number, y: number, progress = 1): Building {
  const b: Building = {
    id: world.nextEntityId++, owner, type, tile: { x, y },
    hp: BUILDING_DEFS[type].hp, progress, queue: [], produceTimer: 0,
    rally: null, research: null, researchTimer: 0, attackCooldown: 0,
  };
  world.buildings.push(b);
  return b;
}

const openSpot = (world: World, type: BuildingType): { x: number; y: number } | null => {
  for (let y = 2; y < world.map.height - 3; y++)
    for (let x = 2; x < world.map.width - 3; x++)
      if (placementValid(world, type, { x, y })) return { x, y };
  return null;
};

const FFA = [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
];

// ---- 1. the three tiers, weakest → strongest -------------------------------
check("WALL_TYPES lists three tiers", WALL_TYPES.length === 3);
check("isWall flags every tier", WALL_TYPES.every((t) => isWall(t)));
check("isWall excludes gates", !isWall("gate"));
check("isWall excludes non-walls", !isWall("tower") && !isWall("house"));

const W = BUILDING_DEFS.wall;
const SW = BUILDING_DEFS.stone_wall;
const FW = BUILDING_DEFS.fortified_wall;
check("hp climbs across tiers", W.hp < SW.hp && SW.hp < FW.hp, `${W.hp} < ${SW.hp} < ${FW.hp}`);
check("all tiers are 1×1", [W, SW, FW].every((d) => d.size.w === 1 && d.size.h === 1));
check("all tiers are buildable", [W, SW, FW].every((d) => d.buildable));
check("palisade is wood-only (no stone)", !W.cost.stone && (W.cost.wood ?? 0) > 0);
check("upgraded tiers cost stone", (SW.cost.stone ?? 0) > 0 && (FW.cost.stone ?? 0) > 0);
check("fortified costs more stone than stone wall", (FW.cost.stone ?? 0) > (SW.cost.stone ?? 0));
check(
  "age gates climb: Dark → Feudal → Imperial",
  (W.minAge ?? 0) === 0 && (SW.minAge ?? 0) === 1 && (FW.minAge ?? 0) === 2,
);
check("higher tiers take longer to build", W.buildMs < SW.buildMs && SW.buildMs < FW.buildMs);
check("a fortified wall outlasts a ram-bait palisade", FW.hp >= W.hp * 5);

// ---- 2. every tier blocks pathing for everyone -----------------------------
for (const type of WALL_TYPES) {
  const world = createWorld(7, FFA);
  const spot = openSpot(world, type);
  if (!spot) {
    console.log(`WALL-TIERS §2 ${type}: SKIP (no open tile on seed)`);
    continue;
  }
  addBuilding(world, 0, type, spot.x, spot.y);
  check(`${type} blocks its owner`, tileBlockedFor(world, spot.x, spot.y, 0));
  check(`${type} blocks an enemy`, tileBlockedFor(world, spot.x, spot.y, 1));
}

// ---- 3. a Feudal worker builds a stone wall, paying stone -------------------
{
  const world = createWorld(7, [FFA[0]]);
  const fog = createFog(world);
  const p = world.players[0];
  p.age = 1; // Feudal
  p.resources = { wood: 9999, food: 9999, gold: 9999, stone: 9999 };
  const spot = openSpot(world, "stone_wall");
  if (!spot) {
    console.log("WALL-TIERS §3: SKIP (no open tile on seed)");
  } else {
    const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
    worker.pos = { x: spot.x - 0.5, y: spot.y + 0.5 }; // right beside the spot
    world.units = [worker];
    const stoneBefore = p.resources.stone;
    applyCommand(world, 0, { c: "build", unit: worker.id, building: "stone_wall", tile: spot });
    const wall = world.buildings.find((b) => b.type === "stone_wall");
    check("a stone-wall foundation is placed", !!wall);
    check("building it pays stone", p.resources.stone === stoneBefore - (SW.cost.stone ?? 0), `${stoneBefore} -> ${p.resources.stone}`);
    for (let i = 0; i < 120; i++) tick(world, fog);
    check("the worker finishes the stone wall", !!wall && wall.progress >= 1, `progress=${wall?.progress.toFixed(2)}`);
    check("a finished stone wall has full hp", !!wall && wall.hp === SW.hp, `hp=${wall?.hp}`);
  }
}

// ---- 4. upgraded walls are age-gated ---------------------------------------
{
  const world = createWorld(7, [FFA[0]]);
  const p = world.players[0]; // Dark Age (age 0)
  p.resources = { wood: 9999, food: 9999, gold: 9999, stone: 9999 };
  const spot = openSpot(world, "stone_wall")!;
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  worker.pos = { x: spot.x - 0.5, y: spot.y + 0.5 };
  applyCommand(world, 0, { c: "build", unit: worker.id, building: "stone_wall", tile: spot });
  check("a Dark-Age player cannot build a stone wall", !world.buildings.some((b) => b.type === "stone_wall"));
  check("the palisade is still available in the Dark Age", (BUILDING_DEFS.wall.minAge ?? 0) === 0);
}

// ---- 5. demolishing an upgraded wall refunds half its stone -----------------
{
  const world = createWorld(7, [FFA[0]]);
  const p = world.players[0];
  const wall = addBuilding(world, 0, "fortified_wall", 20, 20);
  p.resources = { wood: 0, food: 0, gold: 0, stone: 0 };
  applyCommand(world, 0, { c: "demolish", building: wall.id });
  check("demolishing a fortified wall is removed", !world.buildings.some((b) => b.id === wall.id));
  check(
    "demolish refunds half the stone",
    p.resources.stone === Math.floor((FW.cost.stone ?? 0) * 0.5),
    `stone=${p.resources.stone}`,
  );
}

console.log(pass ? "WALL-TIERS: PASS ✅" : "WALL-TIERS: FAIL ❌");
process.exit(pass ? 0 : 1);
