import { create } from "zustand";
import type {
  Command,
  GameMap,
  LobbyState,
  PlayerPublic,
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
  lobby: LobbyState | null;
  error: string | null;

  // match
  map: GameMap | null;
  players: PlayerPublic[];
  seed: number;
  winner: number | null;

  // snapshot interpolation buffer
  prev: Snapshot | null;
  curr: Snapshot | null;
  currReceivedAt: number; // performance.now() when `curr` arrived

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
  startGame: () => void;
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

export const useStore = create<GameState>((set, get) => ({
  phase: "connecting",
  conn: null,
  myPlayerId: null,
  clientId: ensureClientId(),
  myName: null,
  reconnecting: false,
  lobby: null,
  error: null,
  map: null,
  players: [],
  seed: 0,
  winner: null,
  prev: null,
  curr: null,
  currReceivedAt: 0,
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
            set({
              phase: "playing",
              map: msg.map,
              players: msg.players,
              myPlayerId: msg.you,
              seed: msg.seed,
              prev: null,
              curr: null,
              winner: null,
              reconnecting: false,
              selectedUnits: [],
              selectedBuilding: null,
              selectArmed: false,
              pings: [],
            });
            break;
          case "snapshot":
            set((s) => ({
              prev: s.curr,
              curr: msg.snap,
              currReceivedAt: performance.now(),
            }));
            break;
          case "gameOver":
            set({ phase: "over", winner: msg.winner, reconnecting: false });
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
  startGame: () => get().conn?.send({ t: "startGame" }),
  command: (cmd) => get().conn?.send({ t: "command", cmd }),
}));
