// Local-avoidance regression: units ordered to swap positions must flow around
// each other instead of deadlocking (the old radial-separation bug, where two
// units meeting head-on just bounced back along their approach axis).
import { applyCommand, createFog, createWorld, isWalkable, tick } from "@bg/shared";

const PS = [{ name: "A", color: "#fff" }, { name: "B", color: "#000" }];
const world = createWorld(7, PS);
const fog = createFog(world);

// Find a clear horizontal corridor of walkable, building/resource-free tiles so
// the test exercises only unit-vs-unit avoidance, not terrain routing.
const occupied = (x: number, y: number) =>
  world.resourceNodes.some((n) => n.tile.x === x && n.tile.y === y) ||
  world.buildings.some((b) => x >= b.tile.x && x <= b.tile.x + 3 && y >= b.tile.y && y <= b.tile.y + 3);
function findLane(len: number): { y: number; x0: number } | null {
  for (let y = 2; y < world.map.height - 2; y++) {
    let run = 0;
    for (let x = 2; x < world.map.width - 2; x++) {
      if (isWalkable(world.map, x, y) && !occupied(x, y)) {
        if (++run >= len) return { y, x0: x - len + 1 };
      } else run = 0;
    }
  }
  return null;
}
const lane = findLane(8);
if (!lane) { console.log("AVOID: SKIP (no open lane on seed)"); process.exit(0); }

const mine = world.units.filter((u) => u.owner === 0).slice(0, 2);
world.units = mine;
const leftTile = { x: lane!.x0, y: lane!.y };
const rightTile = { x: lane!.x0 + 7, y: lane!.y };
mine[0].pos = { x: leftTile.x + 0.5, y: leftTile.y + 0.5 }; mine[0].state = "idle"; mine[0].path = [];
mine[1].pos = { x: rightTile.x + 0.5, y: rightTile.y + 0.5 }; mine[1].state = "idle"; mine[1].path = [];

// Swap them: each is sent to where the other stands (both tiles are walkable).
applyCommand(world, 0, { c: "move", units: [mine[0].id], tile: rightTile });
applyCommand(world, 0, { c: "move", units: [mine[1].id], tile: leftTile });

for (let i = 0; i < 200; i++) tick(world, fog);

const goalA = { x: rightTile.x + 0.5, y: rightTile.y + 0.5 };
const goalB = { x: leftTile.x + 0.5, y: leftTile.y + 0.5 };
const dA = Math.hypot(mine[0].pos.x - goalA.x, mine[0].pos.y - goalA.y);
const dB = Math.hypot(mine[1].pos.x - goalB.x, mine[1].pos.y - goalB.y);
console.log(`lane y=${lane!.y} x=${lane!.x0}..${lane!.x0 + 7}`);
console.log(`A dist=${dA.toFixed(2)} pos=(${mine[0].pos.x.toFixed(1)},${mine[0].pos.y.toFixed(1)})`);
console.log(`B dist=${dB.toFixed(2)} pos=(${mine[1].pos.x.toFixed(1)},${mine[1].pos.y.toFixed(1)})`);
const swapOk = dA < 1.0 && dB < 1.0;
console.log(swapOk ? "swap: ok (both passed each other and reached the goal)" : "swap: FAIL (deadlocked)");

// Scenario 2: two opposing columns must interpenetrate and reach the far side,
// not gridlock in the middle. Needs a taller open block.
const block = findLane(6); // reuse: find an open span; build a 4-tall column area
let groupOk = true;
if (block) {
  const w2 = createWorld(7, PS);
  const f2 = createFog(w2);
  const sq = w2.units.filter((u) => u.owner === 0).slice(0, 1)[0];
  // hand-build 8 units (4 left-moving, 4 right-moving) in the open block
  const baseY = block.y;
  const lefts: typeof w2.units = [];
  const rights: typeof w2.units = [];
  w2.units = [];
  let nextId = w2.nextEntityId;
  for (let k = 0; k < 4; k++) {
    const yy = baseY + k;
    if (!isWalkable(w2.map, block.x0, yy) || !isWalkable(w2.map, block.x0 + 5, yy)) continue;
    const L = { ...sq, id: nextId++, pos: { x: block.x0 + 0.5, y: yy + 0.5 }, state: "idle" as const, path: [] };
    const R = { ...sq, id: nextId++, pos: { x: block.x0 + 5.5, y: yy + 0.5 }, state: "idle" as const, path: [] };
    w2.units.push(L, R); lefts.push(L); rights.push(R);
  }
  for (const L of lefts) applyCommand(w2, 0, { c: "move", units: [L.id], tile: { x: block.x0 + 5, y: Math.floor(L.pos.y) } });
  for (const R of rights) applyCommand(w2, 0, { c: "move", units: [R.id], tile: { x: block.x0, y: Math.floor(R.pos.y) } });
  for (let i = 0; i < 300; i++) tick(w2, f2);
  // Every left-mover must end up on the right side and vice-versa (they crossed).
  const crossed = lefts.every((L) => L.pos.x > block.x0 + 3) && rights.every((R) => R.pos.x < block.x0 + 2.5);
  groupOk = crossed;
  console.log(`group: ${crossed ? "ok (columns interpenetrated)" : "FAIL (gridlocked in the middle)"} — left xs=${lefts.map((L) => L.pos.x.toFixed(1)).join(",")}`);
}

const ok = swapOk && groupOk;
console.log(ok ? "AVOID: PASS ✅" : "AVOID: FAIL ❌");
process.exit(ok ? 0 : 1);
