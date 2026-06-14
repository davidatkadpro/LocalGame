// Persistent, name-keyed match standings for the lobby leaderboard. Survives
// server restarts by reading/writing a small JSON file on the host.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LeaderboardEntry } from "@bg/shared";

const FILE = process.env.BG_LEADERBOARD ?? resolve(process.cwd(), "leaderboard.json");

export class Leaderboard {
  private entries = new Map<string, { wins: number; games: number }>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(FILE)) return;
      const raw = JSON.parse(readFileSync(FILE, "utf8")) as LeaderboardEntry[];
      if (!Array.isArray(raw)) return;
      for (const e of raw) {
        if (e && typeof e.name === "string") {
          this.entries.set(e.name, { wins: e.wins | 0, games: e.games | 0 });
        }
      }
    } catch {
      // Corrupt/unreadable file: start fresh rather than crash the host.
    }
  }

  private save(): void {
    try {
      writeFileSync(FILE, JSON.stringify(this.standings(1000)), "utf8");
    } catch {
      // Read-only filesystem etc.: keep standings in memory, just don't persist.
    }
  }

  private entry(name: string) {
    const key = name.trim();
    let e = this.entries.get(key);
    if (!e) {
      e = { wins: 0, games: 0 };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Record a finished match: +1 game for every participant, +1 win for each
   *  winner (team-aware — pass every winning player's name). Keyed by name. */
  record(participants: string[], winners: string[]): void {
    for (const name of participants) if (name.trim()) this.entry(name).games += 1;
    for (const name of winners) if (name.trim()) this.entry(name).wins += 1;
    this.save();
  }

  /** Standings sorted best-first (wins, then games, then name). */
  standings(limit = 20): LeaderboardEntry[] {
    return [...this.entries.entries()]
      .map(([name, v]) => ({ name, wins: v.wins, games: v.games }))
      .sort((a, b) => b.wins - a.wins || b.games - a.games || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
}
