// Host entry point: serves the built client over HTTP and runs the game over WS.

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sirv from "sirv";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage } from "@bg/shared";
import { GameRoom, type Conn } from "./room";

const PORT = Number(process.env.PORT ?? 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(__dirname, "../../client/dist");

// Static hosting of the built client (production / LAN play).
const serveStatic = existsSync(clientDist)
  ? sirv(clientDist, { single: true, dev: false })
  : null;

const http = createServer((req, res) => {
  if (serveStatic) {
    serveStatic(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  } else {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end(
      "BuilderGame server is running.\n" +
        "Client dist not built yet — run `npm run build`, or use `npm run dev` for hot reload.\n",
    );
  }
});

const room = new GameRoom();
const wss = new WebSocketServer({ server: http, path: "/ws" });

let nextConnId = 1;

wss.on("connection", (ws: WebSocket) => {
  const conn: Conn = {
    id: nextConnId++,
    playerId: null,
    send(msg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      ws.close();
    },
  };

  room.onConnect(conn);

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }
    room.onMessage(conn, msg);
  });

  ws.on("close", () => room.onDisconnect(conn));
  ws.on("error", () => room.onDisconnect(conn));
});

http.listen(PORT, () => {
  console.log(`\nBuilderGame host listening on http://0.0.0.0:${PORT}`);
  console.log(`  • Same machine:   http://localhost:${PORT}`);
  console.log(`  • Other devices:  http://<this-machine-LAN-IP>:${PORT}`);
  if (!serveStatic) {
    console.log("  • (client not built — run `npm run build`, or use `npm run dev`)");
  }
  console.log("");
});
