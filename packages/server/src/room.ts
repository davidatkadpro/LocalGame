// A single game room: manages the lobby, then runs one authoritative match.
// For LAN play we host exactly one room (one game at a time).

import {
  BUILDING_DEFS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  TICK_MS,
  UNIT_DEFS,
  UPGRADE_DEFS,
  applyCommand,
  createFog,
  createWorld,
  tick,
  viewFor,
  type ClientMessage,
  type Command,
  type Fog,
  type GameMode,
  type LeaderboardEntry,
  type LobbySlot,
  type PlayerPublic,
  type ServerMessage,
  type World,
} from "@bg/shared";
import { Leaderboard } from "./leaderboard";

export interface Conn {
  id: number;
  send(msg: ServerMessage): void;
  close(): void;
  // assigned when the connection takes a lobby slot
  playerId: number | null;
}

interface Slot {
  conn: Conn | null;
  clientId: string;
  name: string;
  color: string;
  ready: boolean;
  connected: boolean;
  team: number;
}

type Phase = "lobby" | "playing" | "over";

// ---- client-input validation (the server is the trust boundary) ----
// Clients are untrusted: a malformed or hostile packet must be dropped, never
// crash the host or reach the sim with a bad shape. These run before anything is
// applied to the authoritative world.
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// Cap the id list so a single command can't make the sim iterate an enormous
// array (no real selection approaches this).
const isIdList = (v: unknown): boolean => Array.isArray(v) && v.length <= 1000 && v.every(isNum);
const isTile = (v: unknown): boolean =>
  !!v && typeof v === "object" && isNum((v as { x: unknown }).x) && isNum((v as { y: unknown }).y);

/** Validate a client Command's shape — including that building/unit/upgrade names
 *  are real keys — so applyCommand never dereferences an unknown def or iterates
 *  a non-array. */
function isValidCommand(cmd: unknown): cmd is Command {
  if (!cmd || typeof cmd !== "object") return false;
  const c = cmd as Record<string, unknown>;
  switch (c.c) {
    case "move":
    case "attackMove":
    case "patrol":
      return isIdList(c.units) && isTile(c.tile);
    case "gather":
      return isIdList(c.units) && isNum(c.node);
    case "build":
      return (
        isNum(c.unit) && isTile(c.tile) && typeof c.building === "string" && c.building in BUILDING_DEFS
      );
    case "construct":
      return isIdList(c.units) && isNum(c.building);
    case "train":
      return isNum(c.building) && typeof c.unit === "string" && c.unit in UNIT_DEFS;
    case "cancelTrain":
    case "advanceAge":
    case "demolish":
      return isNum(c.building);
    case "research":
      return isNum(c.building) && typeof c.upgrade === "string" && c.upgrade in UPGRADE_DEFS;
    case "rally":
      return isNum(c.building) && isTile(c.tile);
    case "attack":
      return isIdList(c.units) && isNum(c.target);
    case "setStance":
      return (
        isIdList(c.units) &&
        (c.stance === "aggressive" ||
          c.stance === "defensive" ||
          c.stance === "standGround" ||
          c.stance === "noAttack")
      );
    case "stop":
      return isIdList(c.units);
    case "concede":
      return true;
    default:
      return false;
  }
}

export class GameRoom {
  private slots = new Map<number, Slot>(); // playerId -> slot
  private mode: GameMode = "ffa";
  private phase: Phase = "lobby";
  private world: World | null = null;
  private fog: Fog | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private hostPlayerId: number | null = null;
  private conns = new Set<Conn>();
  private paused = false; // host can freeze a running match
  // Persisted all-time standings (survives matches and server restarts).
  private leaderboard = new Leaderboard();

  // ---- connection lifecycle ----

  onConnect(conn: Conn): void {
    // A finished game frees the room for a fresh lobby (e.g. a rematch).
    if (this.phase === "over") this.reset();
    this.conns.add(conn);
    // Spectator until they `join`. During a match we wait for the join message
    // before deciding whether this is a reconnect or a rejected newcomer.
    if (this.phase === "lobby") this.broadcastLobby();
  }

