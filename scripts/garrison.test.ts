// §7.5b Garrison: units shelter inside a TC/tower (off the map — protected, not
// targetable), garrisoned archers add arrows to the building's volley, you eject
// on command, and a razed building spills its garrison. Pure sim — the client
// garrison-click + eject button are not covered here.
import {
  BUILDING_DEFS,
  UNIT_DEFS,
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

// An open origin near centre with room for a 3×3 building + a ring of units.
function findClear(world: World, cx: number, cy: number): { x: number; y: number } {
  const clear = (ox: number, oy: number) => {
    for (let x = ox - 1; x <= ox + 4; x++)
      for (let y = oy - 1; y <= oy + 5; y++) if (!isWalkable(world.map, x, y)) return false;
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

function arena() {
  const world = createWorld(7, FFA);
  const template = world.units[0];
  const { x: cx, y: cy } = findClear(
    world,
    Math.floor(world.map.width / 2),
    Math.floor(world.map.height / 2),
  );
  return { world, fog: createFog(world), template, cx, cy };
}

const garrisonOf = (b: Building) => b.garrison ?? [];

// ---- 1. only the TC and tower can garrison ---------------------------------
{
  check("the TC has garrison capacity", (BUILDING_DEFS.town_center.garrisonCap ?? 0) > 0);
  check("the tower has garrison capacity", (BUILDING_DEFS.tower.garrisonCap ?? 0) > 0);
  check("a house cannot garrison", !BUILDING_DEFS.house.garrisonCap);
  check("a barracks cannot garrison", !BUILDING_DEFS.barracks.garrisonCap);
}

// ---- 2. a unit walks in and shelters inside --------------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const tc = addBuilding(world, 0, "town_center", cx, cy);
  const w = placeUnit(world, template, 0, "worker", cx - 0.6, cy + 1.5);
  applyCommand(world, 0, { c: "garrison", units: [w.id], building: tc.id });
  for (let i = 0; i < 15; i++) tick(world, fog);
  check("a unit garrisons into the TC", garrisonOf(tc).some((u) => u.id === w.id), `n=${garrisonOf(tc).length}`);
  check("a garrisoned unit leaves the map", !world.units.some((u) => u.id === w.id));
}

// ---- 3. garrison respects capacity -----------------------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const tower = addBuilding(world, 0, "tower", cx, cy); // 2×2, cap 5
  const cap = BUILDING_DEFS.tower.garrisonCap!;
  // distinct tiles around the 2×2 footprint, all within reach
  const spots = [
    [cx - 0.5, cy + 0.5], [cx - 0.5, cy + 1.5], [cx + 2.5, cy + 0.5], [cx + 2.5, cy + 1.5],
    [cx + 0.5, cy - 0.5], [cx + 1.5, cy - 0.5], [cx + 0.5, cy + 2.5],
  ];
  const ids = spots.map(([x, y]) => placeUnit(world, template, 0, "worker", x, y).id);
  check("(more units than capacity were sent)", ids.length > cap);
  applyCommand(world, 0, { c: "garrison", units: ids, building: tower.id });
  for (let i = 0; i < 20; i++) tick(world, fog);
  check("garrison never exceeds capacity", garrisonOf(tower).length === cap, `n=${garrisonOf(tower).length}/${cap}`);
  check("the overflow units stay on the map", world.units.filter((u) => ids.includes(u.id)).length === ids.length - cap);
}

// ---- 4. a garrisoned unit is protected from attack -------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const tc = addBuilding(world, 0, "town_center", cx, cy);
  const w = placeUnit(world, template, 0, "worker", cx - 0.6, cy + 1.5);
  applyCommand(world, 0, { c: "garrison", units: [w.id], building: tc.id });
  for (let i = 0; i < 15; i++) tick(world, fog);
  const hp0 = garrisonOf(tc).find((u) => u.id === w.id)?.hp ?? -1;
  // Order an enemy to attack the now-sheltered unit; it can't be reached.
  const foe = placeUnit(world, template, 1, "soldier", cx - 0.6, cy + 2.5);
  applyCommand(world, 1, { c: "attack", units: [foe.id], target: w.id });
  for (let i = 0; i < 30; i++) tick(world, fog);
  check("a garrisoned unit takes no damage", garrisonOf(tc).find((u) => u.id === w.id)?.hp === hp0, `hp=${garrisonOf(tc).find((u) => u.id === w.id)?.hp}`);
}

