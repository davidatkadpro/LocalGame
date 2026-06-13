// End-to-end smoke test: two clients join, ready up, host starts, sim runs.
import { WebSocket } from "ws";

const URL = "ws://localhost:8080/ws";
const clients = [];
let started = false;
let snapCount = 0;
let movedUnit = null;

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
      console.log(`[c${idx}] gameStart you=${m.you} map=${m.map.width}x${m.map.height} players=${m.players.length}`);
    }
    if (m.t === "snapshot") {
      c.lastSnap = m.snap;
      if (idx === 0) {
        snapCount++;
        // After a few snapshots, order our first unit to move.
        if (snapCount === 5 && !movedUnit) {
          const mine = m.snap.units.find((u) => u.owner === c.playerId);
          if (mine) {
            movedUnit = { id: mine.id, x: mine.x, y: mine.y };
            ws.send(JSON.stringify({
              t: "command",
              cmd: { c: "move", units: [mine.id], tile: { x: Math.floor(mine.x) + 6, y: Math.floor(mine.y) } },
            }));
            console.log(`[c0] move unit ${mine.id} from (${mine.x.toFixed(1)},${mine.y.toFixed(1)})`);
          }
        }
        if (snapCount === 25) finish();
      }
    }
    if (m.t === "error") console.log(`[c${idx}] error: ${m.message}`);
  });
  ws.on("error", (e) => console.log(`[c${idx}] ws error`, e.message));
  return c;
}

function finish() {
  const c0 = clients[0];
  const snap = c0.lastSnap;
  const myUnits = snap.units.filter((u) => u.owner === c0.playerId);
  const moved = movedUnit && myUnits.find((u) => u.id === movedUnit.id);
  const dx = moved ? Math.abs(moved.x - movedUnit.x) : 0;
  console.log(`snapshots=${snapCount} myUnits=${myUnits.length} myBuildings=${snap.buildings.filter((b) => b.owner === c0.playerId).length} resourcesSeen=${snap.resources.length}`);
  console.log(`unit moved by dx=${dx.toFixed(2)} (expect > 0)`);
  console.log(`resources: wood=${snap.me.resources.wood} food=${snap.me.resources.food} gold=${snap.me.resources.gold} pop=${snap.me.pop}/${snap.me.popCap}`);
  const ok = myUnits.length >= 3 && dx > 0.5 && snap.resources.length > 0;
  console.log(ok ? "SMOKE TEST: PASS ✅" : "SMOKE TEST: FAIL ❌");
  clients.forEach((c) => c.ws.close());
  process.exit(ok ? 0 : 1);
}

clients.push(mk(0));
clients.push(mk(1));
setTimeout(() => {
  console.log("timeout without finishing");
  process.exit(1);
}, 15000);
