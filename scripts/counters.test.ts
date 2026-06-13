// Sim-level tests for combat counters (damageMultiplier): archers shred
// soldiers, soldiers counter archers, archers barely dent buildings. Drives the
// authoritative sim directly via tsx — deterministic, no network.
import {
  BUILDING_DEFS,
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  damageMultiplier,
  tick,
  type UnitType,
} from "@bg/shared";

const PS = [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
];

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

// ---- 1. the multiplier table itself ---------------------------------------
check("archer counters soldier (>1)", damageMultiplier("archer", "soldier") > 1);
check("soldier counters archer (>1)", damageMultiplier("soldier", "archer") > 1);
check("archer is weak vs buildings (<1)", damageMultiplier("archer", "building") < 1);
check("neutral matchup is 1x", damageMultiplier("soldier", "soldier") === 1);

// ---- 2. unit-vs-unit damage reflects the counter --------------------------
// Park `atk` adjacent to `def` and have it attack for a fixed window; measure hp lost.
function duel(atkType: UnitType, defType: UnitType, ticks = 30): number {
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const atk = world.units.find((u) => u.owner === 0)!;
  const def = world.units.find((u) => u.owner === 1)!;
  atk.type = atkType;
  atk.hp = UNIT_DEFS[atkType].hp;
  def.type = defType;
  def.hp = UNIT_DEFS[defType].hp;
  // Place the defender just inside the attacker's range so it fires immediately.
  atk.pos = { x: 12, y: 12 };
  def.pos = { x: 12 + UNIT_DEFS[atkType].range - 0.05, y: 12 };
  world.units = [atk, def];
  const hp0 = def.hp;
  applyCommand(world, 0, { c: "attack", units: [atk.id], target: def.id });
  for (let i = 0; i < ticks; i++) tick(world, fog);
  const d = world.units.find((u) => u.id === def.id);
  return hp0 - (d ? Math.max(0, d.hp) : 0);
}

// Same attacker (archer) hitting a soldier vs another archer: the soldier (with
// the 1.75x counter) should take more damage than the archer (1x), per attack.
const archerVsSoldier = duel("archer", "soldier");
const archerVsArcher = duel("archer", "archer");
check(
  "archer deals more to a soldier than to an archer",
  archerVsSoldier > archerVsArcher,
  `soldier=${archerVsSoldier} archer=${archerVsArcher}`,
);

// ---- 3. unit-vs-building damage reflects the counter -----------------------
// Place `atkType` next to a wall and measure damage dealt over a window.
function wallDamageBy(atkType: UnitType, ticks = 30): number {
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const atk = world.units.find((u) => u.owner === 0)!;
  atk.type = atkType;
  atk.hp = UNIT_DEFS[atkType].hp;
  atk.pos = { x: 21.3, y: 20.5 }; // within melee reach of the wall at (22,20) (dist ~0.7)
  world.units = [atk];
  const wall = {
    id: world.nextEntityId++,
    owner: 1,
    type: "wall" as const,
    tile: { x: 22, y: 20 },
    hp: BUILDING_DEFS.wall.hp,
    progress: 1,
    queue: [],
    produceTimer: 0,
    rally: null,
    research: null,
    researchTimer: 0,
    attackCooldown: 0,
  };
  world.buildings.push(wall);
  const hp0 = wall.hp;
  applyCommand(world, 0, { c: "attack", units: [atk.id], target: wall.id });
  for (let i = 0; i < ticks; i++) tick(world, fog);
  const w = world.buildings.find((b) => b.id === wall.id);
  return hp0 - (w ? Math.max(0, w.hp) : hp0);
}
const archerWall = wallDamageBy("archer");
check("archer barely dents a wall (counter < base)", archerWall > 0 && archerWall < archerVsArcher, `wall=${archerWall}`);

// ---- 4. the ram: demolishes buildings, near-useless vs units ---------------
const ramWall = wallDamageBy("ram");
const ramVsSoldier = duel("ram", "soldier");
check("ram demolishes walls far faster than an archer", ramWall > archerWall * 3, `ram=${ramWall} archer=${archerWall}`);
check("ram is near-useless against units", ramVsSoldier < ramWall, `unit=${ramVsSoldier} wall=${ramWall}`);
check("soldier counters the ram (>1)", damageMultiplier("soldier", "ram") > 1);

console.log(pass ? "COUNTERS: PASS ✅" : "COUNTERS: FAIL ❌");
process.exit(pass ? 0 : 1);
