import { useEffect, useRef } from "react";
import type { PlayerPublic, PlayerStats } from "@bg/shared";
import { useStore } from "./net/store";
import { Lobby } from "./ui/Lobby";
import { Game } from "./ui/Game";
import { sfx } from "./game/audio";

export function App() {
  const phase = useStore((s) => s.phase);
  const error = useStore((s) => s.error);
  const connect = useStore((s) => s.connect);
  const winner = useStore((s) => s.winner);
  const myId = useStore((s) => s.myPlayerId);
  const players = useStore((s) => s.players);
  const endPlayers = useStore((s) => s.endPlayers);
  const endStats = useStore((s) => s.endStats);
  const reconnecting = useStore((s) => s.reconnecting);

  // Team-aware outcome: a teammate winning is still a victory for me.
  const roster = endPlayers.length ? endPlayers : players;
  const winnerTeam = winner !== null ? roster.find((p) => p.id === winner)?.team : undefined;
  const myTeam = roster.find((p) => p.id === myId)?.team;
  const iWon = winner !== null && winnerTeam !== undefined && winnerTeam === myTeam;
  const winners = winnerTeam !== undefined ? roster.filter((p) => p.team === winnerTeam) : [];

  useEffect(() => {
    connect();
  }, [connect]);

  // Play the end jingle exactly once per match, not every time winner/myId
  // change while the over-screen stays up.
  const playedEnd = useRef(false);
  useEffect(() => {
    if (phase !== "over") {
      playedEnd.current = false;
      return;
    }
    if (playedEnd.current) return;
    playedEnd.current = true;
    if (iWon) sfx.win();
    else sfx.lose();
  }, [phase, iWon]);

  return (
    <>
      {reconnecting && phase !== "over" && (
        <div className="error-banner reconnecting">Connection lost — reconnecting…</div>
      )}
      {error && !reconnecting && <div className="error-banner">{error}</div>}

      {phase === "connecting" && (
        <div className="screen center">
          <div className="card">
            <h1>BuilderGame</h1>
            <p className="muted">Connecting to host…</p>
          </div>
        </div>
      )}

      {(phase === "naming" || phase === "lobby") && <Lobby />}

      {phase === "playing" && <Game />}

      {phase === "over" && (
        <div className="screen center over-screen">
          <div className="card wide">
            <h1>{iWon ? "Victory! 🏆" : "Game over"}</h1>
            <p className="muted">
              {winner === null || winners.length === 0
                ? "No survivors."
                : winners.length > 1
                  ? `Winners: ${winners.map((w) => w.name).join(" & ")}`
                  : `Winner: ${winners[0].name}`}
            </p>
            {endStats.length > 0 && (
              <Scoreboard
                players={roster}
                stats={endStats}
                winnerTeam={winnerTeam}
                myId={myId}
              />
            )}
            <button className="primary" onClick={() => location.reload()}>
              Back to lobby
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Scoreboard({
  players,
  stats,
  winnerTeam,
  myId,
}: {
  players: PlayerPublic[];
  stats: PlayerStats[];
  winnerTeam: number | undefined;
  myId: number | null;
}) {
  // Winning team first, then by resources gathered (a rough "economy" rank).
  const rows = players
    .map((p) => ({ p, s: stats[p.id] }))
    .filter((r) => r.s)
    .sort((a, b) => {
      const aw = a.p.team === winnerTeam ? 1 : 0;
      const bw = b.p.team === winnerTeam ? 1 : 0;
      if (aw !== bw) return bw - aw;
      return b.s.resourcesGathered - a.s.resourcesGathered;
    });
  return (
    <table className="scoreboard">
      <thead>
        <tr>
          <th>Player</th>
          <th title="Units trained">Trained</th>
          <th title="Units lost">Lost</th>
          <th title="Resources gathered">Gathered</th>
          <th title="Peak population">Peak</th>
          <th title="Buildings constructed">Built</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ p, s }) => (
          <tr key={p.id} className={p.team === winnerTeam ? "winner" : ""}>
            <td>
              <span className="dot" style={{ background: p.color }} />
              {p.name}
              {p.team === winnerTeam ? " 🏆" : ""}
              {p.id === myId ? " (you)" : ""}
            </td>
            <td>{s.unitsTrained}</td>
            <td>{s.unitsLost}</td>
            <td>{Math.floor(s.resourcesGathered)}</td>
            <td>{s.peakPop}</td>
            <td>{s.buildingsBuilt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
