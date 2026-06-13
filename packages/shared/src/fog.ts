import { BUILDING_DEFS, UNIT_DEFS } from "./constants";
import { inBounds, tileIndex } from "./geometry";
import type { PlayerId, World } from "./types";

/**
 * Per-player fog of war.
 * - `visible`: tiles currently in sight of one of the player's entities.
 * - `explored`: tiles the player has ever seen (terrain is remembered).
 * Stored as flat Uint8Array (1 = set) indexed like map tiles.
 */
export interface Fog {
  width: number;
  height: number;
  visible: Map<PlayerId, Uint8Array>;
  explored: Map<PlayerId, Uint8Array>;
}

export function createFog(world: World): Fog {
  const { width, height } = world.map;
  const visible = new Map<PlayerId, Uint8Array>();
  const explored = new Map<PlayerId, Uint8Array>();
  for (const p of world.players) {
    visible.set(p.id, new Uint8Array(width * height));
    explored.set(p.id, new Uint8Array(width * height));
  }
  return { width, height, visible, explored };
}

function reveal(
  world: World,
  vis: Uint8Array,
  exp: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
): void {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
      if (!inBounds(world.map, x, y)) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) {
        const idx = tileIndex(world.map, x, y);
        vis[idx] = 1;
        exp[idx] = 1;
      }
    }
  }
}

/** Recompute current visibility for every player from their units and buildings. */
export function updateVision(world: World, fog: Fog): void {
  for (const p of world.players) {
    fog.visible.get(p.id)!.fill(0);
  }
  for (const u of world.units) {
    const vis = fog.visible.get(u.owner);
    const exp = fog.explored.get(u.owner);
    if (!vis || !exp) continue;
    reveal(world, vis, exp, u.pos.x, u.pos.y, UNIT_DEFS[u.type].sight);
  }
  for (const b of world.buildings) {
    const vis = fog.visible.get(b.owner);
    const exp = fog.explored.get(b.owner);
    if (!vis || !exp) continue;
    const def = BUILDING_DEFS[b.type];
    reveal(
      world,
      vis,
      exp,
      b.tile.x + def.size.w / 2,
      b.tile.y + def.size.h / 2,
      def.sight,
    );
  }
}

export function isVisible(fog: Fog, player: PlayerId, x: number, y: number): boolean {
  const vis = fog.visible.get(player);
  if (!vis) return false;
  if (x < 0 || y < 0 || x >= fog.width || y >= fog.height) return false;
  return vis[y * fog.width + x] === 1;
}

export function isExplored(fog: Fog, player: PlayerId, x: number, y: number): boolean {
  const exp = fog.explored.get(player);
  if (!exp) return false;
  if (x < 0 || y < 0 || x >= fog.width || y >= fog.height) return false;
  return exp[y * fog.width + x] === 1;
}

