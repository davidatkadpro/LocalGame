// Sim-level tests for the latest fixes: auto-retaliation (idle units fight back
// when attacked, but don't chase across the map or auto-aggro unprovoked) and
// formation moves (a group sent to one tile spreads into a block and every unit
// arrives instead of stacking/jamming). Drives the sim directly — no network.
import {
  UNIT_DEFS,
  applyCommand,
  createFog,
  createWorld,
  isWalkable,
  placementValid,
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

// ---- 1. auto-retaliation: an idle unit that is attacked fights back ---------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const def = world.units.find((u) => u.owner === 0)!; // our (idle) victim
  const atk = world.units.find((u) => u.owner === 1)!; // enemy attacker
  def.type = "soldier";
  def.hp = UNIT_DEFS.soldier.hp;
  atk.type = "soldier";
  atk.hp = UNIT_DEFS.soldier.hp;
  def.pos = { x: 20, y: 20 };
  atk.pos = { x: 20.7, y: 20 }; // within soldier range (0.8)
  def.state = "idle";
  def.path = [];
  world.units = [def, atk];

  // Enemy attacks our idle soldier; we never issue it an order.
  applyCommand(world, 1, { c: "attack", units: [atk.id], target: def.id });
  const atkHp0 = atk.hp;
  for (let i = 0; i < 12; i++) tick(world, fog);

  check("attacked idle unit switches to attacking", def.state === "attacking");
  check("retaliation targets the attacker", def.targetEntity === atk.id);
  const atkNow = world.units.find((u) => u.id === atk.id);
  check("victim deals damage back", !!atkNow && atkNow.hp < atkHp0, `atk hp ${atkHp0} -> ${atkNow?.hp}`);
}

// ---- 2. no unprovoked aggression: an idle unit next to a passive enemy ------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const mine = world.units.find((u) => u.owner === 0)!;
  const foe = world.units.find((u) => u.owner === 1)!;
  mine.type = "soldier";
  mine.hp = UNIT_DEFS.soldier.hp;
  mine.pos = { x: 24, y: 24 };
  mine.state = "idle";
  mine.path = [];
  foe.type = "soldier";
  foe.hp = UNIT_DEFS.soldier.hp;
  foe.pos = { x: 24.7, y: 24 }; // right next to us, but it never attacks
  foe.state = "idle";
  foe.path = [];
  world.units = [mine, foe];

  for (let i = 0; i < 12; i++) tick(world, fog);
  check("idle unit does not auto-aggro an un-attacking enemy", mine.state === "idle");
}

// ---- 3. formation move: a group sent to one tile spreads out and all arrive -
function findOpenBlock(world: ReturnType<typeof createWorld>, size: number): { x: number; y: number } | null {
  const occupied = (x: number, y: number) =>
    !isWalkable(world.map, x, y) ||
    world.resourceNodes.some((n) => n.tile.x === x && n.tile.y === y) ||
    world.buildings.some((b) => x >= b.tile.x - 1 && x <= b.tile.x + 4 && y >= b.tile.y - 1 && y <= b.tile.y + 4);
  for (let y = 4; y < world.map.height - size - 4; y++) {
    for (let x = 4; x < world.map.width - size - 4; x++) {
      let open = true;
      for (let dy = 0; dy < size && open; dy++)
        for (let dx = 0; dx < size; dx++) if (occupied(x + dx, y + dy)) { open = false; break; }
      if (open) return { x, y };
    }
  }
  return null;
}
{
  const world = createWorld(7, [PS[0]]); // single player -> no win-check interference
  const fog = createFog(world);
  const block = findOpenBlock(world, 10);
  if (!block) {
    console.log("FORMATION: SKIP (no open block on seed)");
  } else {
    const proto = world.units.find((u) => u.owner === 0)!;
    // Build 9 units laid out like a box-selected group (already ~1 tile apart).
    const units: typeof world.units = [];
    let id = world.nextEntityId;
    for (let k = 0; k < 9; k++) {
      units.push({
        ...proto,
        id: id++,
        pos: { x: block.x + 0.5 + (k % 3) * 1.0, y: block.y + 0.5 + Math.floor(k / 3) * 1.0 },
        state: "idle",
        path: [],
        targetEntity: null,
        targetTile: null,
      });
    }
    world.units = units;
    world.nextEntityId = id;

    // Send the whole group to a single tile near the far side of the block.
    const target = { x: block.x + 7, y: block.y + 7 };
    applyCommand(world, 0, { c: "move", units: units.map((u) => u.id), tile: target });
    for (let i = 0; i < 250; i++) tick(world, fog);

    const allIdle = units.every((u) => u.state === "idle");
    // distinct destinations: no two units share a tile, and they keep min spacing
    let minSep = Infinity;
    for (let i = 0; i < units.length; i++)
      for (let j = i + 1; j < units.length; j++)
        minSep = Math.min(minSep, Math.hypot(units[i].pos.x - units[j].pos.x, units[i].pos.y - units[j].pos.y));
    // every unit settled near the anchor (formation block, not scattered/stuck far off)
    const anchor = { x: target.x + 0.5, y: target.y + 0.5 };
    const maxDist = Math.max(...units.map((u) => Math.hypot(u.pos.x - anchor.x, u.pos.y - anchor.y)));

    check("formation: every unit reached a resting state (none jammed)", allIdle);
    check("formation: units spread out (no stacking)", minSep > 0.45, `minSep=${minSep.toFixed(2)}`);
    check("formation: whole group settled around the target", maxDist < 5, `maxDist=${maxDist.toFixed(2)}`);
  }
}

