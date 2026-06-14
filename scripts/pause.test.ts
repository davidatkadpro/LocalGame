// In-process test for the host pause feature — drives GameRoom directly with
// fake connections and real timers (no WebSocket). Asserts that pausing freezes
// the snapshot stream and that only the host may pause. Reconnect itself is
// exercised by the network smoke tests; this covers the new freeze logic.
import { GameRoom } from "../packages/server/src/room.ts";
import type { ClientMessage, ServerMessage } from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeConn {
  id: number;
  playerId: number | null;
  sent: ServerMessage[];
  send(m: ServerMessage): void;
  close(): void;
}
function makeConn(id: number): FakeConn {
  return {
    id,
    playerId: null,
    sent: [],
    send(m: ServerMessage) {
      this.sent.push(m);
    },
    close() {},
  };
}
const snaps = (c: FakeConn) => c.sent.filter((m) => m.t === "snapshot").length;
const msg = (room: GameRoom, c: FakeConn, m: ClientMessage) =>
  room.onMessage(c as unknown as Parameters<GameRoom["onMessage"]>[0], m);

const room = new GameRoom();
const a = makeConn(1);
const b = makeConn(2);
const conn = (c: FakeConn) => c as unknown as Parameters<GameRoom["onConnect"]>[0];

room.onConnect(conn(a));
msg(room, a, { t: "join", name: "A", clientId: "ca" });
room.onConnect(conn(b));
msg(room, b, { t: "join", name: "B", clientId: "cb" });
msg(room, a, { t: "setReady", ready: true });
msg(room, b, { t: "setReady", ready: true });
msg(room, a, { t: "startGame" }); // A joined first -> host, repacked to sim id 0

check("host is repacked to sim id 0", a.playerId === 0);

await sleep(280); // ~2-3 ticks at TICK_MS=100
const beforePause = snaps(a);
check("snapshots flow while running", beforePause > 0, `n=${beforePause}`);

msg(room, a, { t: "setPaused", paused: true });
check(
  "host pause is broadcast to players",
  a.sent.some((m) => m.t === "paused" && m.paused === true) &&
    b.sent.some((m) => m.t === "paused" && m.paused === true),
);
const atPause = snaps(a);
await sleep(320);
check("snapshots stop while paused", snaps(a) === atPause, `delta=${snaps(a) - atPause}`);

msg(room, a, { t: "setPaused", paused: false });
await sleep(280);
check("snapshots resume after unpause", snaps(a) > atPause, `n=${snaps(a)}`);

// A non-host trying to pause is ignored: the stream keeps flowing.
const beforeNonHost = snaps(a);
msg(room, b, { t: "setPaused", paused: true });
await sleep(280);
check("a non-host setPaused is ignored", snaps(a) > beforeNonHost, `n=${snaps(a)}`);

// Teardown: disconnect both -> the room resets and clears its tick interval so
// the test process can exit.
room.onDisconnect(conn(a));
room.onDisconnect(conn(b));

console.log(pass ? "PAUSE: PASS ✅" : "PAUSE: FAIL ❌");
process.exit(pass ? 0 : 1);
