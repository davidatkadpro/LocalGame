// A single game room: manages the lobby, then runs one authoritative match.
// For LAN play we host exactly one room (one game at a time).

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  TICK_MS,
  applyCommand,
  createFog,
  createWorld,
  tick,
  viewFor,
  type ClientMessage,
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

export class GameRoom {
  private slots = new Map<number, Slot>(); // playerId -> slot
  private mode: GameMode = "ffa";
  private phase: Phase = "lobby";
  private world: World | null = null;
  private fog: Fog | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private hostPlayerId: number | null = null;
  private conns = new Set<Conn>();
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
  }

  onMessage(conn: Conn, msg: ClientMessage): void {
    switch (msg.t) {
      case "join":
        this.handleJoin(conn, msg.name, msg.clientId);
        break;
      case "setColor":
        this.withSlot(conn, (slot) => {
          if (this.colorTaken(msg.color, conn.playerId!)) return;
          slot.color = msg.color;
          this.broadcastLobby();
        });
        break;
      case "setReady":
        this.withSlot(conn, (slot) => {
          slot.ready = msg.ready;
          this.broadcastLobby();
        });
        break;
      case "setMode":
        // Host only. Switching to 2v2 seeds default teams; FFA gives each its own.
        if (conn.playerId === this.hostPlayerId && this.phase === "lobby") {
          this.mode = msg.mode;
          this.assignDefaultTeams();
          this.broadcastLobby();
        }
        break;
      case "setTeam":
        // Host only: assign a player to team 0 or 1 (2v2).
        if (conn.playerId === this.hostPlayerId && this.phase === "lobby") {
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
      case "command":
        if (this.phase === "playing" && this.world && conn.playerId !== null) {
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
    if (!this.world || !this.fog) return;
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