// ---- 4. economic-collapse lose condition (no food + no units) --------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  // Player 1 collapses: drain food to 0, remove their units (keep a building).
  world.players[1].resources.food = 0;
  world.units = world.units.filter((u) => u.owner !== 1);
  tick(world, fog);
  check("0 food + 0 units eliminates the player", world.players[1].alive === false);
  check("last player standing is declared the winner", world.winner === 0);
}
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  // Same, but a worker is queued (its food was already paid) -> NOT eliminated.
  world.players[1].resources.food = 0;
  world.units = world.units.filter((u) => u.owner !== 1);
  const tc = world.buildings.find((b) => b.owner === 1 && b.type === "town_center")!;
  tc.queue.push("worker");
  tc.produceTimer = UNIT_DEFS.worker.trainMs;
  tick(world, fog);
  check("a queued unit keeps a 0-food player alive", world.players[1].alive === true);
}

// ---- 4b. concede: resign eliminates a player even with a full base ----------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  applyCommand(world, 1, { c: "concede" });
  tick(world, fog);
  check("conceding eliminates the player", world.players[1].alive === false);
  check("concede hands the win to the survivor", world.winner === 0);
}

// ---- 5. workers auto-resume gathering after finishing a build --------------
{
  const world = createWorld(7, [PS[0]]);
  const fog = createFog(world);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // nearest wood node to the worker
  let node = world.resourceNodes.find((n) => n.kind === "wood")!;
  let best = Infinity;
  for (const n of world.resourceNodes) {
    if (n.kind !== "wood") continue;
    const d = Math.hypot(n.tile.x - worker.pos.x, n.tile.y - worker.pos.y);
    if (d < best) { best = d; node = n; }
  }
  applyCommand(world, 0, { c: "gather", units: [worker.id], node: node.id });
  for (let i = 0; i < 40; i++) tick(world, fog); // gather a bit
  check("worker records its gather node", worker.lastGatherNode === node.id);

  // find a valid 2x2 house spot near the worker
  let spot: { x: number; y: number } | null = null;
  for (let r = 2; r < 8 && !spot; r++)
    for (let dy = -r; dy <= r && !spot; dy++)
      for (let dx = -r; dx <= r && !spot; dx++) {
        const t = { x: Math.floor(worker.pos.x) + dx, y: Math.floor(worker.pos.y) + dy };
        if (placementValid(world, "house", t)) spot = t;
      }
  if (!spot) {
    console.log("AUTO-RESUME: SKIP (no house spot on seed)");
  } else {
    applyCommand(world, 0, { c: "build", unit: worker.id, building: "house", tile: spot });
    for (let i = 0; i < 400; i++) tick(world, fog);
    const house = world.buildings.find((b) => b.owner === 0 && b.type === "house");
    check("house finishes construction", !!house && house.progress >= 1);
    check(
      "worker auto-resumes its old node after building (not idle)",
      worker.state !== "idle" && worker.targetEntity === node.id,
      `state=${worker.state} target=${worker.targetEntity} node=${node.id}`,
    );
  }
}

