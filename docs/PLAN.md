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

## What actually works in this scaffold

The authoritative simulation already implements the full core loop: movement (A*),
gather→deposit, construction, unit production, combat, building destruction, fog of
war, pop cap, and the win check. The smoke test (`scripts/smoke.mjs`) drives two
clients through join→ready→start→move and asserts the economy/fog/snapshots.

Client UX is intentionally minimal and is where M1 polish goes:

- No build-placement ghost preview (you click to place; invalid spots are silently rejected by the server).
- No HP bars / health overlays, no production-queue UI, no rally points.
- No minimap, no audio, no unit collision/separation (units can overlap).
- Training is wired to your Town Center (workers) and Barracks (soldiers) via HUD buttons rather than per-building selection.
- Balance numbers in `shared/src/constants.ts` are first-pass guesses.
