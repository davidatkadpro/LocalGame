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

  // actions
  connect: () => void;
  join: (name: string) => void;
  setColor: (color: string) => void;
  setReady: (ready: boolean) => void;
  startGame: () => void;
  command: (cmd: Command) => void;
}

export const useStore = create<GameState>((set, get) => ({
  phase: "connecting",
  conn: null,
  myPlayerId: null,
  lobby: null,
  error: null,
  map: null,
  players: [],
  seed: 0,
  winner: null,
  prev: null,
  curr: null,
  currReceivedAt: 0,

  connect: () => {
    if (get().conn) return;
    const conn = new Connection(wsUrl(), {
      onOpen: () => set((s) => ({ phase: s.myPlayerId === null ? "naming" : s.phase })),
      onClose: () => set({ error: "Disconnected from host." }),
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
            set({ phase: "over", winner: msg.winner });
            break;
          case "error":
            set({ error: msg.message });
            break;
        }
      },
    });
    set({ conn });
  },

  join: (name) => get().conn?.send({ t: "join", name }),
  setColor: (color) => get().conn?.send({ t: "setColor", color }),
  setReady: (ready) => get().conn?.send({ t: "setReady", ready }),
  startGame: () => get().conn?.send({ t: "startGame" }),
  command: (cmd) => get().conn?.send({ t: "command", cmd }),
}));
