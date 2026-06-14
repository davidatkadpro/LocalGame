// "Given my selection and a clicked point, what did the player mean?" — the
// click-intent cascade, lifted out of the Pixi input handler so it's pure game
// reasoning with no sprites, camera, sfx, or keyboard state. The renderer keeps
// gesture capture (tap vs drag, the hit radii) and feedback (which sound to play
// for the returned command); all the *meaning* lives here, shared by the mouse and
// touch paths and reusable by a future bot. Returns the intended `Command`, or
// `null` for "do nothing".

import { BUILDING_DEFS } from "./constants";
import { rectContains } from "./geometry";
import type { Command, Snapshot } from "./protocol";
import type { BuildingType, PlayerId, Vec2 } from "./types";

/** Read-only world the resolver reads, plus the team relation it can't derive
 *  from a `Snapshot` alone (alliances live in the store). */
export interface OrderContext {
  snapshot: Snapshot;
  me: PlayerId;
  /** Is `owner` an enemy of the local player? Self and allies are not. */
  isEnemy(owner: PlayerId): boolean;
}

/** The current selection: a set of unit ids and/or a single building. */
export interface OrderSelection {
  units: number[];
  building: number | null;
}

/** Click modifiers the resolver honours (Shift queues the order). */
export interface OrderModifiers {
  queue: boolean;
}

/** Ids of the selected units that are workers (only workers gather/build/hunt). */
function selectedWorkers(snap: Snapshot, units: number[]): number[] {
  return units.filter((id) => snap.units.find((u) => u.id === id)?.type === "worker");
}

/** Resolve a click into the command the player intended, or `null` for no-op.
 *  Mirrors the priority cascade the renderer used inline: enemy unit -> enemy
 *  building -> wild animal -> friendly work site -> garrison -> farm node ->
 *  resource node -> move. Workers-only branches fall through to a plain move when
 *  the selection has no workers, so the order is never silently dropped. */
export function resolveOrder(
  ctx: OrderContext,
  selection: OrderSelection,
  point: Vec2,
  modifiers: OrderModifiers,
): Command | null {
  const snap = ctx.snapshot;
  const me = ctx.me;
  const tx = Math.floor(point.x);
  const ty = Math.floor(point.y);

  // A selected building (no units) -> set its rally point.
  if (selection.units.length === 0) {
    if (selection.building !== null) {
      return { c: "rally", building: selection.building, tile: { x: tx, y: ty } };
    }
    return null;
  }
  const units = selection.units;
  const queue = modifiers.queue;

  // enemy unit? (allies in 2v2 are not valid targets)
  for (const u of snap.units) {
    if (ctx.isEnemy(u.owner) && Math.hypot(u.x - point.x, u.y - point.y) < 0.6) {
      return { c: "attack", units, target: u.id, queue };
    }
  }
  // enemy building?
  for (const b of snap.buildings) {
    const def = BUILDING_DEFS[b.type as BuildingType];
    if (ctx.isEnemy(b.owner) && rectContains(b.tx, b.ty, def.size.w, def.size.h, tx, ty)) {
      return { c: "attack", units, target: b.id, queue };
    }
  }
  // wild animal? -> send workers to hunt it (kill it, then auto-gather the
  // carcass). Only workers hunt; a worker-less selection falls through to move.
  for (const a of snap.animals) {
    if (Math.hypot(a.x - point.x, a.y - point.y) < 0.6) {
      const workers = selectedWorkers(snap, units);
      if (workers.length === 0) break;
      return { c: "attack", units: workers, target: a.id, queue };
    }
  }
  // friendly building that needs work — unfinished (finish it) or damaged
  // (repair it)? -> send workers. Both go through the `construct` command.
  for (const b of snap.buildings) {
    const def = BUILDING_DEFS[b.type as BuildingType];
    const needsWork = b.progress < 1 || b.hp < def.hp;
    if (b.owner === me && needsWork && rectContains(b.tx, b.ty, def.size.w, def.size.h, tx, ty)) {
      const workers = selectedWorkers(snap, units);
      if (workers.length > 0) {
        return { c: "construct", units: workers, building: b.id };
      }
    }
  }
  // friendly completed TC/tower? -> shelter the selected units inside it. A
  // damaged one is caught above first (workers repair under fire); everything
  // else garrisons. Garrisoned archers add arrows; eject from the build panel.
  for (const b of snap.buildings) {
    const def = BUILDING_DEFS[b.type as BuildingType];
    if (
      b.owner === me &&
      b.progress >= 1 &&
      (def.garrisonCap ?? 0) > 0 &&
      rectContains(b.tx, b.ty, def.size.w, def.size.h, tx, ty)
    ) {
      return { c: "garrison", units, building: b.id };
    }
  }
  // friendly completed farm? -> gather its hosted food node. The node sits on
  // a single tile under the 2x2 footprint (no crop sprite), so a tap anywhere
  // on the farm should assign workers — not just the exact node tile.
  for (const b of snap.buildings) {
    if (b.owner !== me || b.type !== "farm" || b.progress < 1) continue;
    const def = BUILDING_DEFS[b.type as BuildingType];
    if (!rectContains(b.tx, b.ty, def.size.w, def.size.h, tx, ty)) continue;
    const node = snap.resources.find(
      (n) => n.owner === me && rectContains(b.tx, b.ty, def.size.w, def.size.h, n.tx, n.ty),
    );
    if (!node) break;
    const workers = selectedWorkers(snap, units);
    if (workers.length === 0) break; // no workers selected -> fall through to move
    return { c: "gather", units: workers, node: node.id, queue };
  }
  // resource node? (skip enemy-owned farm nodes — the server would reject the
  // gather; fall through to a move so the order isn't silently dropped)
  for (const n of snap.resources) {
    if (n.tx === tx && n.ty === ty && (n.owner === undefined || n.owner === me)) {
      return { c: "gather", units, node: n.id, queue };
    }
  }
  // otherwise move
  return { c: "move", units, tile: { x: tx, y: ty }, queue };
}
