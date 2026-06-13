import { MAP_HEIGHT, MAP_WIDTH, RESOURCE_NODE_AMOUNT } from "./constants";
import { inBounds, tileIndex } from "./geometry";
import { createRng } from "./rng";
import type {
  EntityId,
  GameMap,
  ResourceKind,
  ResourceNode,
  Terrain,
  Vec2,
} from "./types";

export interface GeneratedMap {
  map: GameMap;
  resourceNodes: ResourceNode[];
  /** one spawn (town-center top-left tile) per player slot */
  spawns: Vec2[];
  nextEntityId: EntityId;
}

/** Player spawn positions spread around the map for the given player count. */
function spawnPoints(count: number, w: number, h: number): Vec2[] {
  const m = 8; // margin from edge
  const corners: Vec2[] = [
    { x: m, y: m },
    { x: w - m - 3, y: h - m - 3 },
    { x: w - m - 3, y: m },
    { x: m, y: h - m - 3 },
  ];
  return corners.slice(0, count);
}

export function generateMap(seed: number, playerCount: number): GeneratedMap {
  const rng = createRng(seed);
  const width = MAP_WIDTH;
  const height = MAP_HEIGHT;
  const tiles: Terrain[] = new Array(width * height).fill("grass");
  const map: GameMap = { width, height, tiles };

  // Scatter a few water ponds and rock outcrops as obstacles.
  const blobs = 14;
  for (let i = 0; i < blobs; i++) {
    const cx = rng.int(width);
    const cy = rng.int(height);
    const r = rng.range(1.5, 3.5);
    const kind: Terrain = rng.next() < 0.5 ? "water" : "rock";
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (!inBounds(map, x, y)) continue;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) tiles[tileIndex(map, x, y)] = kind;
      }
    }
  }

  const spawns = spawnPoints(playerCount, width, height);

  // Keep a clear, grass-only area around each spawn so the town center fits.
  for (const s of spawns) {
    for (let y = s.y - 3; y < s.y + 6; y++) {
      for (let x = s.x - 3; x < s.x + 6; x++) {
        if (inBounds(map, x, y)) tiles[tileIndex(map, x, y)] = "grass";
      }
    }
  }

  let nextEntityId = 1;
  const resourceNodes: ResourceNode[] = [];

  const placeNode = (x: number, y: number, kind: ResourceKind) => {
    if (!inBounds(map, x, y)) return;
    const idx = tileIndex(map, x, y);
    if (tiles[idx] === "water" || tiles[idx] === "rock") return;
    // don't stack nodes on the same tile
    if (resourceNodes.some((n) => n.tile.x === x && n.tile.y === y)) return;
    if (kind === "wood") tiles[idx] = "forest";
    resourceNodes.push({
      id: nextEntityId++,
      kind,
      tile: { x, y },
      amount: RESOURCE_NODE_AMOUNT[kind],
    });
  };

  // Keep scattered/grove resources out of each spawn's clear zone so a town
  // center never lands on a node and the opening stays uncluttered. Starter
  // resources are placed deliberately and bypass this.
  const nearSpawn = (x: number, y: number) =>
    spawns.some((s) => x >= s.x - 4 && x <= s.x + 7 && y >= s.y - 4 && y <= s.y + 7);

  // Starter resources next to each spawn so the early economy works immediately.
  for (const s of spawns) {
    for (let i = 0; i < 6; i++) placeNode(s.x + 4 + (i % 3), s.y - 2 + Math.floor(i / 3), "wood");
    placeNode(s.x - 2, s.y + 4, "gold");
    placeNode(s.x - 1, s.y + 5, "gold");
    placeNode(s.x + 5, s.y + 5, "food");
    placeNode(s.x + 6, s.y + 5, "food");
  }

  // Scatter extra resources across the map to fight over (denser than before).
  const scatter = Math.floor((width * height) / 50);
  for (let i = 0; i < scatter; i++) {
    const x = rng.int(width);
    const y = rng.int(height);
    if (nearSpawn(x, y)) continue;
    const roll = rng.next();
    const kind: ResourceKind = roll < 0.6 ? "wood" : roll < 0.82 ? "food" : "gold";
    placeNode(x, y, kind);
  }

  // Dense forests: roundish wood groves so the map reads as having real woods to
  // harvest and manoeuvre through (forest tiles are walkable), not just sparse
  // single trees. Gaps are left so a grove isn't a solid wall.
  const groves = 6;
  for (let i = 0; i < groves; i++) {
    const cx = rng.range(8, width - 8);
    const cy = rng.range(8, height - 8);
    const r = rng.range(2.2, 3.6);
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;
        if (nearSpawn(x, y)) continue;
        if (rng.next() < 0.28) continue; // ~72% of grove tiles get a tree
        placeNode(x, y, "wood");
      }
    }
  }

  // A handful of dense "resource sites" — clusters worth expanding to and
  // fighting over, rather than uniform scatter. Each is a single kind so a site
  // reads as "the gold patch", "the woods", etc.
  const sites = 5;
  for (let i = 0; i < sites; i++) {
    const cx = rng.range(10, width - 10);
    const cy = rng.range(10, height - 10);
    const roll = rng.next();
    const kind: ResourceKind = roll < 0.45 ? "wood" : roll < 0.75 ? "food" : "gold";
    const nodes = 4 + rng.int(3); // 4–6 nodes
    for (let n = 0; n < nodes; n++) {
      const x = Math.round(cx + rng.range(-2, 2));
      const y = Math.round(cy + rng.range(-2, 2));
      if (nearSpawn(x, y)) continue;
      placeNode(x, y, kind);
    }
  }

  return { map, resourceNodes, spawns, nextEntityId };
}

