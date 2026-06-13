import type { GameMap, Vec2 } from "./types";

export function tileIndex(map: GameMap, x: number, y: number): number {
  return y * map.width + x;
}

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function floorVec(v: Vec2): Vec2 {
  return { x: Math.floor(v.x), y: Math.floor(v.y) };
}

export function tileCenter(x: number, y: number): Vec2 {
  return { x: x + 0.5, y: y + 0.5 };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Whether integer tile (x, y) lies within the rect at (rx, ry) of size rw×rh.
 *  The one true building-footprint test, shared by sim and client. */
export function rectContains(
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  x: number,
  y: number,
): boolean {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

