// #2 Skirmisher kiting: an auto-engaging archer (attack-move / aggressive /
// retaliation) backs away from a closing melee unit to keep firing at range —
// realizing the archer→soldier counter. A *direct* attack order, by contrast,
// means "hold and shoot" and must NOT kite (so focus-fire / counters.test stay
// intact). Pure sim, no network.
import {
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  tick,
  type Unit,
  type UnitType,
  type World,
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

function placeUnit(world: World, template: Unit, owner: number, type: UnitType, x: number, y: number, stance: Unit["stance"] = "defensive"): Unit {
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
    attackedTtl: 0,
    retaliating: false,
    orders: [],
    stance,
    patrol: null,
  };
  world.units.push(u);
  return u;
}

// A fresh world with a clear horizontal corridor carved through the map centre
// (far from the corner town centres, so their arrows don't interfere).
function arena() {
  const world = createWorld(7, PS);
  const template = world.units[0];
  const W = world.map.width;
  const cx = Math.floor(W / 2);
  const cy = Math.floor(world.map.height / 2);
  // A generously-sized clear field so a kiting unit (which drifts diagonally as it
  // flees) doesn't run into untouched water/rock at the edge of a narrow strip.
  for (let y = cy - 12; y <= cy + 12; y++)
    for (let x = cx - 18; x <= cx + 18; x++) world.map.tiles[y * W + x] = "grass";
  world.units = [];
  return { world, fog: createFog(world), template, cx, cy };
}

check("the archer is flagged as a skirmisher", UNIT_DEFS.archer.skirmish === true);

// Run an archer-vs-closing-soldier scenario and report how far the archer moved
// and the final gap it keeps. `auto` = aggressive/attack-move (should kite);
// `direct` = a player attack order on the soldier (should hold and fire).
function scenario(mode: "auto" | "direct") {
  const { world, fog, template, cx, cy } = arena();
  const archer = placeUnit(world, template, 0, "archer", cx - 1, cy, mode === "auto" ? "aggressive" : "defensive");
  const soldier = placeUnit(world, template, 1, "soldier", cx + 1, cy);
  if (mode === "direct") applyCommand(world, 0, { c: "attack", units: [archer.id], target: soldier.id });
  applyCommand(world, 1, { c: "attack", units: [soldier.id], target: archer.id });
  const startX = archer.pos.x;
  for (let i = 0; i < 50; i++) tick(world, fog);
  const a = world.units.find((u) => u.id === archer.id);
  const s = world.units.find((u) => u.id === soldier.id);
  return {
    moved: a ? startX - a.pos.x : 0,
    gap: a && s ? Math.hypot(a.pos.x - s.pos.x, a.pos.y - s.pos.y) : 0,
    alive: !!a,
  };
}

const auto = scenario("auto");
const direct = scenario("direct");

check("an auto-engaging archer kites away from the closing soldier", auto.alive && auto.moved > 1, `moved ${auto.moved.toFixed(2)} tiles`);
check("kiting keeps the archer clear of melee range", auto.gap > 1.5, `gap ${auto.gap.toFixed(2)}`);
check("a directly-ordered archer holds ground (no kiting)", Math.abs(direct.moved) < 1, `moved ${direct.moved.toFixed(2)}`);
check(
  "kiting keeps more distance than holding",
  auto.gap > direct.gap + 1,
  `autoGap=${auto.gap.toFixed(2)} directGap=${direct.gap.toFixed(2)}`,
);

// A faster melee unit (cavalry) can't be kited — it runs the archer down, so the
// cavalry > archer counter survives (an auto archer doesn't flee a cavalry).
const vsCav = (() => {
  const { world, fog, template, cx, cy } = arena();
  const archer = placeUnit(world, template, 0, "archer", cx - 1, cy, "aggressive");
  const cav = placeUnit(world, template, 1, "cavalry", cx + 1, cy);
  applyCommand(world, 1, { c: "attack", units: [cav.id], target: archer.id });
  const startX = archer.pos.x;
  for (let i = 0; i < 30; i++) tick(world, fog);
  const a = world.units.find((u) => u.id === archer.id);
  return { moved: a ? startX - a.pos.x : 999, alive: !!a };
})();
check(
  "an archer does not flee a faster cavalry (no vain kiting)",
  !vsCav.alive || vsCav.moved < 1,
  vsCav.alive ? `moved ${vsCav.moved.toFixed(2)}` : "archer ridden down (expected)",
);

console.log(pass ? "KITING: PASS ✅" : "KITING: FAIL ❌");
process.exit(pass ? 0 : 1);