// ---- 6. storehouse acts as a nearer drop-off than the town center ----------
{
  const world = createWorld(7, [PS[0]]);
  const fog = createFog(world);
  const tc = world.buildings.find((b) => b.owner === 0 && b.type === "town_center")!;
  const tcCenter = { x: tc.tile.x + 1.5, y: tc.tile.y + 1.5 };
  // the wood node farthest from the town center
  let node = world.resourceNodes.find((n) => n.kind === "wood")!;
  let far = -1;
  for (const n of world.resourceNodes) {
    if (n.kind !== "wood") continue;
    const d = Math.hypot(n.tile.x - tcCenter.x, n.tile.y - tcCenter.y);
    if (d > far) { far = d; node = n; }
  }
  // storehouse footprint just past the node, all tiles must be walkable
  const shTile = { x: node.tile.x + 2, y: node.tile.y };
  const shOk = [0, 1].every((dx) => [0, 1].every((dy) => isWalkable(world.map, shTile.x + dx, shTile.y + dy)));
  if (far < 12 || !shOk) {
    console.log("STOREHOUSE: SKIP (no suitable far node on seed)");
  } else {
    const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
    worker.pos = { x: node.tile.x + 1.5, y: node.tile.y + 0.5 };
    world.units = [worker];
    world.buildings.push({
      id: world.nextEntityId++,
      owner: 0,
      type: "storehouse",
      tile: shTile,
      hp: 250,
      progress: 1,
      queue: [],
      produceTimer: 0,
      rally: null,
      research: null,
      researchTimer: 0,
      attackCooldown: 0,
    });
    const woodStart = world.players[0].resources.wood;
    applyCommand(world, 0, { c: "gather", units: [worker.id], node: node.id });
    let minTcDist = Infinity;
    for (let i = 0; i < 150; i++) {
      tick(world, fog);
      minTcDist = Math.min(minTcDist, Math.hypot(worker.pos.x - tcCenter.x, worker.pos.y - tcCenter.y));
    }
    check("storehouse receives deposits (wood up)", world.players[0].resources.wood > woodStart);
    check("worker uses the nearer storehouse, not the town center", minTcDist > 8, `minTcDist=${minTcDist.toFixed(1)}`);
  }
}

// ---- 7. farms: build one, harvest renewable food, enemy can't steal it ------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // valid 2x2 farm spot near the worker
  let spot: { x: number; y: number } | null = null;
  for (let r = 2; r < 9 && !spot; r++)
    for (let dy = -r; dy <= r && !spot; dy++)
      for (let dx = -r; dx <= r && !spot; dx++) {
        const t = { x: Math.floor(worker.pos.x) + dx, y: Math.floor(worker.pos.y) + dy };
        if (placementValid(world, "farm", t)) spot = t;
      }
  if (!spot) {
    console.log("FARM: SKIP (no farm spot on seed)");
  } else {
    applyCommand(world, 0, { c: "build", unit: worker.id, building: "farm", tile: spot });
    for (let i = 0; i < 320; i++) tick(world, fog); // ~14s build + walk
    const farm = world.buildings.find((b) => b.owner === 0 && b.type === "farm");
    check("farm finishes construction", !!farm && farm.progress >= 1);
    check("farm spawns a hosted food node", !!farm && farm.farmNodeId != null);
    const node = world.resourceNodes.find((n) => n.id === farm!.farmNodeId);
    check("hosted node is owned food", !!node && node.kind === "food" && node.owner === 0);

    // enemy worker may NOT harvest our farm
    const enemy = world.units.find((u) => u.owner === 1 && u.type === "worker")!;
    applyCommand(world, 1, { c: "gather", units: [enemy.id], node: node!.id });
    check("enemy cannot target our farm node", enemy.targetEntity !== node!.id);

    // our worker harvests it -> food rises, node persists (renewable)
    const foodStart = world.players[0].resources.food;
    applyCommand(world, 0, { c: "gather", units: [worker.id], node: node!.id });
    for (let i = 0; i < 200; i++) tick(world, fog);
    check("farming yields food", world.players[0].resources.food > foodStart);
    check("farm node persists after harvest (renewable)", world.resourceNodes.some((n) => n.id === farm!.farmNodeId));
  }
}

