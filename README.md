# BuilderGame

A LAN-hosted, browser-based, simplified Age-of-Empires-style real-time strategy game.
One device hosts (runs a small server); other devices on the same network join by opening a URL in their browser. 2–4 players.

- **Rendering:** PixiJS (WebGL-accelerated 2D canvas), authored SVG sprites.
- **Networking:** authoritative Node + WebSocket server; clients send commands, server broadcasts per-player fog-of-war snapshots at 10 Hz; clients interpolate at 60 fps.
- **Stack:** TypeScript monorepo (npm workspaces). Shared simulation package used by both client and server.
- **Game:** square tile grid + A* pathing, resources wood/food/gold, win by destroying all enemy buildings.

See [docs/PLAN.md](docs/PLAN.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 20+ (tested on 22), npm 10+.

## Install

```bash
npm install
```

## Run — single machine (development, hot reload)

```bash
npm run dev
```

- Client (Vite): http://localhost:5173
- Server (ws + sim): http://localhost:8080
- The Vite dev server proxies `/ws` to the game server, so just open the client URL.

## Run — LAN play (host serves everything)

```bash
npm run build      # builds the client into packages/client/dist
npm start          # starts the host server on port 8080, serving the built client
```

Then on every device (host included), open:

```
http://<HOST-LAN-IP>:8080
```

Find the host's LAN IP:

- **Windows:** `ipconfig` → "IPv4 Address" (e.g. `192.168.1.42`)
- **macOS/Linux:** `ipconfig getifaddr en0` / `hostname -I`

> Make sure the host firewall allows inbound connections on port 8080. On Windows you may get a prompt the first time — allow it for Private networks.

## How to play (current scaffold)

1. Open the URL on each device. Enter a name, pick a color/slot, hit **Ready**.
2. When 2–4 players are ready, the host presses **Start Game**.
3. Drag to pan, scroll/pinch to zoom. Click to select a unit, right-click (or tap-target) to move.

Gameplay breadth (gather/build/train/combat) is filled in across milestone M1 — see the plan.

## Project layout

```
packages/
  shared/   game types, constants, RNG, map gen, pathfinding, fog, authoritative sim
  server/   ws server, lobby/rooms, match loop, static hosting of the client
  client/   React lobby + HUD, PixiJS game renderer, network client, SVG assets
```

## Scripts

| command            | what it does                                        |
| ------------------ | --------------------------------------------------- |
| `npm run dev`      | run server + client with hot reload (single machine)|
| `npm run build`    | build the client for production                      |
| `npm start`        | run the host server serving the built client        |
| `npm run typecheck`| typecheck all packages                              |