  onDisconnect(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.playerId !== null) {
      const slot = this.slots.get(conn.playerId);
      if (slot && slot.conn === conn) {
        slot.conn = null;
        slot.connected = false;
        if (this.phase === "lobby") {
          // In the lobby, a drop frees the slot entirely.
          this.slots.delete(conn.playerId);
          if (this.hostPlayerId === conn.playerId) this.hostPlayerId = this.firstSlotId();
        }
        // During a match the slot is kept so the player can reconnect; their
        // units keep being simulated in the meantime.
      }
    }
    // If everyone is gone, return the room to a clean lobby.
    if (this.conns.size === 0) {
      this.reset();
      return;
    }
    if (this.phase === "lobby") this.broadcastLobby();
  }

  /** Tear down any running match and return to an empty lobby. */
  private reset(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.world = null;
    this.fog = null;
    this.slots.clear();
    this.hostPlayerId = null;
    this.mode = "ffa";
    this.phase = "lobby";
    this.paused = false;
  }

  /** Freeze or unfreeze the match and tell every connected player. */
  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    const by = this.hostPlayerId ?? 0;
    for (const s of this.slots.values()) s.conn?.send({ t: "paused", paused, by });
  }

  onMessage(conn: Conn, msg: ClientMessage): void {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "join":
        // name/clientId arrive from JSON; only accept strings (handleJoin slices
        // the name, which would throw on a number/object).
        if (typeof msg.name === "string") {
          this.handleJoin(conn, msg.name, typeof msg.clientId === "string" ? msg.clientId : undefined);
        }
        break;
      case "setColor":
        // Only a real palette colour — a client can't inject an arbitrary string.
        if (typeof msg.color === "string" && PLAYER_COLORS.includes(msg.color)) {
          this.withSlot(conn, (slot) => {
            if (this.colorTaken(msg.color, conn.playerId!)) return;
            slot.color = msg.color;
            this.broadcastLobby();
          });
        }
        break;
      case "setReady":
        if (typeof msg.ready === "boolean") {
          this.withSlot(conn, (slot) => {
            slot.ready = msg.ready;
            this.broadcastLobby();
          });
        }
        break;
      case "setMode":
        // Host only. Switching to 2v2 seeds default teams; FFA gives each its own.
        if (
          (msg.mode === "ffa" || msg.mode === "2v2") &&
          conn.playerId === this.hostPlayerId &&
          this.phase === "lobby"
        ) {
          this.mode = msg.mode;
          this.assignDefaultTeams();
          this.broadcastLobby();
        }
        break;
      case "setTeam":
        // Host only: assign a player to team 0 or 1 (2v2).
        if (conn.playerId === this.hostPlayerId && this.phase === "lobby" && isNum(msg.target)) {
          const slot = this.slots.get(msg.target);
          if (slot && (msg.team === 0 || msg.team === 1)) {
            slot.team = msg.team;
            this.broadcastLobby();
          }
        }
        break;
      case "startGame":
        if (conn.playerId === this.hostPlayerId) this.startGame();
        break;
      case "setPaused":
        // Host freezes/unfreezes a running match (e.g. someone stepped away).
        if (
          typeof msg.paused === "boolean" &&
          conn.playerId === this.hostPlayerId &&
          this.phase === "playing"
        ) {
          this.setPaused(msg.paused);
        }
        break;
      case "command":
        // Commands are dropped while paused so the freeze is a true stop, and the
        // shape is validated first so a malformed packet can't crash the sim.
        if (
          this.phase === "playing" &&
          !this.paused &&
          this.world &&
          conn.playerId !== null &&
          isValidCommand(msg.cmd)
        ) {
          applyCommand(this.world, conn.playerId, msg.cmd);
        }
        break;
    }
  }

  // ---- lobby / join / reconnect ----

  private handleJoin(conn: Conn, name: string, clientId?: string): void {
    if (conn.playerId !== null) return; // already joined on this socket
    // Clients that don't supply an id (e.g. test bots) get an ephemeral one.
    const cid = clientId || `anon-${conn.id}`;

    // Reconnect: an existing slot for this client (kept alive during a match).
    const existing = [...this.slots.entries()].find(([, s]) => s.clientId === cid);
    if (existing) {
      const [pid, slot] = existing;
      if (slot.conn && slot.conn !== conn) slot.conn.close();
      slot.conn = conn;
      slot.connected = true;
      conn.playerId = pid;
      if (this.phase === "playing" && this.world) {
        this.sendGameStart(conn, pid); // resync the match state
        // One immediate snapshot + the freeze state, so reconnecting mid-pause
        // shows the frozen board rather than a blank one.
        if (this.fog) conn.send({ t: "snapshot", snap: viewFor(this.world, this.fog, pid) });
        if (this.paused) conn.send({ t: "paused", paused: true, by: this.hostPlayerId ?? pid });
      } else {
        conn.send({ t: "welcome", playerId: pid });
        this.broadcastLobby();
      }
      return;
    }

    // A brand-new player can only join from the lobby.
    if (this.phase !== "lobby") {
      conn.send({ t: "error", message: "A game is already in progress." });
      return;
    }
    const id = this.freeSlotId();
    if (id === null) {
      conn.send({ t: "error", message: "Lobby is full." });
      return;
    }
    conn.playerId = id;
    const color = this.freeColor();
    this.slots.set(id, {
      conn,
      clientId: cid,
      name: name.slice(0, 16) || `Player ${id + 1}`,
      color,
      ready: false,
      connected: true,
      team: id, // FFA default: own team; host reassigns in 2v2
    });
    if (this.hostPlayerId === null) this.hostPlayerId = id;
    conn.send({ t: "welcome", playerId: id });
    this.broadcastLobby();
  }

  private withSlot(conn: Conn, fn: (slot: Slot) => void): void {
    if (conn.playerId === null) return;
    const slot = this.slots.get(conn.playerId);
    if (slot) fn(slot);
  }

  private lobbyState(): {
    slots: LobbySlot[];
    canStart: boolean;
    mode: GameMode;
    leaderboard: LeaderboardEntry[];
  } {
    const slots: LobbySlot[] = [...this.slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([playerId, s]) => ({
        playerId,
        name: s.name,
        color: s.color,
        ready: s.ready,
        connected: s.connected,
        isHost: playerId === this.hostPlayerId,
        team: s.team,
      }));
    const ready = slots.filter((s) => s.ready).length;
    const allReady = slots.length >= MIN_PLAYERS && ready === slots.length;
    let canStart = allReady;
    if (this.mode === "2v2") {
      // Need exactly 4 players, all ready, split 2-and-2 across teams 0 and 1.
      const t0 = slots.filter((s) => s.team === 0).length;
      const t1 = slots.filter((s) => s.team === 1).length;
      canStart = allReady && slots.length === 4 && t0 === 2 && t1 === 2;
    }
    return { slots, canStart, mode: this.mode, leaderboard: this.leaderboard.standings() };
  }

  /** Seed teams when the mode changes: 2v2 splits current slots 2-and-2; FFA
   *  gives each player their own team. */
  private assignDefaultTeams(): void {
    const ids = [...this.slots.keys()].sort((a, b) => a - b);
    ids.forEach((id, i) => {
      const slot = this.slots.get(id)!;
      slot.team = this.mode === "2v2" ? (i < 2 ? 0 : 1) : id;
    });
  }

  private broadcastLobby(): void {
    const state = this.lobbyState();
    for (const s of this.slots.values()) s.conn?.send({ t: "lobby", state });
  }

  // ---- match ----

  private startGame(): void {
    const state = this.lobbyState();
    if (!state.canStart) return;
    this.phase = "playing";
    this.paused = false;

    const ordered = [...this.slots.entries()].sort((a, b) => a[0] - b[0]);
    // Re-pack player ids to 0..n-1 so the sim has contiguous slots. In FFA each
    // packed player is its own team; in 2v2 we carry the host-assigned team.
    const seeds = ordered.map(([, s], i) => ({
      name: s.name,
      color: s.color,
      team: this.mode === "2v2" ? s.team : i,
    }));
    const seed = (Math.floor(performance.now()) ^ (ordered.length * 2654435761)) >>> 0;
    this.world = createWorld(seed, seeds);
    this.fog = createFog(this.world);

    // Rebuild slot map under packed ids, carrying clientId across so a dropped
    // player can be matched back to their packed sim slot on reconnect.
    const repacked = new Map<number, Slot>();
    ordered.forEach(([, s], simId) => {
      if (s.conn) s.conn.playerId = simId;
      repacked.set(simId, s);
      this.sendGameStart(s.conn, simId);
    });
    this.slots = repacked;
    this.hostPlayerId = 0;

    this.loop = setInterval(() => this.step(), TICK_MS);
  }

  private playersPublic(): PlayerPublic[] {
    return this.world!.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      alive: p.alive,
      team: p.team,
    }));
  }

  private sendGameStart(conn: Conn | null, you: number): void {
    if (!conn || !this.world) return;
    conn.send({
      t: "gameStart",
      map: this.world.map,
      players: this.playersPublic(),
      you,
      seed: this.world.seed,
    });
  }

  private step(): void {
    if (!this.world || !this.fog || this.paused) return; // frozen while paused
    tick(this.world, this.fog);

    for (const [playerId, slot] of this.slots) {
      if (slot.connected && slot.conn) {
        slot.conn.send({ t: "snapshot", snap: viewFor(this.world, this.fog, playerId) });
      }
    }

    if (this.world.winner !== null || this.aliveCount() <= 1) {
      this.endGame();
    }
  }

  private aliveCount(): number {
    return this.world ? this.world.players.filter((p) => p.alive).length : 0;
  }

  private endGame(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.phase = "over";
    const winner = this.world?.winner ?? null;
    const players = this.world ? this.playersPublic() : [];
    const stats = this.world ? this.world.stats : [];
    this.recordResult(winner, players);
    for (const s of this.slots.values()) s.conn?.send({ t: "gameOver", winner, players, stats });
  }

  /** Fold a finished match into the persisted leaderboard (team-aware win). */
  private recordResult(winner: number | null, players: PlayerPublic[]): void {
    if (players.length === 0) return;
    const participants = players.map((p) => p.name);
    let winners: string[] = [];
    if (winner !== null) {
      const wteam = players.find((p) => p.id === winner)?.team;
      winners = players.filter((p) => p.team === wteam).map((p) => p.name);
    }
    this.leaderboard.record(participants, winners);
  }

  // ---- helpers ----

  private freeSlotId(): number | null {
    for (let i = 0; i < MAX_PLAYERS; i++) if (!this.slots.has(i)) return i;
    return null;
  }

  private firstSlotId(): number | null {
    const ids = [...this.slots.keys()].sort((a, b) => a - b);
    return ids.length ? ids[0] : null;
  }

  private colorTaken(color: string, exceptId: number): boolean {
    for (const [id, s] of this.slots) if (id !== exceptId && s.color === color) return true;
    return false;
  }

  private freeColor(): string {
    for (const c of PLAYER_COLORS) {
      if (![...this.slots.values()].some((s) => s.color === c)) return c;
    }
    return PLAYER_COLORS[0];
  }
}
