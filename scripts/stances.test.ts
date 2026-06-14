// §7.9 Unit stances + patrol. Pure-sim coverage of the four combat postures
// (aggressive / defensive / stand-ground / no-attack) and the patrol loop. The
// HUD toggles + patrol click-arming are client-only (not covered here).
//
//   - defensive (default): only retaliates when hit, leashed to sight (unchanged
//     from before this feature, so the rest of the suite still passes).
//   - aggressive: proactively engages any foe in sight and chases within a leash.
//   - standGround: attacks only what is already in range; never takes a step.
//   - noAttack: never auto-engages, even when attacked.
//   - patrol: loops between the clicked post and the unit's start, fighting en
//     route; cancelled by any fresh order.
import {
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  isWalkable,
  tick,
  type Stance,
  type Unit,
  type UnitType,
  type World,
} from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

// Clone the full Unit shape from a spawned starting unit, overriding only the
// fields we pin. The spread carries new fields (stance/patrol default to
// defensive/null) so the test stays robust as the Unit shape grows.
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
    attackedTtl: 0,
    retaliating: false,
    orders: [],
    stance: "defensive",
    patrol: null,
  };
  world.units.push(u);
  return u;
}

const FFA = [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
];

// Find an open origin near the map centre with a clear horizontal corridor (the
// patrol/chase tests march ~10 tiles in +x). Seed maps scatter water/rock, so a
// fixed centre can land on impassable terrain and units placed there can't path.
function findClear(world: World, cx: number, cy: number): { x: number; y: number } {
  const clear = (ox: number, oy: number) => {
    for (let x = ox - 1; x <= ox + 11; x++)
      for (let y = oy - 2; y <= oy + 2; y++) if (!isWalkable(world.map, x, y)) return false;
    return true;
  };
  const span = Math.max(world.map.width, world.map.height);
  for (let r = 0; r < span; r++) {
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // walk the ring
        if (clear(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
  }
  return { x: cx, y: cy };
}

// A 2-player FFA world with a clean working area near the map centre, far from
// both bases (player 0's town centre now fires arrows, so an enemy parked near
// it would be shot — hence the corridor sits in no-man's-land). Starting units
// stay at the edges, outside any sight radius, so they never interfere.
function arena() {
  const world = createWorld(11, FFA);
  const template = world.units[0];
  const { x: cx, y: cy } = findClear(
    world,
    Math.floor(world.map.width / 2),
    Math.floor(world.map.height / 2),
  );
  return { world, fog: createFog(world), template, cx, cy };
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const setStance = (world: World, owner: number, id: number, stance: Stance) =>
  applyCommand(world, owner, { c: "setStance", units: [id], stance });

const WORKER_HP = UNIT_DEFS.worker.hp;
const ARCHER_RANGE = UNIT_DEFS.archer.range; // 5
const ARCHER_SIGHT = UNIT_DEFS.archer.sight; // 7

// ---- 1. defaults + the setStance command ----------------------------------
{
  const { world, template, cx, cy } = arena();
  const u = placeUnit(world, template, 0, "soldier", cx + 0.5, cy + 0.5);
  check("a fresh unit defaults to defensive", u.stance === "defensive", u.stance);
  check("spawned starting units default to defensive", world.units[0].stance === "defensive");

  // An enemy cannot change my unit's stance; the owner can.
  setStance(world, 1, u.id, "aggressive");
  check("setStance is owner-gated", u.stance === "defensive", u.stance);
  setStance(world, 0, u.id, "aggressive");
  check("the owner can set a stance", u.stance === "aggressive", u.stance);
}

// ---- 2. noAttack holds fire even when struck ------------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const a = placeUnit(world, template, 0, "archer", cx + 0.5, cy + 0.5);
  setStance(world, 0, a.id, "noAttack");
  const foe = placeUnit(world, template, 1, "soldier", cx + 1.5, cy + 0.5);
  // Force the enemy to attack our pacifist so we can see it not fight back.
  applyCommand(world, 1, { c: "attack", units: [foe.id], target: a.id });
  for (let i = 0; i < 30; i++) tick(world, fog);
  check("a no-attack unit takes damage", a.hp < UNIT_DEFS.archer.hp, `hp=${a.hp}`);
  check("a no-attack unit never strikes back", foe.hp === UNIT_DEFS.soldier.hp, `foe=${foe.hp}`);
  check("a no-attack unit stays out of combat", a.state !== "attacking", a.state);
}

// ---- 3. defensive (default) retaliates when struck ------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const a = placeUnit(world, template, 0, "archer", cx + 0.5, cy + 0.5); // defensive
  const foe = placeUnit(world, template, 1, "soldier", cx + 1.5, cy + 0.5);
  applyCommand(world, 1, { c: "attack", units: [foe.id], target: a.id });
  for (let i = 0; i < 30; i++) tick(world, fog);
  check("a defensive unit fights back when hit", foe.hp < UNIT_DEFS.soldier.hp, `foe=${foe.hp}`);
}

// ---- 4. aggressive seeks a foe in sight; defensive does not ----------------
{
  // Enemy sits 4 tiles off — inside the archer's range, but it never attacks.
  const mk = (stance: Stance) => {
    const { world, fog, template, cx, cy } = arena();
    const a = placeUnit(world, template, 0, "archer", cx + 0.5, cy + 0.5);
    setStance(world, 0, a.id, stance);
    const foe = placeUnit(world, template, 1, "worker", cx + 4.5, cy + 0.5);
    for (let i = 0; i < 20; i++) tick(world, fog);
    return foe.hp;
  };
  check("aggressive engages an unprovoked foe in sight", mk("aggressive") < WORKER_HP);
  check("defensive ignores an unprovoked foe in sight", mk("defensive") === WORKER_HP);
}

// ---- 5. aggressive chases (within a leash) toward an out-of-range foe ------
{
  const { world, fog, template, cx, cy } = arena();
  const a = placeUnit(world, template, 0, "archer", cx + 0.5, cy + 0.5);
  setStance(world, 0, a.id, "aggressive");
  // 6 tiles: inside sight (7) but outside attack range (5), so it must close in.
  const foe = placeUnit(world, template, 1, "worker", cx + 6.5, cy + 0.5);
  const startX = a.pos.x;
  for (let i = 0; i < 40; i++) tick(world, fog);
  check("aggressive moves toward an out-of-range foe", a.pos.x - startX > 0.5, `dx=${(a.pos.x - startX).toFixed(2)}`);
  check("aggressive eventually damages the foe it chased", foe.hp < WORKER_HP, `foe=${foe.hp}`);
}

// ---- 6. stand-ground attacks in range but never moves ---------------------
{
  // (a) foe in range → it shoots without budging.
  {
    const { world, fog, template, cx, cy } = arena();
    const a = placeUnit(world, template, 0, "archer", cx + 0.5, cy + 0.5);
    setStance(world, 0, a.id, "standGround");
    const foe = placeUnit(world, template, 1, "worker", cx + 3.5, cy + 0.5); // dist 3 < range 5
    for (let i = 0; i < 12; i++) tick(world, fog);
    check("stand-ground hits a foe already in range", foe.hp < WORKER_HP, `foe=${foe.hp}`);
  }
  // (b) foe in sight but out of range → it neither shoots nor steps.
  {
    const { world, fog, template, cx, cy } = arena();
    const a = placeUnit(world, template, 0, "archer", cx + 0.5, cy + 0.5);
    setStance(world, 0, a.id, "standGround");
    const start = { ...a.pos };
    const foe = placeUnit(world, template, 1, "worker", cx + 6.5, cy + 0.5); // dist 6: in sight 7, out of range 5
    for (let i = 0; i < 30; i++) tick(world, fog);
    check("stand-ground ignores a foe beyond range", foe.hp === WORKER_HP, `foe=${foe.hp}`);
    check("stand-ground never takes a step", dist(a.pos, start) < 0.01, `moved=${dist(a.pos, start).toFixed(3)}`);
    // sanity: the foe really was within sight (so it was a held-fire choice).
    check("(the foe was within sight)", dist(a.pos, foe.pos) <= ARCHER_SIGHT && dist(a.pos, foe.pos) > ARCHER_RANGE);
  }
}

// ---- 7. patrol loops between the post and the unit's start -----------------
{
  const { world, fog, template, cx, cy } = arena();
  const a = placeUnit(world, template, 0, "soldier", cx + 0.5, cy + 0.5);
  applyCommand(world, 0, { c: "patrol", units: [a.id], tile: { x: cx + 8, y: cy } });
  check("patrol sets a two-post loop", a.patrol !== null && a.patrol.length === 2, `${a.patrol?.length}`);
  let minX = a.pos.x;
  let maxX = a.pos.x;
  for (let i = 0; i < 220; i++) {
    tick(world, fog);
    minX = Math.min(minX, a.pos.x);
    maxX = Math.max(maxX, a.pos.x);
  }
  check("patrol reaches the far post", maxX > cx + 7, `maxX=${maxX.toFixed(1)}`);
  check("patrol returns toward the start", minX < cx + 1.5, `minX=${minX.toFixed(1)}`);
  check("patrol keeps looping (never falls idle)", a.patrol !== null && a.state !== "idle", a.state);
}

// ---- 8. a patrolling unit engages a foe on its route ----------------------
{
  const { world, fog, template, cx, cy } = arena();
  const a = placeUnit(world, template, 0, "soldier", cx + 0.5, cy + 0.5);
  const foe = placeUnit(world, template, 1, "worker", cx + 4.5, cy + 0.5); // sitting on the route
  applyCommand(world, 0, { c: "patrol", units: [a.id], tile: { x: cx + 9, y: cy } });
  for (let i = 0; i < 60; i++) tick(world, fog);
  check("a patrol attacks a foe in its path", foe.hp < WORKER_HP, `foe=${foe.hp}`);
}

// ---- 9. a fresh order cancels the patrol ----------------------------------
{
  const { world, template, cx, cy } = arena();
  const a = placeUnit(world, template, 0, "soldier", cx + 0.5, cy + 0.5);
  applyCommand(world, 0, { c: "patrol", units: [a.id], tile: { x: cx + 6, y: cy } });
  check("patrol is armed", a.patrol !== null);
  applyCommand(world, 0, { c: "stop", units: [a.id] });
  check("stop cancels the patrol", a.patrol === null && a.state === "idle", a.state);

  applyCommand(world, 0, { c: "patrol", units: [a.id], tile: { x: cx + 6, y: cy } });
  applyCommand(world, 0, { c: "move", units: [a.id], tile: { x: cx, y: cy + 4 } });
  check("a move order cancels the patrol", a.patrol === null, `${a.patrol}`);
}

console.log(pass ? "STANCES: PASS ✅" : "STANCES: FAIL ❌");
process.exit(pass ? 0 : 1);
