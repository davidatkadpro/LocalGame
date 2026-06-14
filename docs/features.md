# Additional Features & Fixes — Plan

A worked-through plan for the outstanding feedback list. Each item has a problem
statement, root-cause analysis (for bugs), a concrete solution grounded in the
current code, the files it touches, and a rough size. Ordered roughly by
value-for-effort within each group.

Legend — size: **S** ≈ <1h, **M** ≈ a few hours, **L** ≈ a day+.

---

## 1. Bugs

### 1.1 Units bump into each other and get stuck / glitch  — **L** ✅ Done (formation moves + progress-based stuck detection + avoidance tuning; `scripts/m3.test.ts`)

**Problem.** Crowds of units jitter, shove each other, and occasionally wedge so
a unit never reaches its goal.

**Root cause.** Movement is two uncoordinated passes per tick:

- [`stepAlongPath`](packages/shared/src/sim.ts#L609) follows the A* path, then
  applies a one-shot lateral `avoidanceSteer` nudge.
- [`resolveCollisions`](packages/shared/src/sim.ts#L713) then hard-pushes every
  overlapping pair apart with a spatial hash.

These fight each other: avoidance steers a unit sideways, collision shoves it
back, and the `stuck` counter ([`bumpStuck`](packages/shared/src/sim.ts#L515))
trips because net displacement is ~0. After `STUCK_LIMIT` (8 ticks) the unit
abandons its path ([sim.ts:573](packages/shared/src/sim.ts#L573)) and gives up
mid-journey — the "glitch". A* also ignores other units, so N units routed to
the same tile all pile onto one point.

**Solution (staged):**

1. **Stop dropping the path on stuck for normal moves.** Instead of going idle,
   *re-path* with a short random-ish (id-derived, deterministic) waypoint
   offset, and only give up after a much higher limit. Keeps units trying.
2. **Make collision the single source of truth for separation.** Reduce
   `avoidanceSteer` to a gentle pre-steer that does *not* run when the unit is
   within ~1.5 tiles of its final waypoint (so arrivals settle instead of
   orbiting). Lower `AVOID_STRENGTH` so it nudges rather than swaps sides.
3. **Formation move & stop (group cohesion).** When a `move` command targets N
   units, compute a formation: pick a destination *anchor* tile at the click,
   then assign each selected unit its own slot tile in a grid/ring around the
   anchor (ordered by current position so units keep their relative layout and
   don't cross paths). Each unit paths to its *own* slot in
   [`applyCommand`](packages/shared/src/sim.ts#L211) `case "move"` — so they
   spread into a block instead of all converging on one tile and shoving each
   other. The same slotting applies on arrival/stop, so a halted group settles
   into the formation rather than piling up. A simple helper
   `formationSlots(anchor, units)` keeps it deterministic.
4. **Don't count "blocked by an anchored gatherer" as stuck** — anchored units
   ([sim.ts:736](packages/shared/src/sim.ts#L736)) should be path-blockers that
   trigger a re-path, not a stuck increment.

**Files.** [sim.ts](packages/shared/src/sim.ts) (movement, collision, command
ingest), possibly [pathfinding.ts](packages/shared/src/pathfinding.ts) for a
"reserve goal tile" helper.

**Tests.** Extend [avoid.test.ts](scripts/avoid.test.ts): assert a 12-unit move
to a single tile leaves every unit within ε of its goal within K ticks and that
no unit ends `idle` short of its destination.

---

### 1.2 Touch: assigning a worker to a partially-built building doesn't work  — **M** ✅ Done (looser touch threshold + tap-foundation-with-workers issues construct)

**Problem.** On a tablet, selecting a worker then long-pressing a foundation
fails to send the worker to finish it.

**Root cause.** The construct path itself is correct
([issueCommandAt](packages/client/src/game/PixiGame.ts#L1029)) — it sends
`{ c: "construct" }`. The failure is in the *gesture*: on touch pointer-down a
single finger both starts a pan (`panLast` set,
[PixiGame.ts:767](packages/client/src/game/PixiGame.ts#L767)) and arms the
400 ms long-press. Any drift >5 px during the hold cancels the long-press via
[`onPointerMove`](packages/client/src/game/PixiGame.ts#L784) (finger tremor on a
held press is common), so it silently degrades to a pan and no command fires.
There is no fallback: a plain tap on your own building only *re-selects* it
([PixiGame.ts:842](packages/client/src/game/PixiGame.ts#L842)), it never issues a
construct.

**Solution:**

- **Loosen the long-press movement tolerance** to ~12–14 px and don't cancel on
  the first move event — cancel only once cumulative drift exceeds the threshold
  (debounce tremor).
- **Add an explicit, discoverable path.** When a worker is selected and the user
  taps a friendly foundation, treat it as a construct command (not a reselect) —
  i.e. in the tap branch
  ([PixiGame.ts:840-846](packages/client/src/game/PixiGame.ts#L840)), if the tap
  hits an *unfinished* own building and the current selection contains workers,
  call `issueCommandAt` instead of `selectSingle`.
- Give haptic/sfx confirmation so the user knows it registered.

**Files.** [PixiGame.ts](packages/client/src/game/PixiGame.ts) (`onPointerMove`,
`onPointerUp`, `beginLongPress`).

---

### 1.3 Minimap sometimes not updating for some users  — **M** ✅ Done (crash-proof rAF loop, single mount, DPR scaling)

**Problem.** A subset of users report a stale minimap.

**Analysis.** The draw loop is a self-perpetuating `requestAnimationFrame`
registered in a `useEffect` keyed on `[getViewport]`
([Minimap.tsx:21](packages/client/src/ui/Minimap.tsx#L21)). Two plausible causes:

1. **`getViewport` identity churn.** If the parent passes a freshly-created
   function each render, the effect tears down and re-creates the rAF loop
   constantly; a render that happens to unmount-without-remount (or an error in
   `draw`) leaves no live loop. A thrown exception inside `draw` kills the loop
   permanently (no try/catch, no re-arm).
2. **No DPR scaling.** The canvas backing store is a fixed `180×180`
   ([Minimap.tsx:94](packages/client/src/ui/Minimap.tsx#L94)) but CSS may scale
   it; on high-DPI tablets it looks blurry/"frozen" even while updating.

**Solution:**

- Wrap the body of `draw` in try/catch so one bad frame can't kill the loop, and
  re-`requestAnimationFrame` in a `finally`.
- Stop keying the effect on `getViewport`; store it in a ref and run the rAF loop
  once on mount (empty dep array). Eliminates teardown churn.
- Scale the backing store by `devicePixelRatio` and draw in CSS pixels.
- Add a cheap dirty-check log behind a debug flag to confirm fix with affected
  users.

**Files.** [Minimap.tsx](packages/client/src/ui/Minimap.tsx), and the
`getViewport` provider in [Game.tsx](packages/client/src/ui/Game.tsx) /
[PixiGame.ts](packages/client/src/game/PixiGame.ts).

---

### 1.4 Units don't fight back when attacked  — **M** ✅ Done (idle auto-retaliation, leashed to sight; `scripts/m3.test.ts`)

**Problem.** A unit standing `idle` (or even gathering) takes damage and just
stands there until it dies; you must manually order it to attack.

**Analysis.** Only attack-move units re-acquire targets
([`resumeAggro`](packages/shared/src/sim.ts#L921)); an `idle`/`moving`/`gathering`
unit has no auto-retaliation. There's no record of "who hit me", so a unit can't
know to retaliate.

**Solution — auto-retaliation:**

- When damage is dealt in [`doAttack`](packages/shared/src/sim.ts#L874) and
  [`tickTowers`](packages/shared/src/sim.ts#L489), stamp the victim with its
  attacker's id (a new `Unit.attackedBy` / cooldown, cleared after a few
  seconds).
- Each tick, an `idle` military unit (or any unit with no active order) that has
  a live, in-range-ish `attackedBy` switches to `attacking` that foe, then
  returns to idle when the threat is gone/dead. Workers should flee or only
  retaliate weakly (configurable) so the economy doesn't suicide into soldiers.
- Keep it deterministic (no RNG) and bounded (don't chase across the map — drop
  retaliation if the attacker leaves sight, so units don't wander off).

**Files.** [types.ts](packages/shared/src/types.ts) (victim→attacker field),
[sim.ts](packages/shared/src/sim.ts) (damage stamping + an idle-retaliation
check in `updateUnit`).
**Tests.** Sim test: park an idle soldier next to an enemy, have the enemy hit
it, assert it engages back within a tick or two and disengages when the enemy
dies/leaves.

---

## 2. Balance

### 2.1 Guard towers are a little too powerful  — **S** ✅ Done (10 dmg / range 5 / 1000ms)

**Problem.** Towers dominate engagements.

**Analysis.** Current tower stats:
`attack: { damage: 16, range: 6, attackMs: 800 }`
([constants.ts:156](packages/shared/src/constants.ts#L156)) — that's ~20 dps at
range 6, out-ranging archers (range 5) and out-damaging a soldier (13 dmg /
1000 ms). Combined with 500 hp and sight 8 it wins too easily.

**Solution.** Re-tune in [constants.ts](packages/shared/src/constants.ts#L146):
drop damage to ~10, range to 5 (so massed archers can trade), and lengthen
`attackMs` to ~1000. Optionally raise cost slightly. Pure data change — no logic.

**Files.** [constants.ts](packages/shared/src/constants.ts).
**Tests.** Update expectations in [m2.test.ts](scripts/m2.test.ts) tower-combat
assertions.

---

### 2.2 More resources on the map  — **S** ✅ Done (denser scatter /60, +5 cluster sites, richer nodes)

**Problem.** Maps feel resource-thin; expansion isn't rewarding.

**Analysis.** Scatter density is
`Math.floor((width*height)/90)` ≈ 45 nodes on a 64×64 map
([map.ts:96](packages/shared/src/map.ts#L96)), plus a fixed starter cluster.

**Solution.** Lower the divisor (e.g. `/60`) for more scattered nodes, and/or
seed a few denser "resource sites" (a small cluster of 3–5 nodes) so there are
worthwhile contested spots rather than uniform scatter. Optionally bump
`RESOURCE_NODE_AMOUNT` ([constants.ts:221](packages/shared/src/constants.ts#L221))
so nodes last longer. Data/gen-only change; map stays seed-reproducible.

**Files.** [map.ts](packages/shared/src/map.ts),
[constants.ts](packages/shared/src/constants.ts).

---

### 2.3 New lose condition: economic collapse (no food + no units)  — **S** ✅ Done (`updateWinState`; `scripts/m3.test.ts`)

**Problem.** Today a player is only eliminated when they have **no buildings**
([`updateWinState`](packages/shared/src/sim.ts#L951)). A player can be left with
a town center but 0 food and 0 units — an unrecoverable state, since *every* unit
costs food to train (worker 50, archer 40, soldier 60), so they can never gather
again. The game stalls instead of ending.

**Solution.** Add a second elimination rule in `updateWinState`: a living player
is eliminated when **food = 0 AND they have no units** — they can't train
anything, so they can't recover. Guards against false positives:

- **Don't eliminate if a building still has a queued unit** — that unit's food
  was already paid ([train](packages/shared/src/sim.ts#L286)); it will pop and
  give them a worker. Only collapse when `food === 0`, zero units, *and* every
  building's `queue` is empty.
- A unit carrying food in transit means `units > 0`, so the "no units" check
  already prevents eliminating someone with a worker still walking home.
- Optional softening: trigger at `food < cheapest unit cost` (40) rather than
  strictly 0, since <40 food with no income is equally dead. Recommend keeping
  the strict `=== 0` first; revisit if playtests show stalls just above 0.

This composes with the existing no-buildings rule and feeds the same
last-player-standing `winner` check, so no protocol change is needed.

**Files.** [sim.ts](packages/shared/src/sim.ts) (`updateWinState`).
**Tests.** Sim test: a player reduced to 0 food, 0 units, empty queues is marked
`!alive` and the surviving player is declared `winner`; a player with 0 food but
a queued worker is **not** eliminated.

---

## 3. New features

### 3.1 Farms for food production  — **M** ✅ Done (Farm hosts an owned, regenerating food node workers harvest; `scripts/m3.test.ts`)

**Problem.** Food is finite (bushes deplete); no renewable food economy.

**Design.** A **Farm** building that a worker harvests like a resource node but
that does not move and provides a steady, long-lived (or infinite, slowly
yielding) food supply.

**Recommended approach — "farm is a building that hosts a resource node":**
on construction-complete, spawn a co-located `food` resource node with a large
amount (e.g. 400, or auto-replenishing). Workers already know how to gather
nodes and deposit, so the gather/return loop is reused with zero new unit logic.
Replenish by topping the node's `amount` back up over time in the tick (capped),
giving the renewable feel without unbounded food.

- New `BuildingType: "farm"` in [types.ts](packages/shared/src/types.ts) +
  [BUILDING_DEFS](packages/shared/src/constants.ts#L107) (small, cheap, wood
  cost, `buildable: true`, `isDropOff: false`).
- On build-complete in [`doBuild`](packages/shared/src/sim.ts#L852) (or a hook in
  `tick`), create/attach the food node and register a slow replenish.
- Sprite: add `farm.svg` + accent, wire into
  [assets.ts](packages/client/src/game/assets.ts).
- HUD build button + ghost placement already generic over `buildable` buildings.

**Files.** [types.ts](packages/shared/src/types.ts),
[constants.ts](packages/shared/src/constants.ts),
[sim.ts](packages/shared/src/sim.ts), client assets +
[Hud.tsx](packages/client/src/ui/Hud.tsx).
**Tests.** New sim test: build a farm, assign a worker, assert food income is
sustained and replenish caps correctly.

---

### 3.2 Build walls  — **L** ✅ Done (1×1 Wall, drag-to-place a line, one worker auto-chains the run; `scripts/m3.test.ts`)

**Problem.** No way to fortify a base.

**Design.** A 1×1 **Wall** building: cheap, high-ish hp, blocks pathing, trains
nothing. Pathing already treats every building footprint as blocked
([buildingBlocker](packages/shared/src/sim.ts#L143)), so a wall obstructs units
for free once placed.

**Key work is placement UX, not sim:**

- New `BuildingType: "wall"` ([types.ts](packages/shared/src/types.ts),
  [BUILDING_DEFS](packages/shared/src/constants.ts#L107): `size {1,1}`,
  `buildable: true`, low `buildMs`).
- **Drag-to-build a line of walls:** extend placement in
  [PixiGame.ts](packages/client/src/game/PixiGame.ts#L1067) so dragging while the
  wall ghost is active previews and places a row of segments (one `build` command
  per tile, each validated/paid via existing
  [`placementValid`](packages/shared/src/sim.ts#L410) + cost checks). Without
  this, walling is tediously one-tile-at-a-time.
- Auto-connecting sprites (straight/corner) are a nice-to-have; ship plain
  segments first.
- **Watch out:** walls can trap your own units or fully enclose an enemy —
  acceptable, but make sure 1.1's re-path logic handles a wall dropped onto a
  unit's path gracefully.

**Files.** [types.ts](packages/shared/src/types.ts),
[constants.ts](packages/shared/src/constants.ts),
[PixiGame.ts](packages/client/src/game/PixiGame.ts) (drag placement), assets,
[Hud.tsx](packages/client/src/ui/Hud.tsx).

---

### 3.3 Multi-select soldiers on tablet (long-press drag-box)  — **M** ✅ Done (HUD-armed box-select + double-tap-to-select-by-type)

**Problem.** On touch there's no box-select; one finger pans and long-press
issues a command ([onPointerDown](packages/client/src/game/PixiGame.ts#L759)).
Box-select only exists for mouse drag
([onPointerUp](packages/client/src/game/PixiGame.ts#L817)).

**Solution — a "select mode" gesture:** add a HUD toggle (a marquee-select
button) that flips touch single-finger drag from pan to box-select for the next
drag, reusing [`boxSelect`](packages/client/src/game/PixiGame.ts#L984) and
[`drawBox`](packages/client/src/game/PixiGame.ts#L900). This is more reliable on
tablets than overloading long-press-then-drag (which conflicts with the existing
long-press-to-command and with panning).

- Alternative/adjunct: **double-tap a unit to select all same-type units on
  screen** (the AoE "select all of type" idiom) — cheap and very tablet-friendly
  for "grab all my soldiers".
- Recommend shipping the HUD select-mode toggle **and** double-tap-select-type;
  together they cover the use case without a fragile gesture.

**Files.** [PixiGame.ts](packages/client/src/game/PixiGame.ts) (pointer
handlers, a `selectMode` flag), [Hud.tsx](packages/client/src/ui/Hud.tsx)
(toggle button), [styles.css](packages/client/src/ui/styles.css).

---

## 4. UX

### 4.1 Dismissable controls dialog  — **S** ✅ Done (× to hide, ? to reopen, persisted in localStorage)

**Problem.** The Controls panel
([Hud.tsx:104](packages/client/src/ui/Hud.tsx#L104)) is always on screen and
can't be closed — it eats space, especially on tablets.

**Solution.** Add a close (×) button on the panel header that hides it, and
persist the dismissed state in `localStorage` so it stays closed across reloads.
Provide a small "?" button (or a key, e.g. `H`) to reopen it. Pure client/UI.

**Files.** [Hud.tsx](packages/client/src/ui/Hud.tsx),
[styles.css](packages/client/src/ui/styles.css).

---

### 4.2 Invisible bar across the bottom swallows clicks  — **S** ✅ Done (pointer-events: none on HUD containers)

**Problem.** Along the bottom of the screen there's a horizontal band where the
map is visible but unselectable/unclickable — as if an invisible bar covers it.

**Root cause.** The `.hud-bottom` container is positioned `left:10px; right:10px`
([styles.css:190](packages/client/src/ui/styles.css#L190)) so it spans almost
the full width, and as a flex box its hit area is as tall as the tallest panel.
Only the panels are *painted*, but the transparent gaps — and the entire strip
to the left of the panels — still belong to that `<div>`, which sits above the
Pixi canvas and intercepts pointer events. So clicks anywhere along that bottom
band hit the empty HUD container instead of the canvas. `.hud-top` has the same
latent issue.

**Solution.** Make the HUD containers transparent to input and re-enable it only
on the real controls:

```css
.hud-bottom, .hud-top { pointer-events: none; }
.hud-bottom .panel, .hud-top > * , .minimap, .hud-bottom button { pointer-events: auto; }
```

One-line-ish CSS fix, no layout change.

**Files.** [styles.css](packages/client/src/ui/styles.css).

---

## 5. Proposed additions (beyond the original list)

### 5.1 Drop-off buildings (storehouse / mill)  — **M** ✅ Done (Storehouse: 2×2, 60 wood, `isDropOff`; reuses `nearestDropOff`; `scripts/m3.test.ts`)

**Problem.** Only the `town_center` is a drop-off
([constants.ts:117](packages/shared/src/constants.ts#L117)), so workers at a far
resource patch walk all the way home every trip — expanding outward isn't worth
it.

**Solution.** A cheap **Storehouse** building with `isDropOff: true`, small
footprint, no production. The gather loop already routes to the *nearest*
drop-off ([`nearestDropOff`](packages/shared/src/sim.ts#L156)), so dropping one
near a resource patch immediately shortens the haul with zero new unit logic.
Pairs naturally with 2.2 (more resources) and 3.1 (farms).

**Files.** [types.ts](packages/shared/src/types.ts),
[constants.ts](packages/shared/src/constants.ts), client assets,
[Hud.tsx](packages/client/src/ui/Hud.tsx).

### 5.2 "Under attack" alert + minimap ping  — **M** ✅ Done (off-screen damage → throttled minimap ping + klaxon)

**Problem.** No way to tell your base is being hit while the camera is elsewhere
on the 64×64 map.

**Solution.** When one of your entities takes damage (off-screen), flash a
minimap ping at that location and play an alert (the audio system already
exists). Throttle to one alert per area every few seconds. The client can derive
"my entity lost hp since last snapshot" from the snapshot stream, or the server
can flag it explicitly.

**Files.** [Minimap.tsx](packages/client/src/ui/Minimap.tsx),
[audio.ts](packages/client/src/game/audio.ts),
[store.ts](packages/client/src/net/store.ts) (optionally a server flag in
[protocol.ts](packages/shared/src/protocol.ts)).

### 5.3 Workers auto-resume after construction  — **S** ✅ Done (resume last gather node if it still has resources; `scripts/m3.test.ts`)

**Problem.** A worker goes `idle` the moment it finishes a building
([`doBuild`](packages/shared/src/sim.ts#L867)), so you must re-task it by hand
every time.

**Solution.** Remember the worker's prior gather target and resume it after the
build completes; if none, send it to the nearest resource node (or just leave
idle — make it a small, explicit rule). Related QoL: let a building's **rally
point target a resource node** so newly-trained workers auto-gather.

**Files.** [sim.ts](packages/shared/src/sim.ts) (`doBuild`, spawn rally),
[types.ts](packages/shared/src/types.ts) (remembered gather target).

---

## 6. Backlog (lower priority / nice-to-have)

- **Combat roles / counters** (**M**) — soldier, archer, worker all trade raw
  damage, so the archer has no identity. A light rock-paper-scissors (archers
  bonus vs infantry, soldiers bonus vs buildings) via the existing
  [`unitDamage`](packages/shared/src/constants.ts#L208)/`incomingDamage` helpers
  would make army composition matter.
- **Concede + spectate** (**S**) — a surrender command and the ability to keep
  watching after elimination ([`updateWinState`](packages/shared/src/sim.ts#L951)).
- **Performance ceiling (note, not a task)** — several systems use O(n) `.find`
  lookups per entity per tick; fine at the 50-pop × 4-player cap, but if entity
  counts ever grow, index units/buildings by id in a `Map`.

---

## Suggested sequencing

1. **Quick wins first:** 4.2 invisible-bottom-bar fix, 2.1 tower nerf, 2.2 more
   resources, 2.3 economic-collapse lose condition, 4.1 dismissable controls,
   5.3 worker auto-resume (all **S**, data/UI/rules only, immediately felt).
2. **Tablet correctness:** 1.2 touch-construct fix, then 3.3 touch multi-select
   (same input code, do together).
3. **Combat feel:** 1.4 auto-retaliation, 5.2 under-attack alert (so fights you
   don't initiate aren't silent losses).
4. **Minimap:** 1.3 — needs a quick round-trip with an affected user to confirm.
5. **The big one:** 1.1 unit-stuck movement + formation rework — highest value,
   highest risk; land it before 3.2 walls (which stresses pathing the same way).
6. **Content:** 5.1 storehouse drop-off, 3.1 farms, then 3.2 walls.
7. **Backlog (§6)** as time allows.

Each item is independently shippable; nothing here blocks on the packaged
desktop host still tracked in [PLAN.md](docs/PLAN.md).

---

## 7. Roadmap — AoE-direction expansion (new features tracker)

Forward-looking ideas to grow the game toward the Age-of-Empires feel. Unlike
§1–6 (mostly shipped), these are **not started** unless marked otherwise. Status
legend: 🆕 brand new · 🔨 expand something we already have · ✅ shipped.

**Where we are today (baseline).** Worth knowing before expanding:

- **Units:** `worker`, `soldier`, `archer`, `ram` (siege). Counters with
  building bonuses live in [COUNTERS](packages/shared/src/constants.ts#L297)
  (ram ×5 vs buildings, archer bonus vs infantry, etc.).
- **Buildings:** `town_center`, `house`, `barracks`, `tower`, `storehouse`
  (drop-off), `farm`, `wall`, `siege_workshop`.
- **Resources:** `wood`, `food`, `gold` (3). Food from bushes, farms, and hunted
  animals (sheep/cow → meat carcass).
- **Tech:** a working research system with three flat upgrades —
  `improvedTools`, `sharpenedBlades`, `paddedArmor`
  ([UpgradeId](packages/shared/src/types.ts#L23)).
- **Systems:** fog/teams, leaderboard, repair/demolish, under-attack alerts +
  minimap pings (§5.2 ✅), stop/H/double-click QoL, resource-depletion visuals.

### 7.1 Ages (Dark → Feudal → Imperial)  — 🆕 **L** — ✅ done

Research an age-up at the Town Center (food+gold, takes time). Each age gates
buildings/units/tech and grants small global stat bumps. Most items below become
"things you unlock per age," so this is the highest-leverage single feature.

**Add.** Per-player `age` + a research/timer state; age-gates on build/train/
research; an age banner in the HUD; age-up command + cost.
**Files.** [types.ts](packages/shared/src/types.ts),
[constants.ts](packages/shared/src/constants.ts),
[sim.ts](packages/shared/src/sim.ts),
[protocol.ts](packages/shared/src/protocol.ts),
[Hud.tsx](packages/client/src/ui/Hud.tsx).
**Status.** Shipped as **3 ages** (Dark/Feudal/Imperial) with **tiered unlocks
that reshape the opening**: Dark = eco only; Feudal = barracks/tower/soldier/
archer + combat upgrades; Imperial = siege workshop/ram. Advancing is issued at
the Town Center, needs a **prerequisite building** (storehouse/farm → Feudal,
barracks → Imperial) plus a food/gold cost and a timed bar. **Balanced bonuses**
apply live via the stat helpers (+gather, +military damage, −damage taken, +pop
headroom that also lifts the hard cap). `minAge` tags gate build/train/research
in `applyCommand`; the HUD shows an age badge, an Advance-Age button + progress,
and 🔒 hints on locked items. Covered by `scripts/ages.test.ts`; ratios re-pinned
in `scripts/balance.test.ts`. Remaining §7 items now slot in as per-age unlocks.

### 7.2 Specialised drop-off camps (Lumber / Mining / Mill)  — 🔨 **M**

**Have today.** One generic `storehouse` drop-off; gather loop already routes to
the nearest drop-off ([nearestDropOff](packages/shared/src/sim.ts#L156)).
**Add.** Resource-specific camps that also grant a small gather-rate bonus for
their resource, so placement is a real eco decision (AoE's Lumber/Mining Camp +
Mill). Reuses the drop-off routing; mostly new building defs + a per-kind bonus
in the gather tick.
**Files.** [constants.ts](packages/shared/src/constants.ts),
[sim.ts](packages/shared/src/sim.ts), assets, [Hud.tsx](packages/client/src/ui/Hud.tsx).

### 7.3 Blacksmith + tiered tech tree  — 🔨 **M**

**Have today.** Three flat upgrades researched (likely at the TC).
**Add.** A dedicated **Blacksmith** building and a *tiered*, age-gated tree
(attack I/II/III, armor I/II/III, plus economy techs: faster gather, +farm
yield, +worker carry). Generalises the existing `UpgradeId` enum + research
command into levelled lines.
**Files.** [types.ts](packages/shared/src/types.ts) (`UpgradeId` lines),
[constants.ts](packages/shared/src/constants.ts),
[sim.ts](packages/shared/src/sim.ts), [Hud.tsx](packages/client/src/ui/Hud.tsx).

### 7.4 Stone as a 4th resource  — 🆕 **M**

Split a hard resource out for defensive structures: **stone** for walls / towers
/ TC, **gold** stays for units & tech. Gives a concrete reason to fight over the
map center. Touches `ResourceKind`, the HUD top bar, node generation, and
building costs.
**Files.** [types.ts](packages/shared/src/types.ts),
[constants.ts](packages/shared/src/constants.ts),
[map.ts](packages/shared/src/map.ts), [Hud.tsx](packages/client/src/ui/Hud.tsx).

### 7.5 Town Center fires arrows + Garrison  — 🔨 **M**

**Have today.** Towers auto-attack visible enemies in range.
**Add.** (a) Give the **TC** the same building-weapon loop so a base bites back;
(b) **garrison** — units/villagers shelter inside TC/tower, garrisoned archers
add arrows, villagers pop out on command. Classic AoE raid-survival layer.
**Files.** [sim.ts](packages/shared/src/sim.ts) (building-attack + garrison
list), [constants.ts](packages/shared/src/constants.ts),
[Hud.tsx](packages/client/src/ui/Hud.tsx) (eject button).

### 7.6 Walls → Gates, auto-connect, and tiers  — 🔨 **M** — ✅ gates + auto-connect (tiers pending 7.4)

**Have today.** 1×1 `wall` with drag-to-place a line (§3.2 ✅). **Gates** ✅ — a
1×1 wall-line door, solid to enemies and neutral wildlife but passable to the
owner's team once built (owner-aware passability threaded through pathfinding,
steering, and collision). **Auto-connecting sprites** ✅ — each wall/gate picks
an orientation-correct variant (post / end / straight / corner / T / cross, plus
true 45° **diagonal** segments) from its same-owner neighbours, re-skinning as
the line grows. Gates orient to the wall they sit in.
**Still to add.** palisade→stone→fortified wall **tiers** — deferred to pair with
7.4 Stone (wood-only tiers would just be hp/cost scaling).
**Files.** [PixiGame.ts](packages/client/src/game/PixiGame.ts) (`wallVariant`
auto-tile + reconcile branch), [sim.ts](packages/shared/src/sim.ts) (`gateOpenFor`
+ owner-aware blocker/stepOpen/collision), [constants.ts](packages/shared/src/constants.ts)
(gate def), wall/gate SVGs, [scripts/gates.test.ts](scripts/gates.test.ts).

### 7.7 Siege expansion: mangonel & trebuchet  — 🔨 **M**

**Have today.** `ram` (×5 vs buildings) trained at `siege_workshop`; near-
useless vs units, needs an escort.
**Add.** A **mangonel/catapult** (area damage vs unit clumps — counters massed
archers) and a **trebuchet** (very long range, anti-building, slow). Reuses the
siege workshop and the COUNTERS table; new bit is area-of-effect damage.
**Files.** [constants.ts](packages/shared/src/constants.ts) (defs + counters),
[sim.ts](packages/shared/src/sim.ts) (AoE damage), assets,
[Hud.tsx](packages/client/src/ui/Hud.tsx).

### 7.8 Cavalry (Stable)  — 🆕 **M**

A fast raider (scout/knight) from a new **Stable** — built to run down workers
and harass eco, weak to spear/infantry. Extends the counter triangle and gives
map presence. Mostly a unit def + building + counter entries + sprite.
**Files.** [types.ts](packages/shared/src/types.ts) (`UnitType`),
[constants.ts](packages/shared/src/constants.ts),
[sim.ts](packages/shared/src/sim.ts), assets, [Hud.tsx](packages/client/src/ui/Hud.tsx).

### 7.9 Unit stances + patrol  — 🔨 **M**

**Have today.** Formation moves/stop and idle auto-retaliation (§1.1, §1.4 ✅).
**Add.** Per-unit **stance** (Aggressive / Defensive / Stand-Ground / No-Attack)
that bounds chase distance and hold behaviour, plus a **patrol** command (loop
between waypoints). The difference between army micro and chaos.
**Files.** [types.ts](packages/shared/src/types.ts) (stance enum),
[sim.ts](packages/shared/src/sim.ts) (chase leash + patrol),
[protocol.ts](packages/shared/src/protocol.ts),
[Hud.tsx](packages/client/src/ui/Hud.tsx) (4 toggles + patrol button).

### 7.10 Map objectives — Relics & a Wonder victory  — 🆕 **L**

A non-annihilation win path: capturable **relics/monuments** that trickle gold
to the holder, and/or a **Wonder** building that wins if it survives a countdown.
Gives team games a comeback/objective layer beyond last-base-standing.
**Files.** [map.ts](packages/shared/src/map.ts) (objective placement),
[sim.ts](packages/shared/src/sim.ts) (capture + `updateWinState`),
[protocol.ts](packages/shared/src/protocol.ts),
[Hud.tsx](packages/client/src/ui/Hud.tsx).

### Already shipped from this brainstorm

- **Under-attack alerts + minimap pings** — ✅ done, see §5.2.

### Suggested sequencing (roadmap)

1. **Highest leverage:** 7.1 Ages — once in, 7.3/7.6/7.7/7.8 slot in as per-age
   unlocks for far less marginal effort.
2. **Cheap, high-feel:** 7.5a (TC fires arrows) and 7.6 gates — small, very
   noticeable on defense.
3. **Depth:** 7.4 stone → unlocks meaningful 7.6 wall tiers and map-center
   contention; 7.2 specialised camps for eco decisions.
4. **Army identity:** 7.8 cavalry, 7.7 siege types, 7.9 stances together turn
   combat from blob-vs-blob into composition + micro.
5. **Endgame variety:** 7.10 objectives/Wonder for non-annihilation wins.

---

## 8. Refinements — polish on existing systems

Not new systems — these tighten the *feel, readability, and robustness* of what
we already have. Same status legend (🆕/🔨/✅).

**Already refined (don't re-suggest).** Controls are mature: zoom (wheel +
pinch), control groups (Ctrl+digit / digit recall), shift-queued orders, rally
points, attack-move, stop, idle-worker cycle (`.`), go-to-TC (`H`), double-click
select-by-type, a selection-summary-by-type panel, affordability cues + cost
badges, under-attack minimap pings, resource-depletion visuals.

### 8.1 Projectiles & impact  — 🆕 **S–M** — *top pick, client-only* — ✅ done

Today archers, towers, and rams deal damage **instantly** with only a flash on
the target — nothing flies. Add arrow arcs from archers/towers, a ram impact
thud + dust, and small hit-sparks. Purely cosmetic (derived from the snapshot
stream), so it's **deterministic-safe** — no sim change.
**Files.** [PixiGame.ts](packages/client/src/game/PixiGame.ts),
[audio.ts](packages/client/src/game/audio.ts).
**Status.** Arrow flight already existed (archers + towers). Added: a spark
burst where each arrow lands, brown dust puffs for ram battering and soldier
melee, and throttled synth `hit`/`thud` sounds (one combat blip per ~110ms so a
big battle stays punchy, not noisy). Cadence gate refactored into `fireReady`.

### 8.2 On-map unit-state clarity  — 🆕 **S** — ✅ done

A subtle pulsing ring on **idle workers**, a red outline on **low-HP** units, and
a gather/return indicator. We can already *cycle* idle workers but can't *see*
them on the field. Client-only.
**Files.** [PixiGame.ts](packages/client/src/game/PixiGame.ts).
**Status.** Amber pulsing ring on my idle workers (hidden when selected) + red
ring on any unit under 34% HP, drawn in the existing selection pass.

### 8.3 Income rate + villager allocation readout  — 🔨 **S–M** — ✅ done

No per-second income exists anywhere. Add a compact "🪵+12/s · 🍖+8/s · 🪙+4/s"
line and/or a villager-allocation count ("6 wood · 3 food · 2 gold · 2 idle").
Turns the eco game from guesswork into management.
**Files.** [store.ts](packages/client/src/net/store.ts) (derived tally),
[Hud.tsx](packages/client/src/ui/Hud.tsx).
**Status.** Top bar now shows a green **+N/s** gather rate beside each resource,
smoothed (EMA, ~2.5s) from positive snapshot deltas so spending doesn't drag it
negative — fully client-derived, no protocol change. Added a **👷 workers
(idle)** tile. Income resets on each new match.

### 8.4 Sub-select & cancel from the panels  — 🔨 **S** — ✅ done

The selection panel already groups by type — make clicking a type group **narrow
the selection to just that type** (AoE idiom), and make production-queue slots
**cancel-and-refund on click**. Tightens micro, no new systems.
**Files.** [Hud.tsx](packages/client/src/ui/Hud.tsx),
[PixiGame.ts](packages/client/src/game/PixiGame.ts),
[sim.ts](packages/shared/src/sim.ts) (queue cancel + refund).
**Status.** Sub-select already shipped (panel rows narrow the selection), and
`cancelTrain` already refunded. Added **per-slot cancel**: each queued unit chip
is now a button that cancels *that* slot and refunds it (`index` on the command);
cancelling the in-production front restarts the next unit. "Cancel last" kept as
the index-less fallback. Covered by `scripts/m3.test.ts` §17.

### 8.5 Click an alert to jump there  — 🔨 **S** — ✅ done (Space)

Under-attack pings exist; make clicking a ping (or pressing `Space`) snap the
camera to the most recent alert. Closes the loop on the alert system.
**Files.** [Minimap.tsx](packages/client/src/ui/Minimap.tsx),
[PixiGame.ts](packages/client/src/game/PixiGame.ts).
**Status.** `Space` glides to the most recent under-attack ping (<8s old).
Minimap clicks already jump to wherever you click, so the ping is reachable
there too. Controls help updated.

### 8.6 Smooth camera + follow-selected  — 🆕 **S** — ✅ glide done (`4e44055`)

Lerp camera moves (control-group recall and go-to-TC currently hard-snap), and a
"follow selection" toggle. Cheap; makes the whole game feel less rigid.
**Files.** [PixiGame.ts](packages/client/src/game/PixiGame.ts).
**Status.** Camera now eases to jump targets (recall / go-to-TC / minimap) over
~0.3s; manual pan cancels the glide. *Follow-selection toggle still TODO.*

### 8.7 Pacing / balance pass  — 🔨 **M** — ✅ first pass done (guardrails + one tweak)

Tune starting eco, train times, pop-house pacing, and unit costs **as a set** for
a clean ~15-min match arc. Pure data, validated against the sim suite. Best done
**once the unit roster from §7 is stable** (ages/cavalry/siege all shift the
numbers).
**Files.** [constants.ts](packages/shared/src/constants.ts), sim tests.
**Status.** Analysis found the numbers already internally coherent (multiple
prior tuning passes: tower nerf, gold-gated soldier, ram counters), so rather
than risk a blind rebalance the deliverable is **`scripts/balance.test.ts`** —
19 guardrails locking the intended ratios (archer↔soldier↔ram counters, ram-only
siege, tower-doesn't-out-range-archers, upgrade magnitudes, eco baseline) so a
future §7 change can't silently invert them. One defensible tweak: **house build
time 12s → 10s** (matching the storehouse) so pop growth doesn't stall mid-game.
The substantive numeric rebalance still waits on §7 + playtests, as sequenced.

### 8.8 Reconnect / pause for LAN play  — 🆕 **M** — ✅ done

A host pause and clean rejoin-after-disconnect (resync from the latest snapshot)
so a dropped phone at a couch/LAN session doesn't end someone's game.
**Files.** [room.ts](packages/server/src/room.ts),
[index.ts](packages/server/src/index.ts),
[connection.ts](packages/client/src/net/connection.ts),
[protocol.ts](packages/shared/src/protocol.ts).
**Status.** Reconnect was *already* implemented (slot kept alive on disconnect,
`handleJoin` re-attaches by `clientId` and resyncs). Added **host pause**: a
`setPaused` command (host-only) freezes the tick loop and drops commands; a
`paused` message drives a ⏸ button (host) + a "Paused" overlay (all). Reconnecting
mid-pause now gets an immediate snapshot + freeze state. Covered by
`scripts/pause.test.ts` (in-process, no WebSocket).

### 8.9 Mobile refinement pass  — 🔨 **M** — *do LAST, after all §7 features land*

Every new feature in §7 adds HUD/controls that need a touch treatment, so a
holistic mobile pass only pays off **once the feature set is complete** — doing
it earlier means redoing it. Scope when we get there:

- **Touch UI for every new system** — age-up, stances, garrison eject, gates,
  research tiers, etc. each need a reachable tap target, not just a desktop
  hotkey.
- **Layout for the grown HUD** — the build/train/research lists get long; needs
  scrollable/collapsible mobile panels and larger hit targets (thumb-sized).
- **Gesture consistency** — keep pan / box-select / long-press-command coherent
  as commands multiply; audit against the §3.3 select-mode toggle.
- **Performance on phones** — verify the projectile/particle work (8.1) and
  larger armies hold frame rate on mid-range devices; add a quality toggle if
  needed.
- **Readability at small size** — income readout (8.3), alerts (8.5), and
  unit-state cues (8.2) must stay legible on a phone.

**Files.** [Hud.tsx](packages/client/src/ui/Hud.tsx),
[styles.css](packages/client/src/ui/styles.css),
[PixiGame.ts](packages/client/src/game/PixiGame.ts),
[useIsMobile.ts](packages/client/src/ui/useIsMobile.ts).

### Suggested sequencing (refinements)

1. **Now, cheap & high-feel:** 8.1 projectiles, 8.2 unit-state cues, 8.5
   alert-jump, 8.6 smooth camera — all small, client-only, immediately felt.
2. **Eco depth:** 8.3 income readout, 8.4 sub-select/queue-cancel.
3. **Reliability:** 8.8 reconnect/pause when LAN sessions get serious.
4. **After §7 lands:** 8.7 balance pass, then 8.9 the mobile refinement pass —
   both want a stable feature set first.
