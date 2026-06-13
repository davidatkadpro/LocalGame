// Reconnect smoke test: a player drops mid-match and rejoins with the same
// clientId. The server must keep their slot + units alive, keep the match
// running for the other player, then resync the returning player (fresh
// gameStart) and resume their snapshots — same playerId, same units.
import { WebSocket } from "ws";

const URL = "ws://localhost:8080/ws";
const CID0 = "recon-host-0";
const CID1 = "recon-peer-1";

let started = false;
let p0Id = null;
let p1Id = null;
let p0UnitsBefore = [];
let p1Snaps = 0;
let p0SnapsBefore = 0;
let p0SnapsAfter = 0;
let dropped = false;
let p0GameStarts = 0;
let p0ReconShot = null;
let snapsDuringDrop = 0;
let p0Sock = null;
let finished = false;

function join(ws, name, cid) {
  ws.send(JSON.stringify({ t: "join", name, clientId: cid }));
}

// ---- peer player (stable) ----
const peer = new WebSocket(URL);
peer.on("open", () => join(peer, "Peer", CID1));
peer.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.t === "welcome") p1Id = m.playerId;
  if (m.t === "lobby") {
    const me = m.state.slots.find((s) => s.playerId === p1Id);
    if (me && !me.ready) {
      peer.send(JSON.stringify({ t: "setReady", ready: true }));
    } else if (me && me.isHost && m.state.canStart && !started) {
      started = true;
      peer.send(JSON.stringify({ t: "startGame" }));
    }
  }
  if (m.t === "snapshot") {
    p1Snaps++;
    if (dropped && p0SnapsAfter === 0) snapsDuringDrop++;
  }
});

// ---- host player: joins first, drops, reconnects ----
function openHost() {
  const ws = new WebSocket(URL);
  p0Sock = ws;
  ws.on("open", () => join(ws, "Host", CID0));
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.t === "welcome") p0Id = m.playerId;
    if (m.t === "lobby") {
      const me = m.state.slots.find((s) => s.playerId === p0Id);
      if (me && !me.ready) {
        ws.send(JSON.stringify({ t: "setReady", ready: true }));
      } else if (me && me.isHost && m.state.canStart && !started) {
        started = true;
        ws.send(JSON.stringify({ t: "startGame" }));
      }
    }
    if (m.t === "gameStart") {
      p0GameStarts++;
      p0Id = m.you;
    }
    if (m.t === "snapshot") {
      if (!dropped) {
        p0SnapsBefore++;
        const mine = m.snap.units.filter((u) => u.owner === p0Id).map((u) => u.id);
        if (mine.length) p0UnitsBefore = mine;
        // After a healthy stretch, simulate an abrupt network drop.
        if (p0SnapsBefore === 12) {
          dropped = true;
          ws.terminate(); // hard close, no clean handshake
          setTimeout(reconnect, 1500);
        }
      } else {
        p0SnapsAfter++;
        if (!p0ReconShot) p0ReconShot = m.snap;
        if (p0SnapsAfter >= 10) finish();
      }
    }
  });
  ws.on("error", () => {});
}

function reconnect() {
  openHost(); // new socket, same CID0 -> should re-attach to the running match
}

function finish() {
  if (finished) return;
  finished = true;

  const reconnected = p0GameStarts >= 2; // initial start + resync on rejoin
  const resumed = p0SnapsAfter >= 5;
  const gameKeptRunning = snapsDuringDrop > 0; // peer still ticked while p0 was gone
  const unitsAfter = p0ReconShot
    ? p0ReconShot.units.filter((u) => u.owner === p0Id).map((u) => u.id)
    : [];
  const keptUnits = p0UnitsBefore.length > 0 && p0UnitsBefore.every((id) => unitsAfter.includes(id));

  console.log(`gameStarts(p0)=${p0GameStarts} reconnected=${reconnected}`);
  console.log(`snapsDuringDrop(peer)=${snapsDuringDrop} gameKeptRunning=${gameKeptRunning}`);
  console.log(`p0 snaps: before=${p0SnapsBefore} after=${p0SnapsAfter} resumed=${resumed}`);
  console.log(`units before=[${p0UnitsBefore}] after=[${unitsAfter}] keptUnits=${keptUnits}`);

  const ok = reconnected && resumed && gameKeptRunning && keptUnits;
  console.log(ok ? "SMOKE3: PASS ✅" : "SMOKE3: FAIL ❌");
  try { peer.close(); } catch {}
  try { p0Sock?.close(); } catch {}
  process.exit(ok ? 0 : 1);
}

openHost();

setTimeout(() => {
  console.log("timeout");
  finish();
}, 30000);
