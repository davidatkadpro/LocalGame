import { useEffect } from "react";
import { useStore } from "./net/store";
import { Lobby } from "./ui/Lobby";
import { Game } from "./ui/Game";

export function App() {
  const phase = useStore((s) => s.phase);
  const error = useStore((s) => s.error);
  const connect = useStore((s) => s.connect);
  const winner = useStore((s) => s.winner);
  const myId = useStore((s) => s.myPlayerId);
  const players = useStore((s) => s.players);

  useEffect(() => {
    connect();
  }, [connect]);

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

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
        <div className="screen center">
          <div className="card">
            <h1>{winner === myId ? "Victory! 🏆" : "Game over"}</h1>
            <p className="muted">
              {winner === null
                ? "No survivors."
                : `Winner: ${players.find((p) => p.id === winner)?.name ?? `Player ${winner + 1}`}`}
            </p>
            <button className="primary" onClick={() => location.reload()}>
              Back to lobby
            </button>
          </div>
        </div>
      )}
    </>
  );
}
