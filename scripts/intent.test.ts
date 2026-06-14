// The click-intent cascade (plan §2), exercised directly through `resolveOrder`
// with hand-built snapshots — the first real coverage of client order logic, as
// pure data-in/Command-out cases with no PixiJS. Each case asserts the command a
// click produces given a selection, mirroring what the renderer used to decide
// inline in two duplicated input branches.
import {
  resolveOrder,
  type AnimalDTO,
  type BuildingDTO,
  type BuildingType,
  type Command,
  type ResourceNodeDTO,
  type Snapshot,
  type UnitDTO,
  type Vec2,
} from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

const ME = 0;
const ALLY = 1;
const ENEMY = 2;

// Owners 0 and 1 share a team; 2 is the enemy. Mirrors the renderer's isEnemy.
const isEnemy = (owner: number): boolean => owner === ENEMY;

let nextId = 1;
function unit(over: Partial<UnitDTO> = {}): UnitDTO {
  return {
    id: nextId++,
    owner: ME,
    type: "soldier",
    x: 0,
    y: 0,
    hp: 50,
    state: "idle",
    carry: null,
    ...over,
  } as UnitDTO;
}
function building(type: BuildingType, over: Partial<BuildingDTO> = {}): BuildingDTO {
  return {
    id: nextId++,
    owner: ME,
    type,
    tx: 0,
    ty: 0,
    hp: 100000, // "fully healed" unless a test lowers it
    progress: 1,
    ...over,
  };
}
function animal(over: Partial<AnimalDTO> = {}): AnimalDTO {
  return { id: nextId++, kind: "sheep", x: 0, y: 0, hp: 20, ...over } as AnimalDTO;
}
function node(over: Partial<ResourceNodeDTO> = {}): ResourceNodeDTO {
  return { id: nextId++, kind: "wood", tx: 0, ty: 0, amount: 100, ...over };
}

function snapshot(parts: {
  units?: UnitDTO[];
  buildings?: BuildingDTO[];
  resources?: ResourceNodeDTO[];
  animals?: AnimalDTO[];
}): Snapshot {
  return {
    tick: 0,
    visible: "",
    explored: "",
    me: {
      playerId: ME,
      resources: { food: 0, wood: 0, gold: 0, stone: 0 },
      pop: 0,
      popCap: 0,
      upgrades: [],
      age: 0,
      ageUpTimer: 0,
      ageUpMs: 0,
      alive: true,
    },
    players: [
      { id: ME, alive: true },
      { id: ALLY, alive: true },
      { id: ENEMY, alive: true },
    ],
    units: parts.units ?? [],
    buildings: parts.buildings ?? [],
    resources: parts.resources ?? [],
    animals: parts.animals ?? [],
    relics: [],
  };
}

function resolve(
  snap: Snapshot,
  sel: { units?: number[]; building?: number | null },
  point: Vec2,
  queue = false,
): Command | null {
  return resolveOrder(
    { snapshot: snap, me: ME, isEnemy },
    { units: sel.units ?? [], building: sel.building ?? null },
    point,
    { queue },
  );
}

// --- No selection -> no-op; building-only selection -> rally. ---
{
  const snap = snapshot({});
  check("empty selection is a no-op", resolve(snap, {}, { x: 3, y: 3 }) === null);
}
{
  const tc = building("town_center", { tx: 5, ty: 5 });
  const snap = snapshot({ buildings: [tc] });
  const cmd = resolve(snap, { building: tc.id }, { x: 9, y: 1 });
  check(
    "building-only selection rallies",
    cmd?.c === "rally" && cmd.building === tc.id && cmd.tile.x === 9 && cmd.tile.y === 1,
  );
}

// --- Enemy unit / building -> attack. ---
{
  const soldier = unit();
  const foe = unit({ owner: ENEMY, x: 4, y: 4 });
  const snap = snapshot({ units: [soldier, foe] });
  const cmd = resolve(snap, { units: [soldier.id] }, { x: 4.1, y: 4.1 }, true);
  check(
    "click near enemy unit -> attack (queue honoured)",
    cmd?.c === "attack" && cmd.target === foe.id && cmd.queue === true,
  );
}
{
  const soldier = unit();
  const ally = unit({ owner: ALLY, x: 4, y: 4 });
  const snap = snapshot({ units: [soldier, ally] });
  const cmd = resolve(snap, { units: [soldier.id] }, { x: 4, y: 4 });
  check("click on ally unit -> not attack (falls to move)", cmd?.c === "move");
}
{
  const soldier = unit();
  const foeB = building("barracks", { owner: ENEMY, tx: 6, ty: 6 });
  const snap = snapshot({ units: [soldier], buildings: [foeB] });
  const cmd = resolve(snap, { units: [soldier.id] }, { x: 7, y: 7 }); // inside the 3x3 footprint
  check("click on enemy building -> attack", cmd?.c === "attack" && cmd.target === foeB.id);
}