// ---- 8. walls: one worker auto-chains a line, and walls block pathing -------
{
  const world = createWorld(7, [PS[0]]);
  const fog = createFog(world);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // a short run of open tiles for the wall line, near the worker
  const wx = Math.floor(worker.pos.x);
  const wy = Math.floor(worker.pos.y) - 3;
  const line = [0, 1, 2, 3].map((i) => ({ x: wx + i, y: wy }));
  const allPlaceable = line.every((t) => placementValid(world, "wall", t));
  if (!allPlaceable) {
    console.log("WALLS: SKIP (no open wall run on seed)");
  } else {
    // place the whole line (mirrors the client drag: one build cmd per tile)
    for (const t of line) applyCommand(world, 0, { c: "build", unit: worker.id, building: "wall", tile: t });
    check("a wall foundation is laid per tile", world.buildings.filter((b) => b.type === "wall").length === line.length);
    for (let i = 0; i < 400; i++) tick(world, fog);
    const walls = world.buildings.filter((b) => b.type === "wall");
    check("one worker auto-chains the whole line to completion", walls.length === line.length && walls.every((b) => b.progress >= 1));

    // walls block pathing: a path from one side to the other must detour around
    const blocked = (x: number, y: number) =>
      world.buildings.some((b) => b.type === "wall" && b.tile.x === x && b.tile.y === y);
    check("completed walls occupy their tiles", line.every((t) => blocked(t.x, t.y)));

    // destroying a wall removes it
    walls[0].hp = 0;
    tick(world, fog);
    check("a destroyed wall is removed", world.buildings.filter((b) => b.type === "wall").length === line.length - 1);
  }
}

// ---- 9. a player-issued attack is not mistaken for leashed retaliation ------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const atk = world.units.find((u) => u.owner === 0)!;
  const foe = world.units.find((u) => u.owner === 1)!;
  atk.type = "soldier"; atk.hp = UNIT_DEFS.soldier.hp; atk.pos = { x: 30, y: 30 };
  foe.type = "soldier"; foe.hp = UNIT_DEFS.soldier.hp; foe.pos = { x: 30.7, y: 30 };
  world.units = [atk, foe];
  applyCommand(world, 0, { c: "attack", units: [atk.id], target: foe.id });
  for (let i = 0; i < 8; i++) tick(world, fog); // they trade blows; foe hits back

  // foe has now damaged us (attackedBy points at the very target we're attacking),
  // but because the engagement is an explicit order it must NOT be flagged as
  // retaliation — otherwise the sight-leash would make us abandon the chase.
  check("explicit attacker recorded its attacker", atk.attackedBy === foe.id);
  check("explicit attack is not leashed as retaliation", atk.retaliating === false);
}

// ---- 10. match stats accumulate (scoreboard data) --------------------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // nearest node of any kind
  let node = world.resourceNodes[0];
  let best = Infinity;
  for (const n of world.resourceNodes) {
    const d = Math.hypot(n.tile.x - worker.pos.x, n.tile.y - worker.pos.y);
    if (d < best) { best = d; node = n; }
  }
  applyCommand(world, 0, { c: "gather", units: [worker.id], node: node.id });
  for (let i = 0; i < 250; i++) tick(world, fog); // a full gather->deposit cycle
  check("stats: resourcesGathered accrues on deposit", world.stats[0].resourcesGathered > 0, `g=${world.stats[0].resourcesGathered}`);
  check("stats: peakPop tracks starting pop", world.stats[0].peakPop >= 3);
}

