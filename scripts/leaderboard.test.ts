// Server leaderboard: records team-aware wins by name, sorts best-first, and
// persists across instances (a stand-in for a server restart). Uses a scratch
// file via BG_LEADERBOARD so it never touches the real standings.
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), ".tmp-leaderboard.json");
process.env.BG_LEADERBOARD = FILE;
if (existsSync(FILE)) rmSync(FILE);

// Import AFTER setting the env var (the file path is read at module load).
const { Leaderboard } = await import("../packages/server/src/leaderboard.ts");

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

{
  const lb = new Leaderboard();
  // Alice beats Bob; then a 2v2 where the Cara+Dan team wins.
  lb.record(["Alice", "Bob"], ["Alice"]);
  lb.record(["Alice", "Bob", "Cara", "Dan"], ["Cara", "Dan"]);
  const s = lb.standings();
  const byName = Object.fromEntries(s.map((e) => [e.name, e]));
  check("a winner's win is recorded", byName["Alice"].wins === 1);
  check("both winners on a team get the win", byName["Cara"].wins === 1 && byName["Dan"].wins === 1);
  check("games are counted for every participant", byName["Bob"].games === 2 && byName["Alice"].games === 2);
  check("a non-winner has zero wins", byName["Bob"].wins === 0);
  check("standings are sorted by wins (winners first)", s[0].wins >= s[s.length - 1].wins);
  check("top 3 fits the lobby panel", lb.standings(3).length === 3);
}

{
  // A fresh instance must reload the persisted file (survives a restart).
  const lb2 = new Leaderboard();
  const s = lb2.standings();
  const alice = s.find((e) => e.name === "Alice");
  check("standings persist across instances", !!alice && alice.wins === 1 && alice.games === 2);
}

if (existsSync(FILE)) rmSync(FILE);
console.log(pass ? "LEADERBOARD: PASS ✅" : "LEADERBOARD: FAIL ❌");
process.exit(pass ? 0 : 1);
