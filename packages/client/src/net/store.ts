import { create } from "zustand";
import type {
  Command,
  GameMap,
  LobbyState,
  PlayerPublic,
  PlayerStats,
  Resources,
  Snapshot,
} from "@bg/shared";
import { Connection, wsUrl } from "./connection";

export type Phase = "connecting" | "naming" | "lobby" | "playing" | "over";

interface GameState {
  phase: Phase;
  conn: Connection | null;
  myPlayerId: number | null;
  clientId: string;
  myName: string | null;
  reconnecting: boolean;
  paused: boolean; // host froze the running match
  lobby: LobbyState | null;
  error: string | null;

  // match
  map: GameMap | null;
  players: PlayerPublic[];
  seed: number;
  winner: number | null;
  // final scoreboard payload (set on gameOver)
  endPlayers: PlayerPublic[];
  endStats: PlayerStats[];

  // snapshot interpolation buffer
  prev: Snapshot | null;
  curr: Snapshot | null;
  currReceivedAt: number; // performance.now() when `curr` arrived
  // smoothed gross income per second (gathering only — spending is floored out)
  income: Resources;

  // selection (shared between the Pixi canvas and the React HUD)
  selectedUnits: number[];
  selectedBuilding: number | null;
  setSelection: (units: number[], building: number | null) => void;

  // touch box-select arming (HUD button <-> Pixi input)
  selectArmed: boolean;
  setSelectArmed: (armed: boolean) => void;

  // minimap -> camera channel; PixiGame consumes and clears it
  cameraJump: { x: number; y: number } | null;
  jumpCamera: (x: number, y: number) => void;

  // "under attack" minimap pings (world coords + birth time); PixiGame adds them
  pings: { x: number; y: number; born: number }[];
  addPing: (x: number, y: number) => void;

  // actions
  connect: () => void;
  join: (name: string) => void;
  setColor: (color: string) => void;
  setReady: (ready: boolean) => void;
  setMode: (mode: "ffa" | "2v2") => void;
  setTeam: (target: number, team: number) => void;
  startGame: () => void;
  setPaused: (paused: boolean) => void;
  command: (cmd: Command) => void;
}

function ensureClientId(): string {
  let id = localStorage.getItem("bg-clientId");
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("bg-clientId", id);
  }
  return id;
}

// --- gross income estimate (client-derived; no protocol change) -------------
// Smooth the positive per-resource deltas between snapshots into a per-second
// rate. Spending (training/building) shows as a drop, which we floor at zero so
// the readout reflects gathering income, not net balance.
const incomeEma: Resources = { wood: 0, food: 0, gold: 0, stone: 0 };
let incLastRes: Resources | null = null;
let incLastAt = 0;
function resetIncome(): void {
  incomeEma.wood = 0;
  incomeEma.food = 0;
  incomeEma.gold = 0;
  incomeEma.stone = 0;
  incLastRes = null;
  incLastAt = 0;
}
function trackIncome(snap: Snapshot): Resources {
  const now = performance.now();
  const r = snap.me.resources;
  if (incLastRes) {
    const dt = (now - incLastAt) / 1000;
    if (dt > 0.01 && dt < 5) {
      const a = Math.min(1, dt / 2.5); // ~2.5s smoothing window
      (["wood", "food", "gold", "stone"] as (keyof Resources)[]).forEach((k) => {
        const rate = Math.max(0, r[k] - incLastRes![k]) / dt;
        incomeEma[k] += (rate - incomeEma[k]) * a;
      });
    }
  }
  incLastRes = { ...r };
  incLastAt = now;
  return { ...incomeEma };
}

export const useStore = create<GameState>((set, get) => ({
  phase: "connecting",
  conn: null,
  myPlayerId: null,
  clientId: ensureClientId(),
  myName: null,
  reconnecting: false,
  paused: false,
  lobby: null,
  error: null,
  map: null,
  players: [],
  seed: 0,
  winner: null,
  endPlayers: [],
  endStats: [],
  prev: null,
  curr: null,
  currReceivedAt: 0,
  income: { wood: 0, food: 0, gold: 0, stone: 0 },
  selectedUnits: [],
  selectedBuilding: null,
  selectArmed: false,
  cameraJump: null,
  pings: [],

  setSelection: (units, building) => set({ selectedUnits: units, selectedBuilding: building }),
  setSelectArmed: (armed) => set({ selectArmed: armed }),
  addPing: (x, y) =>
    set((s) => {
      const now = performance.now();
      // keep only live pings (< 2.5s) plus the new one; cap the list
      const live = s.pings.filter((p) => now - p.born < 2500);
      return { pings: [...live, { x, y, born: now }].slice(-12) };
    }),
  jumpCamera: (x, y) => set({ cameraJump: { x, y } }),

  connect: () => {
    if (get().conn) return;
    const conn = new Connection(wsUrl(), {
      onOpen: () => {
        set({ reconnecting: false, error: null });
        // If we'd already joined, re-announce ourselves so the server can
        // re-attach us to our slot / running match (graceful reconnect).
        const s = get();
        if (s.myName) {
          s.conn?.send({ t: "join", name: s.myName, clientId: s.clientId });
        } else {
          set((st) => ({ phase: st.myPlayerId === null ? "naming" : st.phase }));
        }
      },
      onReconnecting: () => {
        if (get().phase !== "over") set({ reconnecting: true });
      },
      onClose: () =>
        // A finished match closes the socket on purpose — don't paint a scary
        // "Disconnected" banner over the victory/defeat screen.
        set((s) => (s.phase === "over" ? {} : { error: "Disconnected from host." })),
      onMessage: (msg) => {
        switch (msg.t) {
          case "welcome":
            set({ myPlayerId: msg.playerId, phase: "lobby" });
            break;
          case "lobby":
            set({ lobby: msg.state });
            break;
          case "gameStart":
            resetIncome();
            set({
              phase: "playing",
              map: msg.map,
              players: msg.players,
              myPlayerId: msg.you,
              seed: msg.seed,
              prev: null,
              curr: null,
              income: { wood: 0, food: 0, gold: 0, stone: 0 },
              winner: null,
              reconnecting: false,
              paused: false,
              selectedUnits: [],
              selectedBuilding: null,
              selectArmed: false,
              pings: [],
            });
            break;
          case "paused":
            set({ paused: msg.paused });
            break;
          case "snapshot":
            set((s) => ({
              prev: s.curr,
              curr: msg.snap,
              currReceivedAt: performance.now(),
              income: trackIncome(msg.snap),
            }));
            break;
          case "gameOver":
            set({
              phase: "over",
              winner: msg.winner,
              endPlayers: msg.players,
              endStats: msg.stats,
              reconnecting: false,
              paused: false,
            });
            // Match is finished — stop auto-reconnecting.
            get().conn?.close();
            break;
          case "error":
            set({ error: msg.message });
            break;
        }
      },
    });
    set({ conn });
  },

  join: (name) => {
    set({ myName: name });
    get().conn?.send({ t: "join", name, clientId: get().clientId });
  },
  setColor: (color) => get().conn?.send({ t: "setColor", color }),
  setReady: (ready) => get().conn?.send({ t: "setReady", ready }),
  setMode: (mode) => get().conn?.send({ t: "setMode", mode }),
  setTeam: (target, team) => get().conn?.send({ t: "setTeam", target, team }),
  startGame: () => get().conn?.send({ t: "startGame" }),
  setPaused: (paused) => get().conn?.send({ t: "setPaused", paused }),
  command: (cmd) => get().conn?.send({ t: "command", cmd }),
}));
