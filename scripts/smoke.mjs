// End-to-end smoke test: two clients join, ready up, host starts, then we order
// all workers to gather wood and verify the gather->deposit->RETURN loop keeps
// running (resources must keep climbing across two late checkpoints).
import { WebSocket } from "ws";

const URL = "ws://localhost:8080/ws";
const clients = [];
// Checkpoints are well past the first round-trip so the test is robust to where
// the map seed places the nearest wood node (a far node needs >6s for a trip).
const CP1 = 100; // ~10s: at least one deposit must have landed by here
const CP2 = 200; // ~20s: economy must still be climbing (workers RETURN for more)

let started = false;
let snapCount = 0;
let ordered = false;
let startWood = null;
let woodAt60 = null;
let woodAt140 = null;

function mk(idx) {
  const ws = new WebSocket(URL);
  const c = { ws, idx, playerId: null, ready: false, isHost: false, lastSnap: null };
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
    if (m.t === "gameStart") {
      console.log(`[c${idx}] gameStart you=${m.you} map=${m.map.width}x${m.map.height}`);
    }
    if (m.t === "snapshot" && idx === 0) {
      c.lastSnap = m.snap;
      snapCount++;
      if (!ordered) {
        const workers = m.snap.units.filter((u) => u.owner === c.playerId && u.type === "worker");
        const wood = m.snap.resources.filter((n) => n.kind === "wood");
        if (workers.length && wood.length) {
          // nearest wood node to the first worker
          const w0 = workers[0];
          wood.sort((a, b) => Math.hypot(a.tx - w0.x, a.ty - w0.y) - Math.hypot(b.tx - w0.x, b.ty - w0.y));
          const node = wood[0];
          startWood = m.snap.me.resources.wood;
          ws.send(JSON.stringify({
            t: "command",
            cmd: { c: "gather", units: workers.map((w) => w.id), node: node.id },
          }));
          ordered = true;
          console.log(`[c0] ${workers.length} workers -> gather wood node ${node.id} at (${node.tx},${node.ty}); startWood=${startWood}`);
        }
      }
      if (snapCount === CP1) woodAt60 = m.snap.me.resources.wood;
      if (snapCount === CP2) {
        woodAt140 = m.snap.me.resources.wood;
        finish();
      }
    }
  });
  ws.on("error", (e) => console.log(`[c${idx}] ws error`, e.message));
  return c;
}

function finish() {
  const snap = clients[0].lastSnap;
  const stuck = snap.units.filter((u) => u.owner === clients[0].playerId && u.state === "gathering" && u.carry).length;
  console.log(`snapshots=${snapCount} wood: start=${startWood} @${CP1}=${woodAt60} @${CP2}=${woodAt140}`);
  console.log(`resources: wood=${snap.me.resources.wood} food=${snap.me.resources.food} gold=${snap.me.resources.gold}`);
  const deposited = woodAt60 > startWood; // at least one deposit happened
  const stillClimbing = woodAt140 > woodAt60; // workers RETURNED for more (the bug)
  console.log(`deposited=${deposited} stillClimbing=${stillClimbing}`);
  const ok = deposited && stillClimbing;
  console.log(ok ? "SMOKE TEST: PASS ✅" : "SMOKE TEST: FAIL ❌");
  clients.forEach((c) => c.ws.close());
  process.exit(ok ? 0 : 1);
}

clients.push(mk(0));
clients.push(mk(1));
setTimeout(() => {
  console.log("timeout without finishing");
  process.exit(1);
}, 35000);
