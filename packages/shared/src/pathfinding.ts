import { inBounds, tileIndex } from "./geometry";
import type { GameMap, Terrain, Vec2 } from "./types";

const IMPASSABLE: Set<Terrain> = new Set(["water", "rock"]);

export interface BlockedFn {
  (x: number, y: number): boolean;
}

export function isWalkable(map: GameMap, x: number, y: number): boolean {
  if (!inBounds(map, x, y)) return false;
  return !IMPASSABLE.has(map.tiles[tileIndex(map, x, y)]);
}

interface PQItem {
  idx: number;
  f: number;
}

/**
 * A* on the square grid (8-directional). Returns a list of tile-center
 * waypoints from start to goal (excluding the start tile), or [] if no path.
 * `extraBlocked` lets the caller mark building footprints as impassable.
 */
export function findPath(
  map: GameMap,
  start: Vec2,
  goal: Vec2,
  extraBlocked?: BlockedFn,
): Vec2[] {
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const gx = Math.floor(goal.x);
  const gy = Math.floor(goal.y);

  const blocked = (x: number, y: number) =>
    !isWalkable(map, x, y) || (extraBlocked ? extraBlocked(x, y) : false);

  if (blocked(gx, gy)) {
    // Goal blocked: pick nearest walkable neighbour as the real goal.
    const alt = nearestOpen(gx, gy, blocked);
    if (!alt) return [];
    return findPath(map, start, alt, extraBlocked);
  }
  if (sx === gx && sy === gy) return [];

  const w = map.width;
  const startIdx = sy * w + sx;
  const goalIdx = gy * w + gx;

  const open: PQItem[] = [{ idx: startIdx, f: 0 }];
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>([[startIdx, 0]]);
  const closed = new Set<number>();

  const h = (idx: number) => {
    const x = idx % w;
    const y = Math.floor(idx / w);
    const dx = Math.abs(x - gx);
    const dy = Math.abs(y - gy);
    // octile distance
    return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };

  const neighbours = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  let guard = 0;
  const maxIters = w * map.height * 2;
  while (open.length > 0 && guard++ < maxIters) {
    // pop lowest f (linear scan; map is small)
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const current = open.splice(bi, 1)[0].idx;
    if (current === goalIdx) return reconstruct(cameFrom, current, w);
    closed.add(current);

    const cx = current % w;
    const cy = Math.floor(current / w);
    for (const [dx, dy] of neighbours) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (blocked(nx, ny)) continue;
      // prevent cutting diagonally through a blocked corner
      if (dx !== 0 && dy !== 0) {
        if (blocked(cx + dx, cy) && blocked(cx, cy + dy)) continue;
      }
      const nIdx = ny * w + nx;
      if (closed.has(nIdx)) continue;
      const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      const tentative = (gScore.get(current) ?? Infinity) + step;
      if (tentative < (gScore.get(nIdx) ?? Infinity)) {
        cameFrom.set(nIdx, current);
        gScore.set(nIdx, tentative);
        const f = tentative + h(nIdx);
        const existing = open.find((o) => o.idx === nIdx);
        if (existing) existing.f = f;
        else open.push({ idx: nIdx, f });
      }
    }
  }
  return [];
}

function reconstruct(cameFrom: Map<number, number>, current: number, w: number): Vec2[] {
  const path: Vec2[] = [];
  let cur: number | undefined = current;
  while (cur !== undefined) {
    const x = cur % w;
    const y = Math.floor(cur / w);
    path.push({ x: x + 0.5, y: y + 0.5 });
    cur = cameFrom.get(cur);
  }
  path.reverse();
  path.shift(); // drop the start tile
  return path;
}

function nearestOpen(gx: number, gy: number, blocked: BlockedFn): Vec2 | null {
  for (let r = 1; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (!blocked(x, y)) return { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  return null;
}

