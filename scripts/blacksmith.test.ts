// §7.3 Blacksmith + tiered tech tree: three upgrade lines (attack / armor /
// gather), each researched in order (tier N requires N-1). Tier I keeps the
// original magnitudes; II/III deepen them. Combat tiers live at the Blacksmith,
// eco tiers at the Town Center. Drives the sim directly — no network.
import {
  BUILDING_DEFS,
  GATHER_PER_SEC,
  UNIT_DEFS,
  UPGRADE_DEFS,
  applyCommand,
  createWorld,
  gatherRate,
  incomingDamage,
  unitDamage,
  type Building,
  type Player,
  type World,
} from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

const P = (...upgrades: string[]) => ({ upgrades, age: 0 }) as unknown as Player;
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// ---- 1. the new tiered upgrades exist and chain via `requires` --------------
const TIERS: [string, string][] = [
  ["temperedBlades", "sharpenedBlades"],
  ["honedBlades", "temperedBlades"],
  ["leatherArmor", "paddedArmor"],
  ["plateArmor", "leatherArmor"],
  ["fineTools", "improvedTools"],
  ["masterTools", "fineTools"],
];
for (const [id, req] of TIERS) {
  const u = UPGRADE_DEFS[id as keyof typeof UPGRADE_DEFS];
  check(`${id} is defined`, !!u);
  check(`${id} requires ${req}`, u?.requires === req, `${u?.requires}`);
}
check("tier-I upgrades have no prerequisite", !UPGRADE_DEFS.sharpenedBlades.requires && !UPGRADE_DEFS.improvedTools.requires);

// ---- 2. the Blacksmith hosts the upper combat tiers ------------------------
{
  const b = BUILDING_DEFS.blacksmith;
  check("blacksmith is defined & buildable", !!b && b.buildable);
  check("blacksmith is Feudal", (b.minAge ?? 0) === 1);
  check(
    "blacksmith hosts attack II/III + armor II/III",
    JSON.stringify(b.research) === JSON.stringify(["temperedBlades", "honedBlades", "leatherArmor", "plateArmor"]),
  );
  check("eco tiers live at the Town Center", UPGRADE_DEFS.fineTools.building === "town_center" && UPGRADE_DEFS.masterTools.building === "town_center");
  check("attack/armor tier I stay at the barracks", UPGRADE_DEFS.sharpenedBlades.building === "barracks" && UPGRADE_DEFS.paddedArmor.building === "barracks");
}

// ---- 3. effective stats apply the highest owned tier in a line -------------
const base = UNIT_DEFS.soldier.damage;
check("no upgrades → base damage", approx(unitDamage(P(), "soldier"), base));
check("tier I (sharpened) = +25%", approx(unitDamage(P("sharpenedBlades"), "soldier"), base * 1.25), `${unitDamage(P("sharpenedBlades"), "soldier")}`);
check("tier II (tempered) = +45%", approx(unitDamage(P("sharpenedBlades", "temperedBlades"), "soldier"), base * 1.45));
check("tier III (honed) = +65%", approx(unitDamage(P("sharpenedBlades", "temperedBlades", "honedBlades"), "soldier"), base * 1.65));
check("a line never stacks (II alone == II)", approx(unitDamage(P("temperedBlades"), "soldier"), base * 1.45));

check("armor tier I = −25%", incomingDamage(P("paddedArmor"), "soldier", 100) === 75);
check("armor tier II (leather) = −38%", approx(incomingDamage(P("paddedArmor", "leatherArmor"), "soldier", 100), 62));
check("armor tier III (plate) = −50%", approx(incomingDamage(P("paddedArmor", "leatherArmor", "plateArmor"), "soldier", 100), 50));

check("gather tier I (improved) = +50%", approx(gatherRate(P("improvedTools")), GATHER_PER_SEC * 1.5));
check("gather tier II (fine) = +75%", approx(gatherRate(P("improvedTools", "fineTools")), GATHER_PER_SEC * 1.75));
check("gather tier III (master) = +100%", approx(gatherRate(P("improvedTools", "fineTools", "masterTools")), GATHER_PER_SEC * 2.0));
check("upgrades still don't touch workers", approx(unitDamage(P("honedBlades"), "worker"), UNIT_DEFS.worker.damage));

// ---- 4. research enforces the tier prerequisite ----------------------------
function addBuilding(world: World, owner: number, type: "blacksmith", x: number, y: number): Building {
  const b: Building = {
    id: world.nextEntityId++, owner, type, tile: { x, y },
    hp: BUILDING_DEFS[type].hp, progress: 1, queue: [], produceTimer: 0,
    rally: null, research: null, researchTimer: 0, attackCooldown: 0,
  };
  world.buildings.push(b);
  return b;
}
{
  const world = createWorld(7, [{ name: "A", color: "#fff" }]);
  const p = world.players[0];
  p.age = 1; // Feudal
  p.resources = { wood: 9999, food: 9999, gold: 9999, stone: 9999 };
  const bs = addBuilding(world, 0, "blacksmith", 20, 20);

  // Tempered Blades needs Sharpened Blades first.
  applyCommand(world, 0, { c: "research", building: bs.id, upgrade: "temperedBlades" });
  check("tier II is refused without tier I", bs.research === null);

  // Grant tier I, then tier II is accepted.
  p.upgrades.push("sharpenedBlades");
  applyCommand(world, 0, { c: "research", building: bs.id, upgrade: "temperedBlades" });
  check("tier II is accepted once tier I is owned", bs.research === "temperedBlades");

  // Honed Blades is Imperial-gated even with Tempered owned.
  const world2 = createWorld(7, [{ name: "A", color: "#fff" }]);
  const p2 = world2.players[0];
  p2.age = 1; // still Feudal
  p2.resources = { wood: 9999, food: 9999, gold: 9999, stone: 9999 };
  p2.upgrades.push("sharpenedBlades", "temperedBlades");
  const bs2 = addBuilding(world2, 0, "blacksmith", 22, 22);
  applyCommand(world2, 0, { c: "research", building: bs2.id, upgrade: "honedBlades" });
  check("tier III is age-gated to Imperial", bs2.research === null);
}

console.log(pass ? "BLACKSMITH: PASS ✅" : "BLACKSMITH: FAIL ❌");
process.exit(pass ? 0 : 1);
