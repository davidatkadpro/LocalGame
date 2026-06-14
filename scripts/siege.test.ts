// §7.7 Siege expansion: a mangonel (area splash vs unit clumps — the anti-
// archer-ball role) and a trebuchet (very long range, devastating anti-
// building, helpless in melee). Both train at the siege workshop. Drives the
// sim directly — no network.
import {
  BUILDING_DEFS,
  MILITARY,
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  damageMultiplier,
  tick,
  unitDamage,
  type Player,
  type Unit,
} from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}
const noUp = { upgrades: [], age: 0 } as unknown as Player;
const perHitVsBuilding = (t: "ram" | "trebuchet" | "mangonel") =>
  unitDamage(noUp, t) * damageMultiplier(t, "building");

// ---- 1. unit defs + roster wiring ------------------------------------------
const M = UNIT_DEFS.mangonel;
const T = UNIT_DEFS.trebuchet;
check("mangonel & trebuchet are defined", !!M && !!T);
check("both train at the siege workshop", M.trainedAt === "siege_workshop" && T.trainedAt === "siege_workshop");
check("the siege workshop can train all three engines", JSON.stringify(BUILDING_DEFS.siege_workshop.canTrain) === JSON.stringify(["ram", "mangonel", "trebuchet"]));
check("both are Imperial-gated", (M.minAge ?? 0) === 2 && (T.minAge ?? 0) === 2);
check("both count as military", MILITARY.includes("mangonel") && MILITARY.includes("trebuchet"));

// ---- 2. roles via stats + counters -----------------------------------------
check("only the mangonel has splash", (M.splashRadius ?? 0) > 0 && !T.splashRadius);
check("mangonel out-ranges archers", M.range > UNIT_DEFS.archer.range, `${M.range} > ${UNIT_DEFS.archer.range}`);
check("trebuchet out-ranges towers & TC", T.range > BUILDING_DEFS.tower.attack!.range && T.range > (BUILDING_DEFS.town_center.attack?.range ?? 0));
check("the trebuchet is the premier sieger (out-hits a ram on buildings)", perHitVsBuilding("trebuchet") > perHitVsBuilding("ram"), `treb=${perHitVsBuilding("trebuchet")} ram=${perHitVsBuilding("ram")}`);
check("the mangonel is poor against buildings", damageMultiplier("mangonel", "building") < 1);
check("a trebuchet is near-useless against units", damageMultiplier("trebuchet", "soldier") < 0.5);
check("soldiers counter both siege engines", damageMultiplier("soldier", "mangonel") > 1 && damageMultiplier("soldier", "trebuchet") > 1);
check("cavalry run down both siege engines", damageMultiplier("cavalry", "mangonel") > 1 && damageMultiplier("cavalry", "trebuchet") > 1);
check("archers pick apart a lone trebuchet", damageMultiplier("archer", "trebuchet") > 1);
check("but a mangonel beats archers (no archer bonus vs it)", damageMultiplier("archer", "mangonel") === 1);

// ---- 3. mangonel splash hits an enemy clump --------------------------------
{
  const world = createWorld(7, [
    { name: "A", color: "#fff" },
    { name: "B", color: "#000" },
  ]);
  const fog = createFog(world);
  const proto = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  const mk = (owner: number, type: Unit["type"], x: number, y: number): Unit => ({
    ...proto, id: world.nextEntityId++, owner, type, hp: UNIT_DEFS[type].hp,
    pos: { x, y }, state: "idle", path: [], targetEntity: null,
  });
  const mang = mk(0, "mangonel", 20, 20);
  // A bunched enemy archer ball ~3 tiles away (within mangonel range 6).
  const a = mk(1, "archer", 23, 20); // the aimed target
  const b = mk(1, "archer", 23.6, 20.7); // within 1.5 of a
  const c = mk(1, "archer", 22.4, 19.4); // within 1.5 of a
  const far = mk(1, "archer", 40, 40); // well outside the splash
  world.units = [mang, a, b, c, far];

  applyCommand(world, 0, { c: "attack", units: [mang.id], target: a.id });
  for (let i = 0; i < 4; i++) tick(world, fog);

  const hp = (u: Unit) => world.units.find((x) => x.id === u.id)?.hp ?? 0;
  check("the aimed archer takes damage", hp(a) < UNIT_DEFS.archer.hp, `${hp(a)}`);
  check("a bunched neighbour is splashed too", hp(b) < UNIT_DEFS.archer.hp, `${hp(b)}`);
  check("the other neighbour is splashed too", hp(c) < UNIT_DEFS.archer.hp, `${hp(c)}`);
  check("an archer outside the splash is untouched", hp(far) === UNIT_DEFS.archer.hp, `${hp(far)}`);
}

console.log(pass ? "SIEGE: PASS ✅" : "SIEGE: FAIL ❌");
process.exit(pass ? 0 : 1);
