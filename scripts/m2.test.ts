// Sim-level tests for the M2 gameplay additions: research mechanic, upgrade
// effects (gather rate, attack, armor), and tower auto-attack. Drives the
// authoritative sim directly via tsx — no network, fully deterministic.
import {
  BUILDING_DEFS,
  UNIT_DEFS,
  UPGRADE_DEFS,
  applyCommand,
  createFog,
  createWorld,
  tick,
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

// ---- 1. research mechanic: pay, count down, apply upgrade -----------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const tc = world.buildings.find((b) => b.owner === 0 && b.type === "town_center")!;
  const cost = UPGRADE_DEFS.improvedTools.cost;
  const woodBefore = world.players[0].resources.wood;

  applyCommand(world, 0, { c: "research", building: tc.id, upgrade: "improvedTools" });
  check("research starts on the building", tc.research === "improvedTools");
  check(
    "research pays its cost",
    world.players[0].resources.wood === woodBefore - (cost.wood ?? 0),
  );

  const ticks = Math.ceil(UPGRADE_DEFS.improvedTools.researchMs / 100) + 2;
  for (let i = 0; i < ticks; i++) tick(world, fog);
  check("upgrade applied when research completes", world.players[0].upgrades.includes("improvedTools"));
  check("building research slot clears", tc.research === null);
}

// ---- 2. gather-rate upgrade actually gathers more -------------------------
function woodGatheredIn(upgrades: ("improvedTools")[], steps: number): number {
  const world = createWorld(7, PS);
  const fog = createFog(world);
  world.players[0].upgrades = upgrades.slice();
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // nearest wood node to that worker
  let node = world.resourceNodes.filter((n) => n.kind === "wood")[0];
  let best = Infinity;
  for (const n of world.resourceNodes) {
    if (n.kind !== "wood") continue;
    const d = Math.hypot(n.tile.x - worker.pos.x, n.tile.y - worker.pos.y);
    if (d < best) {
      best = d;
      node = n;
    }
  }
  const start = world.players[0].resources.wood;
  applyCommand(world, 0, { c: "gather", units: [worker.id], node: node.id });
  for (let i = 0; i < steps; i++) tick(world, fog);
  return world.players[0].resources.wood - start;
}
{
  const base = woodGatheredIn([], 300);
  const boosted = woodGatheredIn(["improvedTools"], 300);
  check("Improved Tools increases gathering", boosted > base, `base=${base} boosted=${boosted}`);
}

// ---- 3. attack & armor upgrades change combat damage ----------------------
function duelDamage(attackerUp: string[], defenderUp: string[], ticks = 40): number {
  const world = createWorld(7, PS);
  const fog = createFog(world);
  world.players[0].upgrades = attackerUp.slice() as never;
  world.players[1].upgrades = defenderUp.slice() as never;
  const atk = world.units.find((u) => u.owner === 0)!;
  const def = world.units.find((u) => u.owner === 1)!;
  atk.type = "soldier";
  atk.hp = UNIT_DEFS.soldier.hp;
  def.type = "soldier";
  def.hp = UNIT_DEFS.soldier.hp;
  atk.pos = { x: 12, y: 12 };
  def.pos = { x: 12.7, y: 12 }; // already inside soldier range (0.8)
  world.units = [atk, def];
  const hp0 = def.hp;
  applyCommand(world, 0, { c: "attack", units: [atk.id], target: def.id });
  for (let i = 0; i < ticks; i++) tick(world, fog);
  const d = world.units.find((u) => u.id === def.id);
  return hp0 - (d ? Math.max(0, d.hp) : 0);
}
{
  const base = duelDamage([], []);
  const withBlades = duelDamage(["sharpenedBlades"], []);
  const withArmor = duelDamage([], ["paddedArmor"]);
  check("base combat deals damage", base > 0, `dmg=${base}`);
  check("Sharpened Blades increases damage", withBlades > base, `base=${base} blades=${withBlades}`);
  check("Padded Armor reduces damage taken", withArmor < base, `base=${base} armor=${withArmor}`);
}

// ---- 4. tower auto-attacks an enemy in range -----------------------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const tower = {
    id: world.nextEntityId++,
    owner: 0,
    type: "tower" as const,
    tile: { x: 14, y: 14 },
    hp: BUILDING_DEFS.tower.hp,
    progress: 1,
    queue: [],
    produceTimer: 0,
    rally: null,
    research: null,
    researchTimer: 0,
    attackCooldown: 0,
  };
  world.buildings.push(tower);
  const enemy = world.units.find((u) => u.owner === 1)!;
  enemy.pos = { x: 16, y: 15.5 }; // within range 6 of the footprint
  world.units = [enemy];
  const enemyId = enemy.id;
  let killed = false;
  for (let i = 0; i < 60; i++) {
    tick(world, fog);
    if (!world.units.some((u) => u.id === enemyId)) {
      killed = true;
      break;
    }
  }
  check("tower kills an enemy that walks into range", killed);
}

console.log(pass ? "M2: PASS ✅" : "M2: FAIL ❌");
process.exit(pass ? 0 : 1);
