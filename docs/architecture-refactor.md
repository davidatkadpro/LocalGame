# Architecture Refactor Plan — deepening the two giant modules

Five findings from the architecture review, turned into an actionable, sequenced
plan. The theme: the codebase is sound at the macro level (one authoritative
`World`, a shared sim, deterministic ticks, fog only at `viewFor`), but two
modules have grown to ~2000 lines each ([sim.ts](../packages/shared/src/sim.ts),
[PixiGame.ts](../packages/client/src/game/PixiGame.ts)) and the **same rules are
written twice** across the client↔server seam. Each item below turns a shallow,
spread, or duplicated concern into a single deep module with a small interface.

Legend — size: **S** ≈ <1h, **M** ≈ a few hours, **L** ≈ a day+. Architecture
terms (module / interface / seam / depth / locality / leverage / deletion test)
are used in the review sense.

## The recurring obstacle: `World` vs `Snapshot`

The server reasons over the full `World` (`world.resourceNodes`,
`world.buildings[].tile`, real `Unit`/`Building` objects). The client only has a
fogged, flattened `Snapshot` (`resources[].tx/ty`, `buildings[].tx/ty`). So every
rule we want to *share* must sit behind a **thin read-only view** that both can
adapt to — not behind `World` (the client doesn't have it) and not behind
`Snapshot` (the server doesn't build one for itself). Naming and minimizing that
view is the actual design work in items 1 and 2; the rest is mechanical.

---

## Sequencing (value × inverse-risk)

1. **Phase 1 — mechanical, immediate correctness, low blast radius:**
   §4 command-validity (move + make the type system guard it) and §1 placement
   rule (one copy, two adapters). Both kill a duplication/drift hazard and land
   real shared tests; neither changes runtime behaviour.
2. **Phase 2 — client testability:** §2 click-intent resolution. Behaviour-
   preserving extraction that gives PixiGame its first test coverage.
3. **Phase 3 — high value, high risk:** §3 combat consolidation. Touches the
   most load-bearing, most-tested sim code; do it last, guarded by the full suite.
4. **Phase 4 — optional:** §5 worker task lifecycle.

Each phase is independently shippable and nothing blocks the existing roadmap.

---

## §1 — One placement rule, not two copies — **M**

**Files.** [sim.ts `placementValid`](../packages/shared/src/sim.ts#L835),
[PixiGame.ts `clientPlacementValid`](../packages/client/src/game/PixiGame.ts#L1187),
new `packages/shared/src/placement.ts`.

**Problem.** "Can this building's footprint go on this tile?" is hand-written
twice — authoritatively in `placementValid(world, type, tile)` and again in
`clientPlacementValid(type, tx, ty)`, which mirrors it from snapshot data to draw
the green/red ghost. They check the same four things (in-bounds, not water/rock,
no resource node, no building overlap) with zero shared code. **Deletion test:**
delete the client copy and the rule concentrates in one place; today deleting it
just loses the preview because the rule was copied, not extracted. One real rule,
two call sites that *should* be adapters of it — but aren't.

**Solution.** Extract a pure module in `@bg/shared`:

```
// behind a thin view both sides can build
interface PlacementView {
  width: number; height: number;
  terrainAt(x, y): Terrain;
  hasResourceAt(x, y): boolean;
  buildings: Iterable<{ x; y; w; h }>;   // footprints
}
canPlaceBuilding(view: PlacementView, type: BuildingType, tile: Vec2): boolean
```

The sim builds a `PlacementView` over `World`; the client builds one over the
current `Snapshot`. `placementValid` becomes a one-line adapter; the renderer's
ghost calls `canPlaceBuilding` through a snapshot-backed view.

**Steps.**
1. Add `placement.ts` with `PlacementView` + `canPlaceBuilding` (footprint loop
   lifted verbatim from `placementValid`).
2. Re-express `placementValid` as a `World`→view adapter calling it.
3. Replace `clientPlacementValid` body with a `Snapshot`→view adapter.
4. Delete the duplicated geometry from PixiGame.

**Benefits.** *Locality* — the placement rule lives in exactly one file; the next
rule ("no placing on a unit", a new terrain) is one edit, not two. *Leverage* — a
tiny interface backs both authority and preview, and the ghost is guaranteed to
match the server by construction (no more "green ghost, server refuses"). *Tests*
— `scripts/placement.test.ts` exercises the rule directly (bounds, water/rock,
node overlap, building overlap, valid case); today the client copy is reachable
only by driving PixiJS, i.e. effectively untested.

---

## §2 — Pull click-intent resolution out of the renderer — **M**

**Files.** [PixiGame.ts `issueCommandAt`](../packages/client/src/game/PixiGame.ts#L1780)
(+ the tap branch in `handleTouchTap`/`onPointerUp`), new
`packages/shared/src/intent.ts` (or `packages/client/src/game/intent.ts` — see
note).

**Problem.** The richest behaviour on the client — "given my selection and a
clicked point, what `command` did the player mean?" — is a ~100-line priority
cascade (enemy unit → enemy building → animal → friendly foundation → garrison →
farm → resource node → move, each with its own radius and workers-only rules)
welded inside the Pixi input handler. It's pure game reasoning entangled with
sprites, camera, `sfx`, and `keys`. PixiGame is 2000 lines with **zero tests**,
and this is the part that most earns them.

**Solution.** Extract a pure function:

```
resolveOrder(
  ctx: { snapshot; me: PlayerId; isEnemy(owner): boolean },
  selection: { units: number[]; building: number | null },
  point: { x; y },
  modifiers: { queue: boolean },
): Command | null
```

It returns the intended `Command` (or `null` for "do nothing"). The renderer
keeps **gesture capture** (tap vs drag vs long-press, the 0.6-tile hit radii fed
in as the point) and **feedback** (it plays `sfx.attack()` / `sfx.command()`
based on the returned command's `c`). All the *meaning* moves into `resolveOrder`,
and the mouse and touch paths — which today duplicate the branching — call the
one function.

**Note on placement.** Both `Snapshot` and `Command` are `@bg/shared` types and
`resolveOrder` is pure, so `shared/src/intent.ts` is the natural home and makes it
trivially testable (and reusable by a future bot/AI). The only client-ism is `sfx`
— keep that in PixiGame, switching on the returned command. If we'd rather not
grow `shared` with a client concern, `client/src/game/intent.ts` is the
fallback; recommend `shared`.

**Steps.**
1. Add `intent.ts` with `resolveOrder`, porting the cascade verbatim
   (preserve radii, workers-only filters, the enemy-farm fall-through, shift-queue).
2. Replace `issueCommandAt`'s body with: `const cmd = resolveOrder(...); if (cmd)
   { playSfxFor(cmd); this.send(cmd); }`.
3. Route the touch tap branch through the same function (kills the duplicate
   branching).
4. `scripts/intent.test.ts` — a table of cases.

**Benefits.** *Leverage* — a tiny data-in/`Command`-out interface hides the whole
intent table; mouse and touch share one implementation. *Locality* — "what does a
click mean" lives in one file. *Tests* — the first real coverage of client
behaviour, as pure cases ("worker selected + click unfinished wall ⇒ construct",
"non-worker + click animal ⇒ move") with no PixiJS. **Deletion test:** delete it
and the cascade reappears, re-tangled, in two input branches.

---

## §3 — Consolidate combat into one deep system — **L** (highest risk)

**Files.** [sim.ts](../packages/shared/src/sim.ts) — `doAttack`, `tickTowers`,
`acquireTarget`, `nearestEnemyUnit`, `tryRetaliate`, `tryAcquireAggressive`,
`tryStandGround`, `resumeAggro`, plus the damage-stamping in the unit state
machine. New `packages/shared/src/combat.ts`.

**Problem.** Combat is spread across eight-plus functions interleaved with the
unit state machine. Target acquisition, range/leash rules, splash, retaliation
memory, stance behaviour, and the actual damage application each live somewhere
different; "how damage is dealt" exists once in `doAttack` and again in
`tickTowers`. Understanding one engagement means bouncing between idle-stance
handling, `doAttack`, and the tower loop — the classic shallow-spread shape (many
small functions, no single owner of "combat").

**Solution.** Draw a seam around combat in two pieces:
- `applyDamage(world, source, target)` — the **single** damage path (unit hit,
  tower hit, garrison-archer volley, splash all funnel through it; counters,
  upgrades, hit-stamp for retaliation, death/carcass handling live here once).
- `acquireTarget(world, unit, params)` — target selection parameterised by
  stance/leash, so aggressive / defensive / stand-ground / retaliation become
  *inputs* rather than four scattered branches.

`doAttack` and `tickTowers` keep their callers but delegate the damage step;
the idle-stance branches in `updateUnit` call the parameterised acquisition.

**Determinism is the hard constraint.** The sim is replay-deterministic and
heavily relied upon. The extraction must preserve **iteration order and
tie-breaking byte-for-byte** (nearest-then-id, the exact leash distances, the
splash enemy-only loop). This is a *refactor*, not a behaviour change.

**Steps (staged, each green before the next).**
1. Extract `applyDamage` first — purely mechanical; `doAttack`/`tickTowers` call
   it. Run the full suite; it must stay green.
2. Extract and parameterise `acquireTarget`; fold the stance branches into it.
3. Add a determinism guard: seed a fixed scenario, run N ticks, snapshot a hash
   of unit hp/positions, assert it's unchanged across the refactor.

**Benefits.** *Locality* — the next counter, leash tweak, or damage modifier
lands in one module instead of being threaded through the state machine and the
tower loop. *Leverage* — one damage path serves units, towers, garrison volleys,
and splash. *Tests* — the existing heavy suites (`counters`, `stances`, `m2`,
`m3`, `tc_arrows`) target a sharp interface instead of reaching through `tick()`,
and the new determinism guard protects every future combat edit.

---

## §4 — Make command validity a property of the protocol — **S**

**Files.** [room.ts `isValidCommand`](../packages/server/src/room.ts#L49),
[protocol.ts `Command`](../packages/shared/src/protocol.ts#L160),
new `validateCommand` exported from `@bg/shared`.

**Problem.** The untrusted-input trust boundary is a 110-line hand-written shape
guard in `room.ts`, physically separated from the `Command` union it guards (in
`shared/protocol.ts`) and from `applyCommand` that consumes it (in
`shared/sim.ts`). Nothing couples them: add a command variant, forget a `case`,
and it silently bypasses the boundary into the sim. The guard is shallow (its
complexity ≈ its surface) and sits the wrong distance from what it describes.

**Solution.** Move the guard next to the type as `validateCommand(cmd): cmd is
Command`, exported from `@bg/shared`, and write its `switch` so the compiler
enforces completeness:

```
switch (c.c) {
  ...every variant...
  default: { const _exhaustive: never = c.c; return false; }
}
```

Now "the messages **and** what counts as well-formed" is one module, and adding a
`Command` variant without a validation case is a **type error**, not a silent
hole. `room.ts` calls `validateCommand`; `index.ts` is unchanged.

**Steps.**
1. Move `isValidCommand` (+ `isNum`/`isIdList`/`isTile`) into `shared` beside
   `Command`; rename `validateCommand`; add the `never` exhaustiveness default.
2. Point `room.ts` at it; delete the local copy.
3. `scripts/protocol.test.ts` — a malformed case per variant + a valid case;
   the exhaustiveness check is enforced at compile time.

**Benefits.** *Locality* — the protocol owns both its shape and its validity.
*Leverage* — one guard at the seam protects every consumer of `Command`. *Tests*
— validity is unit-tested in `shared` where the rest of the rules live, and the
`never` default makes drift a build failure rather than a runtime exploit.

---

## §5 — Worker task lifecycle as an explicit module — **M** (optional)

**Files.** [sim.ts](../packages/shared/src/sim.ts) — `doGather`, `tryDeposit`,
`resumeGatherOrIdle`, `chainToNextWall`, and the `gather`/`construct` arms of
`applyCommand`.

**Problem.** A worker's loop (gather → return → deposit → resume same node / find
next → or chain to the next wall after a build) is scattered across four
functions plus two command arms. It works, but the flow has no single owner, so
"what a worker does next" is reconstructed by reading five places.

**Solution.** A small `workerTask` state module that owns the transitions (the
data is already on `Unit`: `state`, `carry`, `targetEntity`, remembered gather
node). Lower friction than §1–§4 — fold in only if §1–§3 prove the pattern worth
repeating.

**Benefits.** *Locality* for the economy loop; modest *leverage*. Listed for
completeness; not scheduled.

---

## Side effects to capture as we go

- **`CONTEXT.md`.** The review ran without a domain glossary. As these modules get
  names (`PlacementView`, `resolveOrder`/"order intent", the `combat` system),
  pin each term into a new `CONTEXT.md` so the next review speaks the same
  language.
- **ADR.** If we *decline* any item for a load-bearing reason (e.g. "keep combat
  spread because the state machine reads better inline"), record it as an ADR so a
  future review doesn't re-suggest it.

## Definition of done (per phase)

- `npm run typecheck` clean; the relevant `scripts/*.test.ts` suites green.
- No runtime behaviour change for §1, §2, §4 (pure extraction/relocation); §3
  guarded by the determinism hash.
- Each phase committed on its own (per the project's two-commit feature rollout);
  push only when asked.
