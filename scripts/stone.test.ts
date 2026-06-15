// §7.4 Stone — a 4th resource for defence (towers/fortifications). Covers the
// data plumbing (starting/empty resources, costs, node amount, camp bonus) and
// the in-sim loop (a worker mines a stone node and deposits it). Drives the sim
// directly — no network.
import {
  BUILDING_DEFS,
  RESOURCE_NODE_AMOUNT,
  STARTING_RESOURCES,
  applyCommand,
  campBonusFor,
  canAfford,
  createFog,
  createWorld,
  emptyResources,
  payCost,
  tick,
} from "@bg/shared";

const PS = [{ name: "A", color: "#ffffff" }];

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

// ---- 1. resource plumbing --------------------------------------------------
check("emptyResources includes stone", emptyResources().stone === 0);
check("starting resources include stone", STARTING_RESOURCES.stone > 0, `${STARTING_RESOURCES.stone}`);
check("stone nodes carry an amount", RESOURCE_NODE_AMOUNT.stone > 0, `${RESOURCE_NODE_AMOUNT.stone}`);

// canAfford / payCost honour stone.
{
  const have = { wood: 0, food: 0, gold: 0, stone: 50 };
  check("canAfford passes when stone suffices", canAfford(have, { stone: 50 }));
  check("canAfford fails when stone is short", !canAfford(have, { stone: 51 }));
  payCost(have, { stone: 30 });
  check("payCost deducts stone", have.stone === 20, `${have.stone}`);
}

// ---- 2. stone is the defensive sink; gold funds units & tech ----------------
check("towers cost stone", (BUILDING_DEFS.tower.cost.stone ?? 0) > 0, `${BUILDING_DEFS.tower.cost.stone}`);
check("towers no longer cost gold", !BUILDING_DEFS.tower.cost.gold);
check("soldiers still cost gold (not stone)", !BUILDING_DEFS.barracks.cost.stone);

// ---- 3. the Mining Camp is the stone (and gold) drop-off --------------------
check("mining camp boosts stone gathering", campBonusFor("mining_camp", "stone") > 1);
check("mining camp still boosts gold", campBonusFor("mining_camp", "gold") > 1);
check("lumber camp does NOT boost stone", campBonusFor("lumber_camp", "stone") === 1);

// ---- 4. map generates stone nodes ------------------------------------------
{
  const counts = [3, 7, 11, 42].map((seed) => {
    const w = createWorld(seed, PS);
    return w.resourceNodes.filter((n) => n.kind === "stone").length;
  });
  check("every generated map has stone nodes", counts.every((c) => c > 0), `counts=${counts.join(",")}`);
}

// ---- 5. a worker mines stone and deposits it -------------------------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const tc = world.buildings.find((b) => b.owner === 0 && b.type === "town_center")!;
  const tcCenter = { x: tc.tile.x + 1.5, y: tc.tile.y + 1.5 };
  // nearest stone node to the town center (its drop-off is the TC)
  let node = world.resourceNodes.find((n) => n.kind === "stone") ?? null;
  let best = Infinity;
  for (const n of world.resourceNodes) {
    if (n.kind !== "stone") continue;
    const d = Math.hypot(n.tile.x - tcCenter.x, n.tile.y - tcCenter.y);
    if (d < best) { best = d; node = n; }
  }
  if (!node) {
    console.log("STONE-GATHER: SKIP (no stone node on seed 7)");
  } else {
    const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
    worker.pos = { x: node.tile.x + 0.5, y: node.tile.y + 0.5 }; // sit on the node
    world.units = [worker];
    const before = world.players[0].resources.stone;
    applyCommand(world, 0, { c: "gather", units: [worker.id], node: node.id });
    for (let i = 0; i < 300; i++) tick(world, fog); // a full gather -> deposit cycle
    check(
      "a worker mines stone and deposits it at a drop-off",
      world.players[0].resources.stone > before,
      `stone ${before} -> ${world.players[0].resources.stone}`,
    );
  }
}

// ---- 6. repairing a stone-costing building charges stone -------------------
// A tower costs stone to build, so repairing it must also cost stone (not just
// wood). Place a damaged tower, send a worker to repair, assert stone dropped.
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const def = BUILDING_DEFS.tower;
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // A clear-ish spot away from the TC for the tower; sit the worker beside it.
  const tx = Math.floor(worker.pos.x) + 2;
  const ty = Math.floor(worker.pos.y);
  const tower = {
    id: world.nextEntityId++,
    owner: 0,
    type: "tower" as const,
    tile: { x: tx, y: ty },
    hp: Math.floor(def.hp * 0.4), // damaged
    progress: 1,
    queue: [],
    produceTimer: 0,
    rally: null,
    research: null,
    researchTimer: 0,
    attackCooldown: 0,
  };
  world.buildings.push(tower);
  worker.pos = { x: tx - 1, y: ty + 0.5 }; // adjacent to the footprint
  world.units = [worker];
  // Give the player ample resources so only the repair spend is measured.
  world.players[0].resources = { wood: 1000, food: 1000, gold: 1000, stone: 1000 };
  const beforeStone = world.players[0].resources.stone;
  applyCommand(world, 0, { c: "construct", units: [worker.id], building: tower.id });
  for (let i = 0; i < 120; i++) tick(world, fog);
  check(
    "repairing a tower consumes stone",
    world.players[0].resources.stone < beforeStone,
    `stone ${beforeStone} -> ${world.players[0].resources.stone}`,
  );
  check("the tower actually healed", tower.hp > Math.floor(def.hp * 0.4), `hp=${tower.hp}`);
}

console.log(pass ? "STONE: PASS ✅" : "STONE: FAIL ❌");
process.exit(pass ? 0 : 1);
