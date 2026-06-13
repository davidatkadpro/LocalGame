import { useEffect, useRef } from "react";
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
  const reconnecting = useStore((s) => s.reconnecting);

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
    if (winner === myId) sfx.win();
    else sfx.lose();
  }, [phase, winner, myId]);

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
