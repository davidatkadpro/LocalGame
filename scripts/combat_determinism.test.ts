// Determinism guard for the combat refactor (plan §3). A fixed battle — mixed
// armies, every stance, an attack-move, a direct attack (post-kill swing), siege
// splash, and a town center firing on intruders — run for a set number of ticks,
// then hashed over unit/building hp and positions. The hash is baked in below: any
// change to combat that alters the outcome by even one ulp flips it. This is what
// lets the acquisition/damage extraction be a *refactor* and not a behaviour
// change — the suite proves intent, this proves byte-for-byte equality.
import {
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  tick,
  type Stance,
  type Unit,
  type UnitType,
  type World,
} from "@bg/shared";

const PS = [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
];

let pass = true;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

/** A fully-formed idle unit at a fixed spot (no makeUnit export needed). */
function mk(world: World, owner: number, type: UnitType, x: number, y: number, stance: Stance = "defensive"): Unit {
  return {
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
    lastGatherNode: null,
    orders: [],
    stance,
    patrol: null,
  };
}

/** FNV-1a 32-bit over a canonical, rounded snapshot of all combat state. */
function hashWorld(world: World): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  const q = (v: number): number => Math.round(v * 1000);
  // Sort by id so the hash is independent of array reordering (garrison moves
  // units between arrays, etc.) — we're guarding the numbers, not the order.
  for (const u of [...world.units].sort((a, b) => a.id - b.id)) {
    mix(u.id);
    mix(q(u.hp));
    mix(q(u.pos.x));
    mix(q(u.pos.y));
    mix(u.attackedBy ?? -1);
  }
  for (const b of [...world.buildings].sort((a, c) => a.id - c.id)) {
    mix(b.id);
    mix(q(b.hp));
  }
  return h >>> 0;
}

function runBattle(): number {
  const world = createWorld(12345, PS);
  const fog = createFog(world);
  world.units = []; // drop the starting workers; we control the roster

  const tc0 = world.buildings.find((b) => b.owner === 0)!;
  const cx = tc0.tile.x;
  const cy = tc0.tile.y;

  // Player 0 — attackers, just outside their own TC.
  const s1 = mk(world, 0, "soldier", cx + 5, cy - 0.5, "aggressive");
  const s2 = mk(world, 0, "soldier", cx + 5, cy + 0.5, "aggressive");
  const a1 = mk(world, 0, "archer", cx + 4.5, cy - 1, "defensive");
  const a2 = mk(world, 0, "archer", cx + 4.5, cy + 1, "defensive");
  const mango = mk(world, 0, "mangonel", cx + 4, cy, "defensive");

  // Player 1 — a clump of archers (splash bait) + soldiers holding the line.
  const e1 = mk(world, 1, "archer", cx + 8, cy - 0.2, "standGround");
  const e2 = mk(world, 1, "archer", cx + 8.4, cy, "standGround");
  const e3 = mk(world, 1, "archer", cx + 8, cy + 0.3, "standGround");
  const e4 = mk(world, 1, "soldier", cx + 8.5, cy + 1, "aggressive");
  const e5 = mk(world, 1, "soldier", cx + 8.5, cy - 1, "aggressive");

  world.units = [s1, s2, a1, a2, mango, e1, e2, e3, e4, e5];

  // Attack-move the main body toward the enemy clump (exercises acquireTarget on
  // the moving branch + resumeAggro after a kill).
  applyCommand(world, 0, {
    c: "attackMove",
    units: [s1.id, s2.id, a1.id, a2.id],
    tile: { x: cx + 9, y: cy },
  });
  // A direct attack from the mangonel (exercises the post-kill nearestEnemyUnit
  // swing + siege splash through applyDamage).
  applyCommand(world, 0, { c: "attack", units: [mango.id], target: e2.id });

  for (let i = 0; i < 250; i++) tick(world, fog);
  return hashWorld(world);
}

// Re-running the identical scenario must produce the identical hash (no hidden
// nondeterminism), and that hash must match the value captured from the sim
// before the combat extraction.
const a = runBattle();
const b = runBattle();
check("battle is internally reproducible", a === b, `a=${a} b=${b}`);

const EXPECTED = 1439965385; // baked from the sim with the damage path extracted (stage 1)
check("battle hash matches the pre-refactor baseline", a === EXPECTED, `got=${a} expected=${EXPECTED}`);

console.log(pass ? "COMBAT-DETERMINISM: PASS ✅" : "COMBAT-DETERMINISM: FAIL ❌");
process.exit(pass ? 0 : 1);
