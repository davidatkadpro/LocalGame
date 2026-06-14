// Wire protocol: every message that crosses the WebSocket.
// All messages are discriminated unions on `t`.

import type {
  AnimalKind,
  BuildingType,
  GameMap,
  PlayerId,
  PlayerStats,
  Resources,
  ResourceKind,
  UnitState,
  UnitType,
  UpgradeId,
  Vec2,
} from "./types";

// ---------- Lobby ----------

export type GameMode = "ffa" | "2v2";

export interface LobbySlot {
  playerId: PlayerId;
  name: string;
  color: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  /** team id (used in 2v2; in FFA every slot is its own team) */
  team: number;
}

/** A persisted, name-keyed standings row shown on the lobby leaderboard. */
export interface LeaderboardEntry {
  name: string;
  wins: number;
  games: number;
}

export interface LobbyState {
  slots: LobbySlot[];
  canStart: boolean;
  mode: GameMode;
  /** persisted all-time standings (sorted, best first); the lobby shows top 3 */
  leaderboard: LeaderboardEntry[];
}

// ---------- Snapshot DTOs (fog-filtered, sent each tick) ----------

export interface UnitDTO {
  id: number;
  owner: PlayerId;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  state: UnitState;
  carry: ResourceKind | null;
  /** queued-order waypoints (own units only) for drawing the command queue */
  orders?: { x: number; y: number }[];
}

export interface BuildingDTO {
  id: number;
  owner: PlayerId;
  type: BuildingType;
  tx: number;
  ty: number;
  hp: number;
  progress: number;
  // The following are only populated for the viewing player's own buildings.
  queue?: UnitType[];
  produceTimer?: number; // ms left on the unit currently producing
  produceMs?: number; // total train time of that unit (for a progress bar)
  rallyX?: number;
  rallyY?: number;
  research?: UpgradeId | null; // upgrade in progress here
  researchTimer?: number; // ms left on the current research
  researchMs?: number; // total research time (for a progress bar)
}

export interface ResourceNodeDTO {
  id: number;
  kind: ResourceKind;
  tx: number;
  ty: number;
  amount: number;
  /** present for farm-hosted nodes: only this player may harvest it */
  owner?: PlayerId;
  /** true if this food node is a hunted-animal carcass (rendered as meat) */
  carcass?: boolean;
}

export interface AnimalDTO {
  id: number;
  kind: AnimalKind;
  x: number;
  y: number;
  hp: number;
}

export interface PlayerPublic {
  id: PlayerId;
  name: string;
  color: string;
  alive: boolean;
  team: number;
}

export interface Snapshot {
  tick: number;
  /** base64 of Uint8Array visibility mask (1 = currently visible) */
  visible: string;
  /** base64 of Uint8Array explored mask (1 = ever seen) */
  explored: string;
  me: {
    playerId: PlayerId;
    resources: Resources;
    pop: number;
    popCap: number;
    upgrades: UpgradeId[];
    /** current age (0 = Dark, 1 = Feudal, 2 = Imperial) */
    age: number;
    /** ms left on an in-progress age advance (0 = not advancing) */
    ageUpTimer: number;
    /** total ms of the in-progress advance (for a progress bar; 0 if idle) */
    ageUpMs: number;
    /** false once this player has been eliminated (they spectate from then on) */
    alive: boolean;
  };
  /** live alive-state of every player (for spectate awareness + event feed) */
  players: { id: PlayerId; alive: boolean }[];
  units: UnitDTO[];
  buildings: BuildingDTO[];
  resources: ResourceNodeDTO[];
  /** neutral wandering wildlife currently in view */
  animals: AnimalDTO[];
}

// ---------- Commands (client intents) ----------

export type Command =
  | { c: "move"; units: number[]; tile: Vec2; queue?: boolean }
  | { c: "gather"; units: number[]; node: number; queue?: boolean }
  | { c: "build"; unit: number; building: BuildingType; tile: Vec2 }
  | { c: "construct"; units: number[]; building: number }
  | { c: "train"; building: number; unit: UnitType }
  | { c: "cancelTrain"; building: number; index?: number }
  | { c: "research"; building: number; upgrade: UpgradeId }
  | { c: "advanceAge"; building: number }
  | { c: "rally"; building: number; tile: Vec2 }
  | { c: "attack"; units: number[]; target: number; queue?: boolean }
  | { c: "attackMove"; units: number[]; tile: Vec2; queue?: boolean }
  | { c: "stop"; units: number[] }
  | { c: "demolish"; building: number }
  | { c: "concede" };

// ---------- Client -> Server ----------

export type ClientMessage =
  | { t: "join"; name: string; clientId?: string }
  | { t: "setColor"; color: string }
  | { t: "setReady"; ready: boolean }
  | { t: "setMode"; mode: GameMode } // host only
  | { t: "setTeam"; target: PlayerId; team: number } // host only
  | { t: "startGame" }
  | { t: "setPaused"; paused: boolean } // host only, mid-match
  | { t: "command"; cmd: Command };

// ---------- Server -> Client ----------

export type ServerMessage =
  | { t: "welcome"; playerId: PlayerId }
  | { t: "lobby"; state: LobbyState }
  | { t: "gameStart"; map: GameMap; players: PlayerPublic[]; you: PlayerId; seed: number }
  | { t: "snapshot"; snap: Snapshot }
  | { t: "paused"; paused: boolean; by: PlayerId } // match frozen by the host
  | { t: "gameOver"; winner: PlayerId | null; players: PlayerPublic[]; stats: PlayerStats[] }
  | { t: "error"; message: string };

// ---------- Portable base64 for Uint8Array (works in Node + browser) ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i;
  const len = b64.length;
  let pad = 0;
  if (len >= 1 && b64[len - 1] === "=") pad++;
  if (len >= 2 && b64[len - 2] === "=") pad++;
  const outLen = (len / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[b64.charCodeAt(i)];
    const b = lookup[b64.charCodeAt(i + 1)];
    const c = lookup[b64.charCodeAt(i + 2)];
    const d = lookup[b64.charCodeAt(i + 3)];
    const n = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    if (o < outLen) out[o++] = (n >> 16) & 255;
    if (o < outLen) out[o++] = (n >> 8) & 255;
    if (o < outLen) out[o++] = n & 255;
  }
  return out;
}

