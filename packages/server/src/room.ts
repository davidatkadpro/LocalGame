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
  type LobbySlot,
  type PlayerPublic,
  type ServerMessage,
  type World,
} from "@bg/shared";

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
}

type Phase = "lobby" | "playing" | "over";

export class GameRoom {
  private slots = new Map<number, Slot>(); // playerId -> slot
  private phase: Phase = "lobby";
  private world: World | null = null;
  private fog: Fog | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private hostPlayerId: number | null = null;
  private conns = new Set<Conn>();

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

  private lobbyState(): { slots: LobbySlot[]; canStart: boolean } {
    const slots: LobbySlot[] = [...this.slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([playerId, s]) => ({
        playerId,
        name: s.name,
        color: s.color,
        ready: s.ready,
        connected: s.connected,
        isHost: playerId === this.hostPlayerId,
      }));
    const ready = slots.filter((s) => s.ready).length;
    const canStart = slots.length >= MIN_PLAYERS && ready === slots.length;
    return { slots, canStart };
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
    // Re-pack player ids to 0..n-1 so the sim has contiguous slots.
    const seeds = ordered.map(([, s]) => ({ name: s.name, color: s.color }));
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
    for (const s of this.slots.values()) s.conn?.send({ t: "gameOver", winner });
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
