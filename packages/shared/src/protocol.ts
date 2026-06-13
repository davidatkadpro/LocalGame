// Wire protocol: every message that crosses the WebSocket.
// All messages are discriminated unions on `t`.

import type {
  BuildingType,
  GameMap,
  PlayerId,
  Resources,
  ResourceKind,
  UnitState,
  UnitType,
  Vec2,
} from "./types";

// ---------- Lobby ----------

export interface LobbySlot {
  playerId: PlayerId;
  name: string;
  color: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface LobbyState {
  slots: LobbySlot[];
  canStart: boolean;
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
}

export interface BuildingDTO {
  id: number;
  owner: PlayerId;
  type: BuildingType;
  tx: number;
  ty: number;
  hp: number;
  progress: number;
}

export interface ResourceNodeDTO {
  id: number;
  kind: ResourceKind;
  tx: number;
  ty: number;
  amount: number;
}

export interface PlayerPublic {
  id: PlayerId;
  name: string;
  color: string;
  alive: boolean;
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
  };
  units: UnitDTO[];
  buildings: BuildingDTO[];
  resources: ResourceNodeDTO[];
}

// ---------- Commands (client intents) ----------

export type Command =
  | { c: "move"; units: number[]; tile: Vec2 }
  | { c: "gather"; units: number[]; node: number }
  | { c: "build"; unit: number; building: BuildingType; tile: Vec2 }
  | { c: "train"; building: number; unit: UnitType }
  | { c: "attack"; units: number[]; target: number }
  | { c: "stop"; units: number[] };

// ---------- Client -> Server ----------

export type ClientMessage =
  | { t: "join"; name: string }
  | { t: "setColor"; color: string }
  | { t: "setReady"; ready: boolean }
  | { t: "startGame" }
  | { t: "command"; cmd: Command };

// ---------- Server -> Client ----------

export type ServerMessage =
  | { t: "welcome"; playerId: PlayerId }
  | { t: "lobby"; state: LobbyState }
  | { t: "gameStart"; map: GameMap; players: PlayerPublic[]; you: PlayerId; seed: number }
  | { t: "snapshot"; snap: Snapshot }
  | { t: "gameOver"; winner: PlayerId | null }
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

