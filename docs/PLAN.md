# Implementation Plan — BuilderGame

A LAN-hosted, browser-based, simplified Age of Empires.

## Decisions (locked)

| Area            | Decision                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| Rendering       | PixiJS (WebGL-accelerated 2D canvas). Authored **SVG sprites** → textures.|
| Host & network  | Node host runs the authoritative sim + serves the client. Single port.   |
| Transport       | WebSocket (`ws`). Client sends commands; server broadcasts snapshots.    |
| Language        | TypeScript monorepo (npm workspaces) with a shared sim package.           |
| Map             | Square tile grid; A* pathfinding.                                        |
| Economy         | Three resources: **wood, food, gold**.                                    |
| Win condition   | Destroy all enemy buildings (last player standing).                      |
| Players         | 2–4.                                                                      |

## Networking model — authoritative server

- The server is the single source of truth. Clients are dumb renderers + input senders.
- **Sim tick:** fixed 10 Hz (`TICK_MS = 100`). Deterministic order: ingest commands → run systems → advance time.
- **Snapshots:** after each tick the server builds a per-player view (fog of war applied) and sends it. Small player/unit counts → full snapshot is fine; can move to deltas later.
- **Client interpolation:** the client keeps the last two snapshots and lerps entity positions by wall-clock time, so 10 Hz sim renders smoothly at 60 fps.
- **Commands** are *intents* (e.g. "these units go to tile X"), not state mutations. The server validates ownership, resources, placement, etc.

### Message protocol (see `shared/src/protocol.ts`)

Client → Server: `join`, `setColor`, `setReady`, `startGame`, `command`.
Server → Client: `welcome`, `lobby`, `gameStart`, `snapshot`, `gameOver`, `error`.

`command` payloads: `move`, `gather`, `build`, `train`, `attack`, `stop`.

## Simulation (`shared/src/sim.ts`)

World state:

- `map`: width/height + `tiles[]` (terrain: grass | water | forest | rock).
- `resourceNodes[]`: trees (wood), gold mines (gold), food bushes (food) with remaining amount.
- `units[]`: id, owner, type, pos (float tile coords), hp, state machine (idle/moving/gathering/returning/building/attacking), path, carry, target.
- `buildings[]`: id, owner, type, tile rect, hp, build progress, production queue.
- `players[]`: id, color, resources {wood,food,gold}, pop/popCap, alive.

Systems per tick:

1. **Command ingest** — validate + attach orders to entities.
2. **Movement** — advance units along A* paths; arrival handling.
3. **Gathering** — harvest node → carry to cap → return to nearest drop-off → deposit.
4. **Construction** — workers add build progress to a placed foundation.
5. **Production** — buildings consume resources, count down, spawn unit at rally point.
6. **Combat** — attackers in range deal damage on cooldown; remove dead; destroy buildings.
7. **Vision** — recompute per-player visible tiles from units/buildings sight radius.
8. **Win check** — a player with no buildings is eliminated; last standing wins.

All randomness goes through a **seeded RNG** (`shared/src/rng.ts`) so map gen is reproducible from the match seed.

## Pathfinding (`shared/src/pathfinding.ts`)

- A* on the tile grid, 8-directional, blocked by water/rock/buildings.
- Paths recomputed on new move orders. Simple per-unit path following; light separation can be added in M2.

## Fog of war (`shared/src/fog.ts`)

- Per player: `explored` bitset (remembered terrain) + `visible` bitset (currently in sight).
- Snapshot to a player includes: all explored terrain, but only entities on currently-visible tiles. Enemy positions outside vision are hidden.

## Rendering (`client/src/game`)

- `PixiGame.ts`: Pixi `Application`, world `Container` with camera (pan/zoom), layers: terrain → fog → resources → buildings → units → selection → HUD-overlay.
- `assets.ts`: registry mapping entity types → SVG URLs, loaded via `Assets.load` into textures, tinted per player color.
- Input: drag-pan, wheel/pinch-zoom, click-select (single + drag-box), right-click/tap to issue context command. Touch-friendly for tablets.
- React HUD (`ui/Hud.tsx`) overlays resource counts, selected-unit panel, build/train buttons.

## Milestones

