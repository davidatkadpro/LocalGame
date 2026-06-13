// M1 batch-2 smoke test: rally points, production-queue visibility, cancel
// refund, and unit separation. Two clients connect; client 0 drives.
import { WebSocket } from "ws";

const URL = "ws://localhost:8080/ws";
const clients = [];
let started = false;
let snap = 0;
let tcId = null;
let rally = null;
let origWorkerIds = [];
let foodAfterTrain = null;
let foodAfterCancel = null;
let maxQueueSeen = 0;
let produceMsSeen = 0;

function send(ws, cmd) {
  ws.send(JSON.stringify({ t: "command", cmd }));
}

function mk(idx) {
  const ws = new WebSocket(URL);
  const c = { ws, idx, playerId: null, ready: false, isHost: false, last: null };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name: `Bot${idx}` })));
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.t === "welcome") c.playerId = m.playerId;
    if (m.t === "lobby") {
      const me = m.state.slots.find((s) => s.playerId === c.playerId);
      if (me) c.isHost = me.isHost;
      if (!c.ready) {
        c.ready = true;
        ws.send(JSON.stringify({ t: "setReady", ready: true }));
      } else if (m.state.canStart && c.isHost && !started) {
        started = true;
        ws.send(JSON.stringify({ t: "startGame" }));
      }
    }
    if (m.t === "snapshot" && idx === 0) {
      c.last = m.snap;
      snap++;
      const mine = m.snap.units.filter((u) => u.owner === c.playerId);
      const tc = m.snap.buildings.find((b) => b.owner === c.playerId && b.type === "town_center");

      if (snap === 2 && tc) {
        tcId = tc.id;
        rally = { x: tc.tx + 9, y: tc.ty + 1 };
        origWorkerIds = mine.filter((u) => u.type === "worker").map((u) => u.id);
        send(ws, { c: "rally", building: tcId, tile: rally });
        send(ws, { c: "train", building: tcId, unit: "worker" });
        send(ws, { c: "train", building: tcId, unit: "worker" });
        // order original workers to one tile to test separation
        send(ws, { c: "move", units: origWorkerIds, tile: { x: tc.tx + 11, y: tc.ty + 6 } });
        console.log(`[c0] tc=${tcId} rally=(${rally.x},${rally.y}) origWorkers=${origWorkerIds.length}`);
      }
      if (snap >= 4 && tc) {
        maxQueueSeen = Math.max(maxQueueSeen, (tc.queue ?? []).length);
        produceMsSeen = Math.max(produceMsSeen, tc.produceMs ?? 0);
      }
      if (snap === 6) foodAfterTrain = m.snap.me.resources.food;
      if (snap === 8) {
        send(ws, { c: "cancelTrain", building: tcId });
      }
      if (snap === 12) foodAfterCancel = m.snap.me.resources.food;
      if (snap === 130) finish(c);
    }
  });
  ws.on("error", (e) => console.log(`[c${idx}] ws error`, e.message));
  return c;
}

function finish(c) {
  const s = c.last;
  const mine = s.units.filter((u) => u.owner === c.playerId);
  const produced = mine.filter((u) => !origWorkerIds.includes(u.id));
  const nearRally = produced.some((u) => Math.hypot(u.x - rally.x, u.y - rally.y) < 3.5);

  // separation: min pairwise distance among surviving original workers
  const orig = mine.filter((u) => origWorkerIds.includes(u.id));
  let minD = Infinity;
  for (let i = 0; i < orig.length; i++)
    for (let j = i + 1; j < orig.length; j++)
      minD = Math.min(minD, Math.hypot(orig[i].x - orig[j].x, orig[i].y - orig[j].y));

  const queueVisible = maxQueueSeen >= 1 && produceMsSeen > 0;
  const refunded = foodAfterCancel === foodAfterTrain + 50;
  const separated = orig.length < 2 || minD > 0.3;

  console.log(`queueVisible=${queueVisible} (maxQueue=${maxQueueSeen}, produceMs=${produceMsSeen})`);
  console.log(`refund: foodAfterTrain=${foodAfterTrain} foodAfterCancel=${foodAfterCancel} refunded=${refunded}`);
  console.log(`rally: produced=${produced.length} nearRally=${nearRally}`);
  console.log(`separation: origAlive=${orig.length} minPairDist=${minD.toFixed(2)} separated=${separated}`);

  const ok = queueVisible && refunded && nearRally && separated;
  console.log(ok ? "SMOKE2: PASS ✅" : "SMOKE2: FAIL ❌");
  clients.forEach((x) => x.ws.close());
  process.exit(ok ? 0 : 1);
}

clients.push(mk(0));
clients.push(mk(1));
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 30000);
