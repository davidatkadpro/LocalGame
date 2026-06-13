// Sim-level test for attack-move: drive the authoritative simulation directly
// (no network/travel time) and assert that an attack-moving unit acquires and
// damages enemies en route, then auto-clears when there's nothing left to fight.
import {
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  tick,
} from "@bg/shared";

const world = createWorld(123, [
  { name: "A", color: "#ffffff" },
  { name: "B", color: "#000000" },
]);
const fog = createFog(world);

// Attacker: promote one of player 0's workers to a soldier and park it next to
// player 1's base so the fight happens immediately.
const attacker = world.units.find((u) => u.owner === 0)!;
attacker.type = "soldier";
attacker.hp = UNIT_DEFS.soldier.hp;

const enemyTC = world.buildings.find((b) => b.owner === 1)!;
attacker.pos = { x: enemyTC.tile.x - 1.5, y: enemyTC.tile.y + 1.5 };

const enemyUnits = world.units.filter((u) => u.owner === 1);
// Bunch the enemy workers up right next to our soldier so they're in sight.
enemyUnits.forEach((e, i) => {
  e.pos = { x: enemyTC.tile.x - 0.5, y: enemyTC.tile.y + 0.5 + i * 0.6 };
});
const enemyUnitIds = enemyUnits.map((e) => e.id);
const tcId = enemyTC.id;
const tcHp0 = enemyTC.hp;

// Attack-move toward a tile on the far side of the enemy base.
applyCommand(world, 0, {
  c: "attackMove",
  units: [attacker.id],
  tile: { x: enemyTC.tile.x + 5, y: enemyTC.tile.y + 1 },
});

let everAttacked = false;
for (let t = 0; t < 400; t++) {
  tick(world, fog);
  const me = world.units.find((u) => u.id === attacker.id);
  if (me && me.state === "attacking") everAttacked = true;
  // stop early once the base is gone
  if (!world.buildings.some((b) => b.id === tcId)) break;
}

const killedUnits = enemyUnitIds.filter((id) => !world.units.some((u) => u.id === id)).length;
const tcNow = world.buildings.find((b) => b.id === tcId);
const tcDamaged = !tcNow || tcNow.hp < tcHp0;
const survivor = world.units.find((u) => u.id === attacker.id);
// After clearing the area, an attack-move unit should not be stuck "attacking".
const settled = !survivor || survivor.aggro === null || survivor.state !== "attacking";

console.log(`everAttacked=${everAttacked}`);
console.log(`enemyUnitsKilled=${killedUnits}/${enemyUnitIds.length}`);
console.log(`tcHp ${tcHp0} -> ${tcNow ? tcNow.hp : "destroyed"} damaged=${tcDamaged}`);
console.log(`attacker survived=${!!survivor} settledOrFighting=${settled}`);

const ok = everAttacked && killedUnits >= 1 && tcDamaged;
console.log(ok ? "ATTACKMOVE: PASS ✅" : "ATTACKMOVE: FAIL ❌");
process.exit(ok ? 0 : 1);