- **M0 — scaffold (this commit):** workspaces; lobby join/color/ready/start; map generation; render terrain + resources + units; select + move a worker; snapshot/interpolation pipeline. End-to-end runnable.
- **M1 — core loop:** gather→deposit; build House (pop cap) + Barracks; train Worker + Soldier; combat + building destruction; win check; fog exploration; HUD wired.
- **M2 — breadth & polish:** more units/buildings, upgrades/tech, minimap, audio, unit collision/formations, reconnect handling, packaged desktop host (Tauri/Electron) so the host needs no Node install.

## What works now (M0 + M1 in progress)

The authoritative simulation implements the full core loop: movement (A*),
gather→deposit→**return** (fixed: workers approach an adjacent tile, never trap
themselves on a building interior), construction, unit production, combat,
building destruction, fog of war, pop cap, rally points, unit separation, and the
win check. Smoke tests (`scripts/smoke.mjs`, `scripts/smoke2.mjs`) drive two
clients and assert the economy/fog, rally, queue visibility, cancel-refund, and
separation.

M1 polish landed:

- **Build-placement ghost preview** (green/red validity, mirrors server rule).
- **HP bars** for damaged units and for buildings (and during construction).
- **Touch reselection** fixed — tapping your own unit/building always selects it.
- **Unit collision/separation** — soft spatial-hash separation, deterministic.
- **Production-queue + building selection UI** — click a building for its queue, progress bar, train buttons, and cancel (with refund).
- **Rally points** — select a building, right-click/tap the map to set where new units walk.
- **Minimap** — explored terrain, entity dots, viewport rect, click-to-jump.
- **Room reset** — a finished/abandoned game returns to a clean lobby.

M2 batch landed:

- **Audio/SFX** — procedural Web Audio (no binary assets): select, command, attack,
  build, unit-ready, construction-complete, victory/defeat. Mute toggle in the HUD;
  context resumed on first gesture (autoplay policy).
- **Attack-move** — press **A** then click (or HUD button) to march a selection to a
  point, auto-engaging any enemy seen en route and resuming the advance after each
  kill. Sim: `aggro` target + `acquireTarget`/`resumeAggro`. Covered by
  `scripts/attackmove.test.ts`.
- **Control groups** — **Ctrl+1–9** assigns the current selection, **1–9** recalls
  (double-tap to centre the camera on the group).
- **Idle-worker cycling** — **.** (or the HUD button, which shows the idle count)
  selects the next idle worker and centres on it.
- **Graceful mid-game reconnect** — a stable per-browser `clientId` keeps the slot and
  its units alive on a drop; the client auto-retries and the server resyncs it with a
  fresh `gameStart` and resumed snapshots. Other players keep playing throughout.
  Covered by `scripts/smoke3.mjs`.

M2 batch-2 landed (breadth & polish):

- **New unit — Archer**: fragile ranged unit (range 5), trained at the Barracks.
  Costs food+wood (no gold gate) as the accessible ranged option.
- **New building — Guard Tower**: static defense that auto-attacks the nearest
  enemy in range. Built by a worker. Sim: `BuildingDef.attack` + `tickTowers`.
- **Upgrades / tech**: research one-at-a-time per building, applied per player —
  *Improved Tools* (worker gather +50%, at Town Center), *Sharpened Blades*
  (+25% military damage) and *Padded Armor* (−25% damage taken), both at the
  Barracks. Effective-stat helpers in `constants.ts`: `gatherRate`,
  `unitDamage`, `incomingDamage`. HUD shows research buttons, progress, and
  earned-upgrade badges.
- **Balance pass**: faster early economy (gather 6/s, worker 5s), archer re-costed
  to food+wood, soldier nudged up (110hp/13dmg) as the gold elite, tower hits
  harder, shorter research times, +20 starting gold.
- **Animations & visual polish**: directional facing, walk-bob, gather wobble,
  attack-pulse, red hit-flash (units + buildings), death fade-out, animated
  selection rings, and arrow projectiles for archers and towers.

Tests: `scripts/smoke.mjs` (gather), `smoke2.mjs` (rally/queue/cancel/separation),
`smoke3.mjs` (reconnect) over the network; `attackmove.test.ts` and `m2.test.ts`
(research, upgrade effects, tower combat) drive the sim directly.

Still open:

- Packaged desktop host (Tauri/Electron) so the host needs no Node install.
- Deeper tech tree, more unit/building types, formations.
- Balance is a reasoned first pass — needs live multiplayer playtesting to tune.
