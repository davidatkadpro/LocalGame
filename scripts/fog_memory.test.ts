// §7 Fog memory: an enemy building a player has scouted stays drawn as a stale
// "ghost" (its last-seen state) after the player loses sight of it, and is
// forgotten once the player sees its footprint is empty (razed). Pure sim.
import {
  BUILDING_DEFS,
  createFog,
  createWorld,
  tick,
  viewFor,
  type Building,
  type World,
} from "@bg/shared";

const FFA = [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
];

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

function addBuilding(world: World, owner: number, type: Building["type"], x: number, y: number): Building {
  const b: Building = {
    id: world.nextEntityId++, owner, type, tile: { x, y }, hp: BUILDING_DEFS[type].hp,
    progress: 1, queue: [], produceTimer: 0, rally: null, research: null, researchTimer: 0, attackCooldown: 0,
  };
  world.buildings.push(b);
  return b;
}

const world = createWorld(7, FFA);
const fog = createFog(world);
const enemyTc = world.buildings.find((b) => b.owner === 1 && b.type === "town_center")!;
// A second enemy building (on the scout's approach side, within its sight) so
// razing the TC later doesn't eliminate player 1 and we can see it persist.
const enemyHouse = addBuilding(world, 1, "house", enemyTc.tile.x - 3, enemyTc.tile.y);
// Our scout: a player-0 worker we teleport around to control what it sees.
const scout = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
world.units = world.units.filter((u) => u.id === scout.id || u.owner === 1);

const home = { x: scout.pos.x, y: scout.pos.y };
const near = { x: enemyTc.tile.x - 1, y: enemyTc.tile.y - 1 }; // within the worker's sight (5)

// ---- 0. before scouting, the enemy base is hidden --------------------------
{
  tick(world, fog);
  const view = viewFor(world, fog, 0);
  check("an unseen enemy building is not in view", !view.buildings.some((b) => b.id === enemyTc.id));
}

// ---- 1. while scouting, the enemy building is visible & live ---------------
scout.pos = { x: near.x, y: near.y };
tick(world, fog);
{
  const view = viewFor(world, fog, 0);
  const tc = view.buildings.find((b) => b.id === enemyTc.id);
  check("a scouted enemy building is visible", !!tc);
  check("a currently-seen enemy building is live (not stale)", !!tc && !tc.stale);
}

// ---- 2. after leaving, it lingers as a stale ghost -------------------------
scout.pos = { x: home.x, y: home.y };
for (let i = 0; i < 3; i++) tick(world, fog);
{
  const view = viewFor(world, fog, 0);
  const tc = view.buildings.find((b) => b.id === enemyTc.id);
  check("a building left behind is still remembered", !!tc);
  check("the remembered building is flagged stale", !!tc && tc.stale === true);
  check("the ghost carries its last-seen position", !!tc && tc.tx === enemyTc.tile.x && tc.ty === enemyTc.tile.y);
}

// ---- 3. re-seeing the empty footprint forgets the ghost --------------------
world.buildings = world.buildings.filter((b) => b.id !== enemyTc.id); // raze it (out of our sight)
scout.pos = { x: near.x, y: near.y }; // go back and look
for (let i = 0; i < 2; i++) tick(world, fog);
{
  const view = viewFor(world, fog, 0);
  check("a razed building we re-scout is forgotten", !view.buildings.some((b) => b.id === enemyTc.id));
  check("a still-standing enemy building we now see is shown", view.buildings.some((b) => b.id === enemyHouse.id));
}

console.log(pass ? "FOG-MEMORY: PASS ✅" : "FOG-MEMORY: FAIL ❌");
process.exit(pass ? 0 : 1);
