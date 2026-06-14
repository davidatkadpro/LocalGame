// Ages (Dark -> Feudal -> Imperial): tiered unlocks gate the existing roster,
// advancing needs a prerequisite building + resources + time, and each age
// applies balanced eco/military/pop bonuses. Drives the sim directly.
import {
  AGE_DEFS,
  AGE_POP_BONUS,
  BUILDING_DEFS,
  applyCommand,
  createFog,
  createWorld,
  gatherRate,
  incomingDamage,
  minAgeOfBuilding,
  minAgeOfUnit,
  minAgeOfUpgrade,
  placementValid,
  tick,
  unitDamage,
  type Building,
  type BuildingType,
  type Player,
} from "@bg/shared";

const PS = [{ name: "A", color: "#ffffff" }];

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

type World = ReturnType<typeof createWorld>;
const rich = (p: Player) => (p.resources = { wood: 9999, food: 9999, gold: 9999 });
function addBuilding(world: World, owner: number, type: BuildingType, x: number, y: number): Building {
  const b: Building = {
    id: world.nextEntityId++,
    owner,
    type,
    tile: { x, y },
    hp: BUILDING_DEFS[type].hp,
    progress: 1,
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
function openSpot(world: World, type: BuildingType): { x: number; y: number } | null {
  for (let y = 2; y < world.map.height - 3; y++)
    for (let x = 2; x < world.map.width - 3; x++)
      if (placementValid(world, type, { x, y })) return { x, y };
  return null;
}

// ---- 1. minAge tagging --------------------------------------------------
check("worker + house are Dark-Age", minAgeOfUnit("worker") === 0 && minAgeOfBuilding("house") === 0);
check("soldier/archer + barracks/tower are Feudal", minAgeOfUnit("soldier") === 1 && minAgeOfBuilding("barracks") === 1 && minAgeOfBuilding("tower") === 1);
check("ram + siege workshop are Imperial", minAgeOfUnit("ram") === 2 && minAgeOfBuilding("siege_workshop") === 2);
check("Sharpened Blades is Feudal-gated", minAgeOfUpgrade("sharpenedBlades") === 1);
check(
  "age names",
  AGE_DEFS[0].name === "Dark Age" && AGE_DEFS[1].name === "Feudal Age" && AGE_DEFS[2].name === "Imperial Age",
);

// ---- 2. build gate: no military buildings in the Dark Age ----------------
{
  const world = createWorld(7, PS);
  rich(world.players[0]);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  const bspot = openSpot(world, "barracks")!;
  applyCommand(world, 0, { c: "build", unit: worker.id, building: "barracks", tile: bspot });
  check("Dark Age blocks a barracks", !world.buildings.some((b) => b.type === "barracks"));

  const hspot = openSpot(world, "house")!;
  applyCommand(world, 0, { c: "build", unit: worker.id, building: "house", tile: hspot });
  check("Dark Age still allows a house", world.buildings.some((b) => b.type === "house"));

  world.players[0].age = 1; // Feudal
  const bspot2 = openSpot(world, "barracks")!;
  applyCommand(world, 0, { c: "build", unit: worker.id, building: "barracks", tile: bspot2 });
  check("Feudal allows a barracks", world.buildings.some((b) => b.type === "barracks"));
}

// ---- 3. train + research gates respect the age ---------------------------
{
  const world = createWorld(7, PS);
  const p = world.players[0];
  rich(p);
  const bar = addBuilding(world, 0, "barracks", 1, 1);

  applyCommand(world, 0, { c: "train", building: bar.id, unit: "soldier" });
  check("Dark Age blocks training a soldier", bar.queue.length === 0);
  applyCommand(world, 0, { c: "research", building: bar.id, upgrade: "sharpenedBlades" });
  check("Dark Age blocks Sharpened Blades", bar.research === null);

  p.age = 1; // Feudal
  applyCommand(world, 0, { c: "train", building: bar.id, unit: "soldier" });
  check("Feudal allows training a soldier", bar.queue.length === 1 && bar.queue[0] === "soldier");
  applyCommand(world, 0, { c: "research", building: bar.id, upgrade: "sharpenedBlades" });
  check("Feudal allows Sharpened Blades", bar.research === "sharpenedBlades");

  // ram still gated to Imperial even with a (hypothetical) workshop at Feudal
  const ws = addBuilding(world, 0, "siege_workshop", 4, 4);
  applyCommand(world, 0, { c: "train", building: ws.id, unit: "ram" });
  check("Feudal still blocks a ram (Imperial)", ws.queue.length === 0);
  p.age = 2;
  applyCommand(world, 0, { c: "train", building: ws.id, unit: "ram" });
  check("Imperial allows a ram", ws.queue.length === 1 && ws.queue[0] === "ram");
}

// ---- 4. advancing: prereq + cost + timed, then the age bumps -------------
{
  const world = createWorld(7, PS);
  const p = world.players[0];
  const tc = world.buildings.find((b) => b.owner === 0 && b.type === "town_center")!;

  rich(p);
  applyCommand(world, 0, { c: "advanceAge", building: tc.id });
  check("advance blocked without a prereq building", p.ageUpTimer === 0 && p.age === 0);

  addBuilding(world, 0, "storehouse", 1, 1); // Feudal prereq: an economy building
  p.resources = { wood: 0, food: 0, gold: 0 };
  applyCommand(world, 0, { c: "advanceAge", building: tc.id });
  check("advance blocked when unaffordable", p.ageUpTimer === 0);

  p.resources = { wood: 0, food: 1000, gold: 1000 };
  const foodBefore = p.resources.food;
  applyCommand(world, 0, { c: "advanceAge", building: tc.id });
  check("advance starts (timer set)", p.ageUpTimer === AGE_DEFS[1].advanceMs);
  check("advance pays its cost", p.resources.food === foodBefore - (AGE_DEFS[1].advanceCost.food ?? 0));

  const timerNow = p.ageUpTimer;
  const foodNow = p.resources.food;
  applyCommand(world, 0, { c: "advanceAge", building: tc.id });
  check("can't stack a second advance", p.ageUpTimer === timerNow && p.resources.food === foodNow);

  const fog = createFog(world);
  const ticks = Math.ceil(AGE_DEFS[1].advanceMs / 100) + 2;
  for (let i = 0; i < ticks; i++) tick(world, fog);
  check("advance completes -> Feudal Age", p.age === 1 && p.ageUpTimer === 0);
}

// ---- 5. balanced per-age bonuses ----------------------------------------
{
  const P = (age: number) => ({ upgrades: [], age }) as unknown as Player;
  const a0 = P(0);
  const a1 = P(1);
  const a2 = P(2);
  check(
    "gather rate rises each age",
    gatherRate(a1) > gatherRate(a0) && gatherRate(a2) > gatherRate(a1),
    `${gatherRate(a0)} < ${gatherRate(a1)} < ${gatherRate(a2)}`,
  );
  check("military damage rises with age", unitDamage(a1, "soldier") > unitDamage(a0, "soldier"));
  check("worker damage is age-independent", unitDamage(a2, "worker") === unitDamage(a0, "worker"));
  check(
    "military takes less damage at higher age",
    incomingDamage(a1, "soldier", 100) < 100 && incomingDamage(a2, "soldier", 100) < incomingDamage(a1, "soldier", 100),
  );
}

// ---- 6. age raises the pop cap ------------------------------------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  tick(world, fog);
  const cap0 = world.players[0].popCap;
  world.players[0].age = 2;
  tick(world, fog);
  const cap2 = world.players[0].popCap;
  check("Imperial raises the pop cap by its bonus", cap2 - cap0 === AGE_POP_BONUS[2], `cap0=${cap0} cap2=${cap2}`);
}

console.log(pass ? "AGES: PASS ✅" : "AGES: FAIL ❌");
process.exit(pass ? 0 : 1);