// ---- 10b. rally onto a resource node -> new workers auto-gather ------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const tc = world.buildings.find((b) => b.owner === 0 && b.type === "town_center")!;
  // nearest wood node to the town center
  let node = world.resourceNodes.find((n) => n.kind === "wood")!;
  let best = Infinity;
  for (const n of world.resourceNodes) {
    if (n.kind !== "wood") continue;
    const d = Math.hypot(n.tile.x - tc.tile.x, n.tile.y - tc.tile.y);
    if (d < best) { best = d; node = n; }
  }
  applyCommand(world, 0, { c: "rally", building: tc.id, tile: { x: node.tile.x, y: node.tile.y } });
  // queue a worker and let it pop
  applyCommand(world, 0, { c: "train", building: tc.id, unit: "worker" });
  const beforeIds = new Set(world.units.map((u) => u.id));
  for (let i = 0; i < Math.ceil(UNIT_DEFS.worker.trainMs / 100) + 3; i++) tick(world, fog);
  const fresh = world.units.find((u) => u.owner === 0 && !beforeIds.has(u.id));
  check("a rallied worker spawns", !!fresh);
  check("rallied-to-node worker auto-targets the node", fresh?.targetEntity === node.id);
}

// ---- 10c. shift-queued commands append and advance -------------------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  const w = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  const A = { x: Math.floor(w.pos.x) + 1, y: Math.floor(w.pos.y) };
  const B = { x: Math.floor(w.pos.x) + 2, y: Math.floor(w.pos.y) };
  applyCommand(world, 0, { c: "move", units: [w.id], tile: A });
  applyCommand(world, 0, { c: "move", units: [w.id], tile: B, queue: true });
  check("queued order is appended, not replacing", w.orders.length === 1 && w.state === "moving");
  applyCommand(world, 0, { c: "move", units: [w.id], tile: A }); // fresh order wipes the queue
  check("an immediate command clears the queue", w.orders.length === 0);
  applyCommand(world, 0, { c: "move", units: [w.id], tile: B, queue: true });
  w.state = "idle";
  w.path = []; // simulate finishing the active order
  tick(world, fog);
  check(
    "an idle unit picks up its next queued order",
    w.orders.length === 0 && w.targetTile?.x === B.x && w.targetTile?.y === B.y,
  );
}

// ---- 11. eliminated players spectate with full vision ----------------------
{
  const world = createWorld(7, PS);
  const fog = createFog(world);
  applyCommand(world, 1, { c: "concede" });
  tick(world, fog);
  const view = viewFor(world, fog, 1);
  check("spectator snapshot marks me eliminated", view.me.alive === false);
  check("spectator sees the survivor's buildings (full reveal)", view.buildings.some((b) => b.owner === 0));
  check("snapshot carries every player's alive state", view.players.length === world.players.length);
}

// ---- 12. worker auto-advances to the next same-kind node when one runs out --
{
  const world = createWorld(7, [PS[0]]);
  const fog = createFog(world);
  const worker = world.units.find((u) => u.owner === 0 && u.type === "worker")!;
  // nearest wood node to the worker
  let node = world.resourceNodes.find((n) => n.kind === "wood")!;
  let best = Infinity;
  for (const n of world.resourceNodes) {
    if (n.kind !== "wood") continue;
    const d = Math.hypot(n.tile.x - worker.pos.x, n.tile.y - worker.pos.y);
    if (d < best) { best = d; node = n; }
  }
  const woodCount = world.resourceNodes.filter((n) => n.kind === "wood").length;
  if (woodCount < 2) {
    console.log("AUTO-ADVANCE: SKIP (need 2+ wood nodes on seed)");
  } else {
    node.amount = 8; // less than a full carry load -> depletes in one trip
    const firstId = node.id;
    applyCommand(world, 0, { c: "gather", units: [worker.id], node: node.id });
    for (let i = 0; i < 200; i++) tick(world, fog);
    check("the emptied node is removed", !world.resourceNodes.some((n) => n.id === firstId));
    const tgt =
      worker.targetEntity !== null
        ? world.resourceNodes.find((n) => n.id === worker.targetEntity)
        : null;
    check(
      "worker auto-advances to another wood node (not idle)",
      worker.state !== "idle" && !!tgt && tgt.kind === "wood" && tgt.id !== firstId,
      `state=${worker.state} target=${worker.targetEntity}`,
    );
  }
}

console.log(pass ? "M3: PASS ✅" : "M3: FAIL ❌");
process.exit(pass ? 0 : 1);
