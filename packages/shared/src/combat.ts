// The single damage path. "How a hit lands" used to be written out at four sites
// in the sim — unit melee/ranged, splash, the tower volley, the unit-vs-building
// line — each re-deriving counters, armor, and the retaliation stamp. They now
// funnel through `applyDamage`/`damageBuilding` so a counter tweak, a new armor
// rule, or a change to how a victim remembers its attacker is one edit, not four.
//
// Determinism note: the float arithmetic is kept identical to the inlined form
// (counter multiply, then `incomingDamage`, in that order) so replays are
// byte-for-byte unchanged. Multiplying by the `1` default for a counter-less
// source (a tower) is exact, so a tower shot reproduces the old value precisely.

import { damageMultiplier, incomingDamage } from "./constants";
import type { Building, EntityId, Unit, UnitType, World } from "./types";

/** How long an idle unit remembers who hit it (ms) — the retaliation window. */
export const RETALIATE_TTL_MS = 4000;

/** Options for a unit hit. `attackerType` applies the rock-paper-scissors counter
 *  multiplier; `sourceId` stamps the victim so an idle unit fights back. A tower
 *  shot passes neither: towers have no counter table and a unit can't retaliate
 *  against a building, so it leaves the victim's memory untouched. */
export interface DamageOpts {
  attackerType?: UnitType;
  sourceId?: EntityId;
}

/** Apply a hit to a unit — the one place a unit's hp drops to damage. Counter
 *  multiplier (if the source is a unit) → armor (`incomingDamage`) → retaliation
 *  stamp. Unit melee/ranged hits, siege splash, and tower/garrison volleys all
 *  funnel through here. */
export function applyDamage(
  world: World,
  target: Unit,
  baseDamage: number,
  opts: DamageOpts = {},
): void {
  const counter = opts.attackerType ? damageMultiplier(opts.attackerType, target.type) : 1;
  target.hp -= incomingDamage(world.players[target.owner], target.type, baseDamage * counter);
  if (opts.sourceId !== undefined) {
    target.attackedBy = opts.sourceId;
    target.attackedTtl = RETALIATE_TTL_MS;
  }
}

/** Apply a hit to a building — the one place a building's hp drops to an attack.
 *  Counter multiplier only: buildings have no armor upgrades and never retaliate,
 *  so there's no `incomingDamage` and no stamp. */
export function damageBuilding(target: Building, baseDamage: number, attackerType: UnitType): void {
  target.hp -= baseDamage * damageMultiplier(attackerType, "building");
}