// ---- 5. garrisoned archers add arrows --------------------------------------
{
  // Same foe vs an empty TC and a TC sheltering 3 archers — the latter hits harder.
  function damageDealt(archers: number): number {
    const { world, fog, template, cx, cy } = arena();
    const tc = addBuilding(world, 0, "town_center", cx, cy);
    for (let i = 0; i < archers; i++) {
      const a = placeUnit(world, template, 0, "archer", cx + 1.5, cy + 1.5);
      world.units = world.units.filter((u) => u.id !== a.id); // shelter it directly
      (tc.garrison ??= []).push(a);
    }
    const foe = placeUnit(world, template, 1, "cavalry", cx + 0.5, cy + 3.5); // tanky, in range
    const hp0 = foe.hp;
    for (let i = 0; i < 20; i++) tick(world, fog);
    return hp0 - foe.hp;
  }
  const base = damageDealt(0);
  const boosted = damageDealt(3);
  check("an empty TC still fires its own arrow", base > 0, `${base}`);
  check("garrisoned archers add arrows (more damage)", boosted > base, `${boosted} vs ${base}`);
}

// ---- 5b. garrisoned archers shoot with the owner's attack upgrades ----------
{
  // The same sheltered archers should hit harder when the owner has researched an
  // attack upgrade — garrison arrows use unitDamage, not the raw base.
  function damageWithUpgrade(upgrades: string[]): number {
    const { world, fog, template, cx, cy } = arena();
    world.players[0].upgrades = upgrades as never;
    const tc = addBuilding(world, 0, "town_center", cx, cy);
    const a = placeUnit(world, template, 0, "archer", cx + 1.5, cy + 1.5);
    world.units = world.units.filter((u) => u.id !== a.id);
    (tc.garrison ??= []).push(a);
    const foe = placeUnit(world, template, 1, "cavalry", cx + 0.5, cy + 3.5);
    const hp0 = foe.hp;
    for (let i = 0; i < 20; i++) tick(world, fog);
    return hp0 - foe.hp;
  }
  const plain = damageWithUpgrade([]);
  const teched = damageWithUpgrade(["sharpenedBlades"]);
  check("attack upgrades boost garrison arrows", teched > plain, `${teched} vs ${plain}`);
}

// ---- 6. eject returns the garrison to the map ------------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const tc = addBuilding(world, 0, "town_center", cx, cy);
  const w = placeUnit(world, template, 0, "worker", cx - 0.6, cy + 1.5);
  applyCommand(world, 0, { c: "garrison", units: [w.id], building: tc.id });
  for (let i = 0; i < 15; i++) tick(world, fog);
  check("(the unit is garrisoned)", garrisonOf(tc).length === 1);
  applyCommand(world, 0, { c: "ejectGarrison", building: tc.id });
  check("eject empties the garrison", garrisonOf(tc).length === 0);
  const back = world.units.find((u) => u.id === w.id);
  check("the ejected unit is back on the map", !!back);
  check("it stands next to the building", !!back && Math.hypot(back.pos.x - (cx + 1.5), back.pos.y - (cy + 1.5)) < 3);
}

// ---- 7. a razed building spills its garrison -------------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const tc = addBuilding(world, 0, "town_center", cx, cy);
  const w = placeUnit(world, template, 0, "worker", cx - 0.6, cy + 1.5);
  applyCommand(world, 0, { c: "garrison", units: [w.id], building: tc.id });
  for (let i = 0; i < 15; i++) tick(world, fog);
  check("(the unit is garrisoned before razing)", garrisonOf(tc).length === 1);
  tc.hp = 0; // raze it (player 0 still has their spawn TC, so they're not eliminated)
  tick(world, fog);
  check("a razed building ejects its garrison", world.units.some((u) => u.id === w.id));
  check("the razed building is gone", !world.buildings.some((b) => b.id === tc.id));
}

// ---- 8. garrisoned units still cost population -----------------------------
{
  const { world, fog, template, cx, cy } = arena();
  const tc = addBuilding(world, 0, "town_center", cx, cy);
  const w = placeUnit(world, template, 0, "worker", cx - 0.6, cy + 1.5);
  for (let i = 0; i < 2; i++) tick(world, fog); // let recomputePop settle
  const popBefore = world.players[0].pop;
  applyCommand(world, 0, { c: "garrison", units: [w.id], building: tc.id });
  for (let i = 0; i < 15; i++) tick(world, fog);
  check("(the unit is garrisoned)", garrisonOf(tc).length === 1);
  check(
    "garrisoning doesn't drop the player's pop (no cap-dodging)",
    world.players[0].pop === popBefore,
    `${world.players[0].pop} vs ${popBefore}`,
  );
}

console.log(pass ? "GARRISON: PASS ✅" : "GARRISON: FAIL ❌");
process.exit(pass ? 0 : 1);
