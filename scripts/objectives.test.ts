// §7.10 Map objectives — Wonder victory + relics. Pure-sim coverage:
//   - the Wonder def is a buildable, Imperial-age win condition;
//   - finishing one starts a countdown; the countdown elapsing wins for the
//     owner's team (over the usual last-team-standing rule);
//   - destroying the Wonder cancels the countdown;
//   - relics spawn neutral, are claimed by proximity (enemy flips, contest
//     freezes), and trickle gold to the holder.
// Client rendering (relic sprites, the countdown banner) is not covered here.
import {
  BUILDING_DEFS,
  RELIC_COUNT,
  UNIT_DEFS,
  WONDER_COUNTDOWN_MS,
  applyCommand,
  createFog,
  createWorld,
  isWalkable,
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

// Clone the full Unit shape from a spawned starting unit; override only pinned
// fields (the spread carries new fields as the Unit shape grows).
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

// An open origin near centre with room for a 3×3 wonder + an adjacent worker.
function findClear(world: World, cx: number, cy: number): { x: number; y: number } {
  const clear = (ox: number, oy: number) => {
    for (let x = ox - 1; x <= ox + 4; x++)
      for (let y = oy - 1; y <= oy + 4; y++) if (!isWalkable(world.map, x, y)) return false;
    return true;
  };
  const span = Math.max(world.map.width, world.map.height);
  for (let r = 0; r < span; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (clear(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
  return { x: cx, y: cy };
}

// ---- 1. the Wonder is a buildable, Imperial-age win condition --------------
{
  const w = BUILDING_DEFS.wonder;
  check("wonder def exists", !!w);
  check("wonder is buildable", w.buildable);
  check("wonder is Imperial-gated", w.minAge === 2, `minAge=${w.minAge}`);
  check("wonder is a 3×3", w.size.w === 3 && w.size.h === 3);
  check("wonder costs across resources", !!(w.cost.wood && w.cost.gold && w.cost.stone));
}

// ---- 2. finishing a Wonder starts its countdown ----------------------------
{
  const world = createWorld(3, FFA);
  const template = world.units[0];
  const fog = createFog(world);
  const { x: cx, y: cy } = findClear(world, 30, 30);
  const wonder = addBuilding(world, 0, "wonder", cx, cy, 0.97); // nearly done
  // A worker parked against the footprint, already in "building" state, finishes
  // it without any pathing (avoids terrain flakiness).
  const w = placeUnit(world, template, 0, "worker", cx - 0.6, cy + 1.5);
  w.state = "building";
  w.targetEntity = wonder.id;
  for (let i = 0; i < 90; i++) tick(world, fog);
  check("a worker completes the Wonder", wonder.progress >= 1, `progress=${wonder.progress.toFixed(2)}`);
  check(
    "completion starts the victory countdown",
    wonder.wonderTimer != null && wonder.wonderTimer > 0,
    `timer=${wonder.wonderTimer}`,
  );
}

// ---- 3. the countdown elapsing wins for the Wonder's owner ------------------
{
  const world = createWorld(3, FFA); // player 1 alive, so it's not a trivial win
  const fog = createFog(world);
  const wonder = addBuilding(world, 0, "wonder", 30, 30, 1);
  wonder.wonderTimer = 300; // 3 ticks from victory
  check("no winner before the clock runs out", world.winner === null);
  for (let i = 0; i < 6; i++) tick(world, fog);
  check("Wonder owner wins when the countdown ends", world.winner === 0, `winner=${world.winner}`);
}

// ---- 4. destroying the Wonder cancels the countdown ------------------------
{
  const world = createWorld(3, FFA);
  const fog = createFog(world);
  const wonder = addBuilding(world, 0, "wonder", 30, 30, 1);
  wonder.wonderTimer = 100; // would elapse this very tick…
  wonder.hp = 0; // …but it's destroyed first
  tick(world, fog);
  check("a destroyed Wonder is removed", !world.buildings.some((b) => b.id === wonder.id));
  check("destroying the Wonder cancels the win", world.winner === null, `winner=${world.winner}`);
}

// ---- 5. relics spawn neutral on the map ------------------------------------
{
  const world = createWorld(3, FFA);
  check("relics are placed at map gen", world.relics.length === RELIC_COUNT, `n=${world.relics.length}`);
  check("relics start neutral", world.relics.every((r) => r.owner === undefined));
}

// A relic world with all starting units cleared, so the only gold movement is
// the relic trickle (starting workers would otherwise gather and confound it).
function relicWorld() {
  const world = createWorld(3, FFA);
  const template = world.units[0];
  world.units = [];
  return { world, template, fog: createFog(world), relic: world.relics[0] };
}
const relicCenter = (r: { tile: { x: number; y: number } }) => ({ x: r.tile.x + 0.5, y: r.tile.y + 0.5 });

// ---- 6. a unit in range claims a neutral relic and it pays gold ------------
{
  const { world, template, fog, relic } = relicWorld();
  const c = relicCenter(relic);
  placeUnit(world, template, 0, "worker", c.x, c.y);
  const gold0 = world.players[0].resources.gold;
  for (let i = 0; i < 40; i++) tick(world, fog);
  check("a unit captures a neutral relic", relic.owner === 0, `owner=${relic.owner}`);
  check("a held relic trickles gold to the holder", world.players[0].resources.gold > gold0, `+${world.players[0].resources.gold - gold0}`);
}

// ---- 7. an enemy unit flips an owned relic ---------------------------------
{
  const { world, template, fog, relic } = relicWorld();
  const c = relicCenter(relic);
  relic.owner = 0; // pre-owned by player 0
  placeUnit(world, template, 1, "worker", c.x, c.y); // enemy stands on it, uncontested
  for (let i = 0; i < 5; i++) tick(world, fog);
  check("an enemy unit flips the relic", relic.owner === 1, `owner=${relic.owner}`);
}

// ---- 8. a contested relic does not change hands ----------------------------
{
  const { world, template, fog, relic } = relicWorld();
  const c = relicCenter(relic);
  relic.owner = 0;
  placeUnit(world, template, 0, "worker", c.x - 0.2, c.y); // holder present…
  placeUnit(world, template, 1, "worker", c.x + 0.2, c.y); // …and an enemy contesting
  for (let i = 0; i < 10; i++) tick(world, fog);
  check("a contested relic stays with its owner", relic.owner === 0, `owner=${relic.owner}`);
}

console.log(pass ? "OBJECTIVES: PASS ✅" : "OBJECTIVES: FAIL ❌");
process.exit(pass ? 0 : 1);
