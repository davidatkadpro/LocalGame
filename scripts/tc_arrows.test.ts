// §7.5a Town Center fires arrows: the TC gets a tower-style auto-attack so a
// walled base bites back against raids. Pure sim — the `tickTowers` loop already
// fires *any* building with an `attack` def, so this just exercises the new
// town_center def. The arrow *visual* is client-only (not covered here), and
// garrison-boosted arrows (§7.5b) are deferred.
import {
  BUILDING_DEFS,
  UNIT_DEFS,
  createFog,
  createWorld,
  tick,
  type Building,
  type BuildingType,
  type Unit,
  type UnitType,
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

// Clone the full Unit shape from a spawned starting unit, then override only the
// fields we control. Keeps the test robust to the Unit shape growing (extra
// timers etc. come along via the spread) and lets us pin owner/pos exactly.
function placeUnit(
  world: World,
  template: Unit,
  owner: number,
  type: UnitType,
  x: number,
  y: number,
): Unit {
  const u: Unit = {
    ...template,
    id: world.nextEntityId++,
    owner,
    type,
    pos: { x, y },
    hp: UNIT_DEFS[type].hp,
    state: "idle",
    path: [],
    carry: null,
    targetEntity: null,
    targetTile: null,
    attackCooldown: 0,
    stuck: 0,
    repaths: 0,
    aggro: null,
    attackedBy: null,
  };
  world.units.push(u);
  return u;
}

const FFA = [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
];

const WORKER_HP = UNIT_DEFS.worker.hp;

// A TC placed at map centre (room on every side) for a two-player FFA world.
// Starting units spawn at the edges and sit idle, far outside the TC's range,
// so they never interfere with what we place at the centre.
function tcWorld(progress = 1) {
  const world = createWorld(7, FFA);
  const template = world.units[0]; // clone source for placeUnit
  const cx = Math.floor(world.map.width / 2);
  const cy = Math.floor(world.map.height / 2);
  const tc = addBuilding(world, 0, "town_center", cx, cy, progress);
  return { world, fog: createFog(world), tc, cx, cy, template };
}

// ---- 1. the TC has a tower-style auto-attack ------------------------------
{
  const atk = BUILDING_DEFS.town_center.attack;
  check("town_center has an attack def", !!atk);
  if (atk) {
    check("TC attack has positive damage", atk.damage > 0, `${atk.damage}`);
    check("TC attack has positive range", atk.range > 0, `${atk.range}`);
    check("TC attack has a cooldown", atk.attackMs > 0, `${atk.attackMs}`);
    // Out-ranges archers so a lone archer can't safely snipe villagers under it.
    check(
      "TC out-ranges archers",
      atk.range > UNIT_DEFS.archer.range,
      `${atk.range} vs ${UNIT_DEFS.archer.range}`,
    );
  }
}

// ---- 2. a built TC shoots an enemy unit in range --------------------------
{
  const { world, fog, cx, cy, template } = tcWorld();
  const foe = placeUnit(world, template, 1, "worker", cx - 0.5, cy + 1.5);
  for (let i = 0; i < 20; i++) tick(world, fog);
  check("TC damages an enemy in range", foe.hp < WORKER_HP, `hp=${foe.hp}`);
}

// ---- 3. a built TC spares its owner's own units ---------------------------
{
  const { world, fog, cx, cy, template } = tcWorld();
  const friend = placeUnit(world, template, 0, "worker", cx - 0.5, cy + 1.5);
  // A far, out-of-range enemy keeps owner 1 in the game (no early defeat) and
  // proves the TC skips a same-owner unit even when it's the nearest one.
  placeUnit(world, template, 1, "worker", cx + 12.5, cy + 1.5);
  for (let i = 0; i < 20; i++) tick(world, fog);
  check("TC does not shoot its owner's unit", friend.hp === WORKER_HP, `hp=${friend.hp}`);
}

// ---- 4. allies are spared; only true (cross-team) enemies are hit ----------
{
  // team 0 = players 0 & 1 (allies); player 2 = team 1 (enemy)
  const world = createWorld(7, [
    { name: "A", color: "#fff", team: 0 },
    { name: "B", color: "#aaa", team: 0 },
    { name: "C", color: "#000", team: 1 },
  ]);
  const template = world.units[0];
  const cx = Math.floor(world.map.width / 2);
  const cy = Math.floor(world.map.height / 2);
  addBuilding(world, 0, "town_center", cx, cy);
  const fog = createFog(world);
  const ally = placeUnit(world, template, 1, "worker", cx - 0.5, cy + 1.5); // teammate, in range
  const enemy = placeUnit(world, template, 2, "worker", cx + 3.5, cy + 1.5); // enemy, in range
  for (let i = 0; i < 20; i++) tick(world, fog);
  check("TC spares an allied unit", ally.hp === WORKER_HP, `hp=${ally.hp}`);
  check("TC shoots a cross-team enemy", enemy.hp < WORKER_HP, `hp=${enemy.hp}`);
}

// ---- 5. an enemy outside range is untouched -------------------------------
{
  const { world, fog, cx, cy, template } = tcWorld();
  const foe = placeUnit(world, template, 1, "worker", cx + 11.5, cy + 1.5); // ~8 tiles past the footprint
  for (let i = 0; i < 20; i++) tick(world, fog);
  check("TC does not reach an out-of-range enemy", foe.hp === WORKER_HP, `hp=${foe.hp}`);
}

// ---- 6. a TC under construction does not fire -----------------------------
{
  const { world, fog, cx, cy, template } = tcWorld(0.5);
  const foe = placeUnit(world, template, 1, "worker", cx - 0.5, cy + 1.5);
  for (let i = 0; i < 20; i++) tick(world, fog);
  check("an unfinished TC does not fire", foe.hp === WORKER_HP, `hp=${foe.hp}`);
}

console.log(pass ? "TC-ARROWS: PASS ✅" : "TC-ARROWS: FAIL ❌");
process.exit(pass ? 0 : 1);
