# Architecture

```
                         LAN
  ┌──────────────┐   http+ws  ┌──────────────────────────────────────┐
  │ Tablet (web) │◀──────────▶│  HOST DEVICE (PC)                     │
  └──────────────┘            │                                       │
  ┌──────────────┐            │  @bg/server (Node)                    │
  │ PC (web)     │◀──────────▶│   ├─ static: serves @bg/client/dist   │
  └──────────────┘            │   ├─ ws: lobby + match rooms          │
  ┌──────────────┐            │   └─ match loop @ 10Hz ──┐            │
  │ PC (web)     │◀──────────▶│                          ▼            │
  └──────────────┘            │              @bg/shared  authoritative│
                              │              (sim, map, pathing, fog) │
                              └──────────────────────────────────────┘
        ▲ same @bg/shared types & sim are imported by the client too
        │ (client uses them for typing + interpolation, NOT authority)
```

## Packages

### `@bg/shared`
Pure TypeScript, no runtime deps. The contract + the rules.
- `types.ts` — entities, world state, enums.
- `protocol.ts` — every client↔server message (discriminated unions).
- `constants.ts` — tunable balance: unit/building/resource defs, tick rate, costs, sight.
- `rng.ts` — seeded PRNG (mulberry32) for reproducible map gen.
- `geometry.ts` — tile/vector helpers.
- `map.ts` — procedural map generation from a seed.
- `pathfinding.ts` — A* on the grid.
- `fog.ts` — per-player visibility.
- `sim.ts` — `createWorld`, `applyCommand`, `tick`, `viewFor(player)`.

### `@bg/server`
- `index.ts` — http server (static via `sirv`) + ws upgrade on `/ws`.
- `lobby.ts` — players, colors, ready state, host authority, start.
- `match.ts` — wraps `@bg/shared` sim in a `setInterval` loop, broadcasts per-player snapshots.
- `net.ts` — connection lifecycle, message routing, id assignment.

Runs via `tsx` (executes TS directly) — no build step. Imports `@bg/shared` source.

### `@bg/client`
- `main.tsx` / `App.tsx` — top-level screen switch: Connecting → Lobby → Game.
- `net/connection.ts` — typed WebSocket wrapper (auto URL from origin, `/ws` proxied in dev).
- `net/store.ts` — Zustand store holding connection state, lobby, and snapshot buffer.
- `ui/Lobby.tsx`, `ui/Hud.tsx` — React UI.
- `game/PixiGame.ts` — Pixi app, camera, input, render loop, interpolation.
- `game/assets.ts` — SVG → texture registry.
- `assets/*.svg` — authored sprites.

## Data flow per frame

1. Input on client → `command` message → server.
2. Server `match` loop: ingest queued commands → `tick()` → for each player `viewFor()` → send `snapshot`.
3. Client receives snapshot → pushes into buffer (keeps last 2).
4. Pixi render loop (60fps) interpolates entity positions between the two buffered snapshots by elapsed time and draws.

## Why authoritative (not lockstep/P2P)

- Simple to reason about; no desync; trivial late-join/fog; cheating impossible (clients never own state).
- For 2–4 players and modest unit counts on a LAN, full 10 Hz snapshots are cheap. Deltas/area-of-interest are an easy later optimization.
