// §7.6 Gates: a gate is a wall-line door — solid to enemies (and neutral
// wildlife) but passable to its owner's team once built. Drives the sim
// directly (no network). The auto-connecting wall *graphics* are client-only
// and not covered here.
import {
  BUILDING_DEFS,
  applyCommand,
  createFog,
  createWorld,
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

// Push a fully-built (or partially-built) building straight into the world.
function addBuilding(
  world: World,
  owner: number,
  type: BuildingType,
  x: number,
  y: number,
  progress = 1,
): Building {
  const b: Building = {
    id: world.nextEntityId++,
    owner,
    type,
    tile: { x, y },
    hp: BUILDING_DEFS[type].hp,
    progress,
    queue: [],
    produceTimer: 0,
    rally: null,
    research: null,
    researchTimer: 0,
    attackCooldown: 0,
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

// A 5×5 patch of clear, buildable tiles, for the pathing barrier.
function clearBlock(world: World): { x: number; y: number } | null {
  for (let y = 3; y < world.map.height - 4; y++)
    for (let x = 3; x < world.map.width - 4; x++) {
      let ok = true;
      for (let dy = -2; dy <= 2 && ok; dy++)
        for (let dx = -2; dx <= 2 && ok; dx++)
          if (!placementValid(world, "wall", { x: x + dx, y: y + dy })) ok = false;
      if (ok) return { x, y };
    }
  return null;
}

const FFA = [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
];

// ---- 1. gate definition --------------------------------------------------
{
  const g = BUILDING_DEFS.gate;
  check("gate is defined", !!g);
  check("gate is 1×1", g.size.w === 1 && g.size.h === 1);
  check("gate has hp", g.hp > 0, `${g.hp}`);
  check("gate is sturdier than a wall", g.hp >= BUILDING_DEFS.wall.hp);
  check("gate is buildable", g.buildable === true);
  check("gate is Dark-Age (like walls)", (g.minAge ?? 0) === 0);
}

// ---- 2. a wall blocks everyone (owner included) --------------------------
{
  const world = createWorld(7, FFA);
  const spot = openSpot(world, "wall");
  if (!spot) {
    console.log("GATES §2: SKIP (no open tile on seed)");
  } else {
    addBuilding(world, 0, "wall", spot.x, spot.y);
    check("a wall blocks its owner", tileBlockedFor(world, spot.x, spot.y, 0));
    check("a wall blocks an enemy", tileBlockedFor(world, spot.x, spot.y, 1));
    check("a wall blocks neutral wildlife", tileBlockedFor(world, spot.x, spot.y, undefined));
  }
}

// ---- 3. a built gate: owner passes, enemy + wildlife are blocked ----------
{
  const world = createWorld(7, FFA);
  const spot = openSpot(world, "gate");
  if (!spot) {
    console.log("GATES §3: SKIP (no open tile on seed)");
  } else {
    addBuilding(world, 0, "gate", spot.x, spot.y); // owner 0, built
    check("a built gate is open to its owner", !tileBlockedFor(world, spot.x, spot.y, 0));
    check("a built gate blocks an enemy", tileBlockedFor(world, spot.x, spot.y, 1));
    check("a built gate blocks neutral wildlife", tileBlockedFor(world, spot.x, spot.y, undefined));
  }
}

// ---- 4. an unfinished gate blocks everyone (you must finish it first) -----
{
  const world = createWorld(7, FFA);
  const spot = openSpot(world, "gate");
  if (!spot) {
    console.log("GATES §4: SKIP (no open tile on seed)");
  } else {
    addBuilding(world, 0, "gate", spot.x, spot.y, 0.5); // owner 0, under construction
    check("an unfinished gate blocks its own owner", tileBlockedFor(world, spot.x, spot.y, 0));
    check("an unfinished gate blocks an enemy", tileBlockedFor(world, spot.x, spot.y, 1));
  }
}

// ---- 5. allies share gate passage ----------------------------------------
{
  // players 0 & 1 are team 0 (allies); player 2 is team 1 (enemy)
  const world = createWorld(7, [
    { name: "A", color: "#fff", team: 0 },
    { name: "B", color: "#aaa", team: 0 },
    { name: "C", color: "#000", team: 1 },
  ]);
  const spot = openSpot(world, "gate");
  if (!spot) {
    console.log("GATES §5: SKIP (no open tile on seed)");
  } else {
    addBuilding(world, 0, "gate", spot.x, spot.y); // owned by player 0
    check("an ally passes a teammate's gate", !tileBlockedFor(world, spot.x, spot.y, 1));
    check("an enemy is still blocked by it", tileBlockedFor(world, spot.x, spot.y, 2));
  }
}

// ---- 6. pathing: friendly routes through the gate, enemy detours around ---
// Build a 5-tall wall barrier with a one-tile gate gap, in two identical
// worlds (so the friendly and enemy don't collide). findPath returns every
// tile-center, so we can assert the gate tile is/ isn't on each path.
function barrier(world: World, c: { x: number; y: number }) {
  for (let dy = -2; dy <= 2; dy++) {
    if (dy === 0) addBuilding(world, 0, "gate", c.x, c.y); // owner 0's gate in the gap
    else addBuilding(world, 0, "wall", c.x, c.y + dy);
  }
}
const onGate = (path: { x: number; y: number }[], c: { x: number; y: number }) =>
  path.some((p) => Math.floor(p.x) === c.x && Math.floor(p.y) === c.y);
{
  const probe = createWorld(7, FFA);
  const c = clearBlock(probe);
  if (!c) {
    console.log("GATES §6: SKIP (no clear 5×5 region on seed)");
  } else {
    // friendly (owner 0) — should route straight through its own gate
    const fw = createWorld(7, FFA);
    barrier(fw, c);
    const ffog = createFog(fw);
    const fr = fw.units.find((u) => u.owner === 0 && u.type === "worker")!;
    fr.pos = { x: c.x - 1.5, y: c.y + 0.5 };
    fr.state = "idle";
    fr.path = [];
    applyCommand(fw, 0, { c: "move", units: [fr.id], tile: { x: c.x + 2, y: c.y } });
    check("friendly path routes through the gate tile", onGate(fr.path, c), `${fr.path.length} waypoints`);
    for (let i = 0; i < 100; i++) tick(fw, ffog);
    check("friendly walks through the gate to the far side", fr.pos.x > c.x + 0.5, `x=${fr.pos.x.toFixed(2)}`);

    // enemy (owner 1) — the gate is solid, so the path must detour around it
    const ew = createWorld(7, FFA);
    barrier(ew, c);
    const en = ew.units.find((u) => u.owner === 1 && u.type === "worker")!;
    en.pos = { x: c.x - 1.5, y: c.y + 0.5 };
    en.state = "idle";
    en.path = [];
    applyCommand(ew, 1, { c: "move", units: [en.id], tile: { x: c.x + 2, y: c.y } });
    check("enemy path never enters the gate tile", !onGate(en.path, c));
    check("enemy still gets a (detour) path", en.path.length > 0, `${en.path.length} waypoints`);
  }
}

console.log(pass ? "GATES: PASS ✅" : "GATES: FAIL ❌");
process.exit(pass ? 0 : 1);
