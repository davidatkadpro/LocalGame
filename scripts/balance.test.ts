// Balance guardrails: lock in the *intended* combat ratios and eco baseline so
// future tuning (and the §7 roster) can't silently invert a relationship the
// design depends on. These assert design intent over pure functions — no sim
// loop — so they're fast and deterministic. Numbers may move; the orderings
// and multipliers encoded here are the contract.
import {
  BUILDING_DEFS,
  GATHER_PER_SEC,
  STARTING_RESOURCES,
  UNIT_DEFS,
  damageMultiplier,
  gatherRate,
  incomingDamage,
  unitDamage,
  type Player,
  type UnitType,
} from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

// Minimal players — the upgrade helpers only read `p.upgrades`.
const P = (...upgrades: string[]) => ({ upgrades }) as unknown as Player;
const noUp = P();

// Per-hit damage an attacker deals to a target category (incl. counters).
const perHit = (atk: UnitType, tgt: UnitType | "building", ap: Player = noUp) =>
  unitDamage(ap, atk) * damageMultiplier(atk, tgt);
// Sustained DPS (per-hit / cooldown).
const dps = (atk: UnitType, tgt: UnitType | "building", ap: Player = noUp) =>
  perHit(atk, tgt, ap) / (UNIT_DEFS[atk].attackMs / 1000);
// Melee time-to-kill: target hp / attacker dps against it.
const ttk = (atk: UnitType, tgt: UnitType) => UNIT_DEFS[tgt].hp / dps(atk, tgt);

// ---- 1. economy baseline ---------------------------------------------------
check("base gather rate is the constant", gatherRate(noUp) === GATHER_PER_SEC, `${gatherRate(noUp)}`);
check(
  "Improved Tools gives +50% gathering",
  gatherRate(P("improvedTools")) === GATHER_PER_SEC * 1.5,
  `${gatherRate(P("improvedTools"))}`,
);
check(
  "opening affords a first house",
  STARTING_RESOURCES.wood >= (BUILDING_DEFS.house.cost.wood ?? 0),
);
check(
  "opening affords a worker",
  STARTING_RESOURCES.food >= (UNIT_DEFS.worker.cost.food ?? 0),
);

// ---- 2. counters: archers > soldiers at range, soldiers > archers in melee --
check("archers get an anti-soldier bonus", damageMultiplier("archer", "soldier") > 1);
check("soldiers get an anti-archer bonus", damageMultiplier("soldier", "archer") > 1);
check(
  "a soldier out-DPSes an archer in a melee trade",
  dps("soldier", "archer") > dps("archer", "soldier"),
  `soldier=${dps("soldier", "archer").toFixed(1)} archer=${dps("archer", "soldier").toFixed(1)}`,
);
check(
  "a soldier kills an archer faster than the reverse (melee)",
  ttk("soldier", "archer") < ttk("archer", "soldier"),
  `s→a=${ttk("soldier", "archer").toFixed(1)}s a→s=${ttk("archer", "soldier").toFixed(1)}s`,
);

// ---- 3. siege identity: rams wreck buildings, whiff on units ----------------
check("ram has a heavy anti-building multiplier", damageMultiplier("ram", "building") >= 5);
check(
  "no unit out-sieges a ram per hit",
  perHit("ram", "building") > perHit("soldier", "building") &&
    perHit("ram", "building") > perHit("archer", "building"),
  `ram=${perHit("ram", "building")} sol=${perHit("soldier", "building")} arc=${perHit("archer", "building")}`,
);
check("a ram is near-useless against units", damageMultiplier("ram", "soldier") < 0.5);
check(
  "a soldier beats a ram (escort needed)",
  dps("soldier", "ram") > dps("ram", "soldier"),
);
check("archers barely dent buildings", damageMultiplier("archer", "building") < 1);

// ---- 4. tower nerf invariants (see constants §2.1) -------------------------
const tower = BUILDING_DEFS.tower.attack!;
const towerDps = tower.damage / (tower.attackMs / 1000);
check(
  "a tower does not out-DPS a frontline soldier",
  towerDps <= dps("soldier", "soldier"),
  `tower=${towerDps} soldier=${dps("soldier", "soldier")}`,
);
check(
  "massed archers can trade with a tower (not out-ranged)",
  UNIT_DEFS.archer.range >= tower.range,
  `archer=${UNIT_DEFS.archer.range} tower=${tower.range}`,
);

// ---- 5. upgrades: military-only, correct magnitudes ------------------------
check(
  "Sharpened Blades = +25% military damage",
  unitDamage(P("sharpenedBlades"), "soldier") === UNIT_DEFS.soldier.damage * 1.25,
);
check(
  "Padded Armor = -25% military damage taken",
  incomingDamage(P("paddedArmor"), "soldier", 100) === 75,
);
check(
  "upgrades don't touch workers (non-military)",
  unitDamage(P("sharpenedBlades"), "worker") === UNIT_DEFS.worker.damage &&
    incomingDamage(P("paddedArmor"), "worker", 100) === 100,
);

// ---- 6. pacing: a pop-enabler shouldn't take longer than a drop-off --------
check(
  "house builds no slower than a storehouse (pop curve)",
  BUILDING_DEFS.house.buildMs <= BUILDING_DEFS.storehouse.buildMs,
  `house=${BUILDING_DEFS.house.buildMs} store=${BUILDING_DEFS.storehouse.buildMs}`,
);

console.log(pass ? "BALANCE: PASS ✅" : "BALANCE: FAIL ❌");
process.exit(pass ? 0 : 1);
