// Sim-level tests for 2v2 teams: ally detection, no friendly fire, shared
// vision, and last-team-standing win. Drives the sim directly via tsx.
import {
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  sameTeam,
  tick,
  viewFor,
} from "@bg/shared";

const PS4 = [
  { name: "A", color: "#e6492d", team: 0 },
  { name: "B", color: "#2d7fe6", team: 0 },
  { name: "C", color: "#27ae60", team: 1 },
  { name: "D", color: "#f1c40f", team: 1 },
];

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

// ---- 1. team membership -----------------------------------------------------
{
  const world = createWorld(11, PS4);
  check("teammates share a team", sameTeam(world, 0, 1));
  check("opponents are not allied", !sameTeam(world, 0, 2));
}

// ---- 2. no friendly fire: cannot damage an ally even if ordered -------------
{
  const world = createWorld(11, PS4);
  const fog = createFog(world);
  const sol = world.units.find((u) => u.owner === 0)!;
  const ally = world.units.find((u) => u.owner === 1)!;
  sol.type = "soldier";
  sol.hp = UNIT_DEFS.soldier.hp;
  sol.pos = { x: 30, y: 30 };
  ally.pos = { x: 30.6, y: 30 }; // adjacent
  world.units = [sol, ally];
  const allyHp0 = ally.hp;
  applyCommand(world, 0, { c: "attack", units: [sol.id], target: ally.id });
  for (let i = 0; i < 10; i++) tick(world, fog);
  check("an ally takes no damage from an attack order", ally.hp === allyHp0);
  check("the attacker drops the friendly target", sol.targetEntity === null);
}

// ---- 3. shared vision: a teammate's units are visible ----------------------
{
  const world = createWorld(11, PS4);
  const fog = createFog(world);
  tick(world, fog); // refresh vision
  const view = viewFor(world, fog, 0);
  check("ally (teammate) units are visible to me", view.units.some((u) => u.owner === 1));
  check("enemy units across the map are still hidden", !view.units.some((u) => u.owner === 2));
}

// ---- 4. last team standing wins --------------------------------------------
{
  const world = createWorld(11, PS4);
  const fog = createFog(world);
  // wipe out team 1 (players 2 and 3)
  world.buildings = world.buildings.filter((b) => b.owner !== 2 && b.owner !== 3);
  world.units = world.units.filter((u) => u.owner !== 2 && u.owner !== 3);
  tick(world, fog);
  check("both members of a wiped team are eliminated", !world.players[2].alive && !world.players[3].alive);
  check(
    "the surviving team wins (winner is a team-0 player)",
    world.winner !== null && world.players[world.winner].team === 0,
  );
  check("a teammate is still alive at the win", world.players[1].alive === true);
}

console.log(pass ? "TEAMS: PASS ✅" : "TEAMS: FAIL ❌");
process.exit(pass ? 0 : 1);
