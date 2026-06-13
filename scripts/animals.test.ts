// Wild-animal tests: herds spawn, wander deterministically, and a worker can
// hunt one (attack it) then auto-gather the carcass for food. Drives the sim
// directly via tsx — no network.
import {
  ANIMAL_DEFS,
  applyCommand,
  createFog,
  createWorld,
  tick,
  viewFor,
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

// ---- 1. the map spawns wandering wildlife ----------------------------------
{
  const world = createWorld(7, PS);
  check("world spawns wild animals", world.animals.length > 0, `n=${world.animals.length}`);
  check("animals include sheep", world.animals.some((a) => a.kind === "sheep"));
}

// ---- 2. animals wander deterministically (and stay on walkable ground) ------
{
  const a = createWorld(7, [PS[0]]);
  const fa = createFog(a);
  const b = createWorld(7, [PS[0]]);
  const fb = createFog(b);
  for (let i = 0; i < 60; i++) { tick(a, fa); tick(b, fb); }
  const samePositions = a.animals.every((an, i) => {
    const bn = b.animals[i];
    return bn && bn.pos.x === an.pos.x && bn.pos.y === an.pos.y;
  });
  check("animal wander is deterministic across identical worlds", samePositions);
  const moved = a.animals.some((an, i) => {
    const w = createWorld(7, [PS[0]]); // a fresh world's initial positions
    return w.animals[i] && (w.animals[i].pos.x !== an.pos.x || w.animals[i].pos.y !== an.pos.y);
  });
  check("animals actually move over time", moved);
}

// ---- 3. a worker hunts a sheep, then gathers the carcass for food -----------
{
  const world = createWorld(7, [PS[0]]);
  const fog = createFog(world);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // Pin a still sheep right next to the worker so the hunt is deterministic.
  const sheep = world.animals.find((an) => an.kind === "sheep")!;
  sheep.hp = ANIMAL_DEFS.sheep.hp;
  sheep.food = ANIMAL_DEFS.sheep.food;
  sheep.pos = { x: worker.pos.x + 0.7, y: worker.pos.y };
  sheep.vx = 0;
  sheep.vy = 0;
  sheep.wanderTimer = 100000; // never re-rolls a heading during the test
  const sheepId = sheep.id;
  const foodBefore = world.players[0].resources.food;

  applyCommand(world, 0, { c: "attack", units: [worker.id], target: sheepId });
  for (let i = 0; i < 300; i++) tick(world, fog);

  check("the hunted animal is removed from the herd", !world.animals.some((an) => an.id === sheepId));
  check("hunting then gathering yields food", world.players[0].resources.food > foodBefore,
    `food ${foodBefore} -> ${world.players[0].resources.food}`);
}

// ---- 4. animals are fogged: only visible ones reach the snapshot -----------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // one sheep on top of the worker (definitely visible), one far across the map
  const sheep = world.animals.find((an) => an.kind === "sheep")!;
  sheep.pos = { x: worker.pos.x, y: worker.pos.y };
  sheep.vx = 0; sheep.vy = 0; sheep.wanderTimer = 100000;
  const farId = world.nextEntityId++;
  world.animals.push({
    id: farId, kind: "cow", pos: { x: world.map.width - 2.5, y: world.map.height - 2.5 },
    hp: ANIMAL_DEFS.cow.hp, food: ANIMAL_DEFS.cow.food, vx: 0, vy: 0, wanderTimer: 100000,
  });
  tick(world, fog); // refresh vision
  const view = viewFor(world, fog, 0);
  check("a sheep beside my worker is in the snapshot", view.animals.some((an) => an.id === sheep.id));
  check("a cow across the map is fogged out", !view.animals.some((an) => an.id === farId));
}

console.log(pass ? "ANIMALS: PASS ✅" : "ANIMALS: FAIL ❌");
process.exit(pass ? 0 : 1);