// --- Wild animal -> only workers hunt; non-workers fall through to move. ---
{
  const worker = unit({ type: "worker" });
  const deer = animal({ x: 8, y: 8 });
  const snap = snapshot({ units: [worker], animals: [deer] });
  const cmd = resolve(snap, { units: [worker.id] }, { x: 8, y: 8 });
  check("worker click on animal -> attack(workers)", cmd?.c === "attack" && cmd.target === deer.id);
}
{
  const soldier = unit(); // not a worker
  const deer = animal({ x: 8, y: 8 });
  const snap = snapshot({ units: [soldier], animals: [deer] });
  const cmd = resolve(snap, { units: [soldier.id] }, { x: 8, y: 8 });
  check("non-worker click on animal -> move (no hunt)", cmd?.c === "move");
}

// --- Friendly work site (unfinished or damaged) -> construct with workers. ---
{
  const worker = unit({ type: "worker" });
  const foundation = building("house", { tx: 3, ty: 3, progress: 0.4 });
  const snap = snapshot({ units: [worker], buildings: [foundation] });
  const cmd = resolve(snap, { units: [worker.id] }, { x: 3, y: 3 });
  check(
    "worker click on foundation -> construct",
    cmd?.c === "construct" && cmd.building === foundation.id,
  );
}
{
  const worker = unit({ type: "worker" });
  const hurt = building("house", { tx: 3, ty: 3, progress: 1, hp: 10 }); // damaged (< def hp)
  const snap = snapshot({ units: [worker], buildings: [hurt] });
  const cmd = resolve(snap, { units: [worker.id] }, { x: 4, y: 4 });
  check("worker click on damaged building -> construct(repair)", cmd?.c === "construct");
}
{
  const soldier = unit(); // no workers in selection
  const foundation = building("house", { tx: 3, ty: 3, progress: 0.4 });
  const snap = snapshot({ units: [soldier], buildings: [foundation] });
  const cmd = resolve(snap, { units: [soldier.id] }, { x: 3, y: 3 });
  // Foundation isn't a garrison target and has no node -> falls through to move.
  check("non-worker click on foundation -> move (no construct)", cmd?.c === "move");
}

// --- Friendly completed garrison building -> garrison the whole selection. ---
{
  const soldier = unit();
  const tc = building("town_center", { tx: 5, ty: 5, progress: 1 });
  const snap = snapshot({ units: [soldier], buildings: [tc] });
  const cmd = resolve(snap, { units: [soldier.id] }, { x: 6, y: 6 }); // inside 3x3
  check("click on own TC -> garrison", cmd?.c === "garrison" && cmd.building === tc.id);
}

// --- Friendly farm -> gather the hosted food node (workers only). ---
{
  const worker = unit({ type: "worker" });
  const farm = building("farm", { tx: 4, ty: 4, progress: 1 });
  const crop = node({ kind: "food", owner: ME, tx: 5, ty: 5 }); // under the 2x2 footprint
  const snap = snapshot({ units: [worker], buildings: [farm], resources: [crop] });
  const cmd = resolve(snap, { units: [worker.id] }, { x: 4, y: 4 });
  check("worker click on own farm -> gather hosted node", cmd?.c === "gather" && cmd.node === crop.id);
}

// --- Bare resource node -> gather; enemy-owned farm node is skipped (-> move). ---
{
  const worker = unit({ type: "worker" });
  const tree = node({ kind: "wood", tx: 7, ty: 2 });
  const snap = snapshot({ units: [worker], resources: [tree] });
  const cmd = resolve(snap, { units: [worker.id] }, { x: 7, y: 2 });
  check("click on resource node -> gather", cmd?.c === "gather" && cmd.node === tree.id);
}
{
  const worker = unit({ type: "worker" });
  const enemyCrop = node({ kind: "food", owner: ENEMY, tx: 7, ty: 2 });
  const snap = snapshot({ units: [worker], resources: [enemyCrop] });
  const cmd = resolve(snap, { units: [worker.id] }, { x: 7, y: 2 });
  check("click on enemy-owned farm node -> move (not gather)", cmd?.c === "move");
}

// --- Empty ground -> move (queue flows through). ---
{
  const soldier = unit();
  const snap = snapshot({ units: [soldier] });
  const cmd = resolve(snap, { units: [soldier.id] }, { x: 12, y: 9 }, true);
  check(
    "click on empty ground -> move",
    cmd?.c === "move" && cmd.tile.x === 12 && cmd.tile.y === 9 && cmd.queue === true,
  );
}

console.log(pass ? "INTENT: PASS ✅" : "INTENT: FAIL ❌");
process.exit(pass ? 0 : 1);
