# Context — domain glossary & the shared seams

The architecture review (see [architecture-refactor.md](architecture-refactor.md))
ran without a glossary, so reviewers and the code used different words for the
same things. This file pins the vocabulary: the domain terms, the deep modules
the refactor carved out, and the seams between them. When a term here names a
file or function, that's the single owner of the concept — change it there.

For the package/data-flow picture see [ARCHITECTURE.md](ARCHITECTURE.md); this
file is about *meaning*, not wiring.

## The recurring obstacle: `World` vs `Snapshot`

The server reasons over the full **`World`** — real `Unit`/`Building` objects,
`world.resourceNodes`, `world.buildings[].tile`. The client only ever holds a
fogged, flattened **`Snapshot`** — `resources[].tx/ty`, `buildings[].tx/ty`, no
hidden entities. So any rule we want to *share* across the client↔server seam
can't sit behind `World` (the client lacks it) or `Snapshot` (the server never
builds one for itself). It sits behind a **thin read-only view** both sides adapt
to. Minimizing that view is the real design work; everything else is mechanical.

## Architecture vocabulary (used in the review sense)

- **Module** — a unit of code behind an interface. **Deep** = small interface,
  lots of behaviour hidden; **shallow** = interface ≈ implementation (little
  hidden, low value).
- **Interface / Implementation** — what callers see vs. what's hidden.
- **Seam** — a deliberate boundary where two concerns meet through a small
  contract (e.g. a worker borrows pathfinding from the sim via `WorkerServices`).
- **Adapter** — thin glue that re-expresses one side's data as a shared view
  (e.g. `placementValid` adapts `World` into a `PlacementView`).
- **Leverage** — one small interface serving many call sites.
- **Locality** — a concept living in exactly one place, so the next change is one
  edit, not several.
- **Deletion test** — delete a copy of a rule; if the concept survives intact in
  one place, it was extracted. If it reappears re-tangled elsewhere, it was
  duplicated.

## The shared modules (deep modules carved out by the refactor)

### `placement.ts` — `PlacementView` / `canPlaceBuilding`
"Can this building's footprint go on this tile?" lives once. `PlacementView` is
the thin view (`width/height`, `terrainAt`, `hasResourceAt`, building footprints)
that both the sim (over `World`) and the client ghost (over `Snapshot`) build.
The green/red placement ghost is guaranteed to match server authority by
construction. (plan §1)

### `intent.ts` — `resolveOrder` / "order intent"
"Given my selection and a clicked point, what `Command` did the player mean?" —
the priority cascade (enemy unit → enemy building → animal → friendly foundation
→ garrison → farm → resource node → move, each with its hit radius and
workers-only rules). Pure: `resolveOrder(ctx, selection, point, modifiers) →
Command | null`. `OrderContext` carries `{ snapshot, me, isEnemy }`. The renderer
keeps only **gesture capture** (tap/drag/long-press, hit radii) and **feedback**
(`sfx` based on the returned command); mouse and touch share this one function.
(plan §2)

### `combat.ts` — the single damage path
`applyDamage(world, target, baseDamage, opts)` is the one place a unit's hp drops
to damage: counter multiplier (if the source is a unit) → armor (`incomingDamage`)
→ retaliation stamp. `damageBuilding` is the structure equivalent (counter only,
no armor/stamp). Unit melee/ranged, siege splash, tower volleys, and garrison
arrows all funnel through here. Target selection is `acquireTarget(world, u,
{ radius, includeBuildings })` — stance/leash are *inputs*, not scattered
branches. Float order and tie-breaking (nearest-then-id) are preserved
byte-for-byte; the **determinism guard** ([combat_determinism.test.ts](../scripts/combat_determinism.test.ts))
runs a fixed battle and asserts a baked hash. (plan §3)

### `worker.ts` — worker task lifecycle / `WorkerServices`
The economy state machine for one worker: gather → return → deposit → resume the
same node / seek the next; plus the build/repair detour and the dragged-wall
chain. `createWorkerSystem(services) → { doGather, tryDeposit, doBuild }` is the
sim's `updateUnit` entry point. **`WorkerServices`** is the seam — the *only*
thing the worker borrows from the sim is pathfinding (`pathToBuilding`,
`pathToTile`), because the sim owns building-blocker geometry. Everything else is
pure world reads, so the module is acyclic with `sim.ts`. (plan §5)

### `query.ts` — the shared leaf
Pure world reads both `sim.ts` and `worker.ts` depend on: entity `*ById` lookups,
`buildingNeedsWork`, `distToBuilding`, `distToTile`. This leaf is what keeps the
worker seam acyclic — the worker reads the world without importing the sim back.

### `validateCommand` (in `protocol.ts`)
The untrusted-input trust boundary lives next to the `Command` union it guards.
Its `switch` ends in a `never` exhaustiveness default, so adding a `Command`
variant without a validation case is a **compile error**, not a silent hole at
the server boundary. (plan §4)

## Determinism — the hard constraint

The sim is replay-deterministic: same seed + same commands ⇒ identical ticks. Any
change to combat or worker logic must preserve **iteration order and tie-breaking
byte-for-byte** (nearest-then-id, exact leash distances, splash enemy-only loops,
float operation order). Refactors that touch the sim are validated against the
determinism hash, which flips on a one-ulp difference.
