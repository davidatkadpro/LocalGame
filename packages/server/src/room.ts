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
  conn: Conn;
  name: string;
  color: string;
  ready: boolean;
}

type Phase = "lobby" | "playing" | "over";

export class GameRoom {
  private slots = new Map<number, Slot>(); // playerId -> slot
  private phase: Phase = "lobby";
  private world: World | null = null;
  private fog: Fog | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private hostPlayerId: number | null = null;

  // ---- connection lifecycle ----

  onConnect(conn: Conn): void {
    if (this.phase !== "lobby") {
      conn.send({ t: "error", message: "A game is already in progress." });
      conn.close();
      return;
    }
    // Spectator until they `join`. Send current lobby so they can see it.
    this.broadcastLobby();
  }

  onDisconnect(conn: Conn): void {
    if (conn.playerId === null) return;
    this.slots.delete(conn.playerId);
    if (this.hostPlayerId === conn.playerId) {
      this.hostPlayerId = this.firstSlotId();
    }
    if (this.phase === "lobby") this.broadcastLobby();
    // (M2) handle mid-game disconnects / reconnects
  }

  onMessage(conn: Conn, msg: ClientMessage): void {
    switch (msg.t) {
      case "join":
        this.handleJoin(conn, msg.name);
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

  // ---- lobby ----

  private handleJoin(conn: Conn, name: string): void {
    if (conn.playerId !== null) return; // already joined
    if (this.phase !== "lobby") {
      conn.send({ t: "error", message: "Game already started." });
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
      name: name.slice(0, 16) || `Player ${id + 1}`,
      color,
      ready: false,
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
        connected: true,
        isHost: playerId === this.hostPlayerId,
      }));
    const ready = slots.filter((s) => s.ready).length;
    const canStart = slots.length >= MIN_PLAYERS && ready === slots.length;
    return { slots, canStart };
  }

  private broadcastLobby(): void {
    const state = this.lobbyState();
    for (const s of this.slots.values()) s.conn.send({ t: "lobby", state });
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

    const players: PlayerPublic[] = this.world.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      alive: p.alive,
    }));

    // Map each connection's lobby slot to its packed sim player id.
    ordered.forEach(([, s], simId) => {
      s.conn.playerId = simId;
      s.conn.send({
        t: "gameStart",
        map: this.world!.map,
        players,
        you: simId,
        seed,
      });
    });

    // Rebuild slot map under packed ids.
    const repacked = new Map<number, Slot>();
    ordered.forEach(([, s], simId) => repacked.set(simId, s));
    this.slots = repacked;

    this.loop = setInterval(() => this.step(), TICK_MS);
  }

  private step(): void {
    if (!this.world || !this.fog) return;
    tick(this.world, this.fog);

    for (const [playerId, slot] of this.slots) {
      slot.conn.send({ t: "snapshot", snap: viewFor(this.world, this.fog, playerId) });
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
    for (const s of this.slots.values()) s.conn.send({ t: "gameOver", winner });
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
