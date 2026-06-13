import { useState } from "react";
import { MAX_PLAYERS, PLAYER_COLORS } from "@bg/shared";
import { useStore } from "../net/store";

export function Lobby() {
  const phase = useStore((s) => s.phase);
  const lobby = useStore((s) => s.lobby);
  const myId = useStore((s) => s.myPlayerId);
  const join = useStore((s) => s.join);
  const setColor = useStore((s) => s.setColor);
  const setReady = useStore((s) => s.setReady);
  const startGame = useStore((s) => s.startGame);

  const [name, setName] = useState("");

  if (phase === "naming" || myId === null) {
    return (
      <div className="screen center">
        <div className="card">
          <h1>BuilderGame</h1>
          <p className="muted">Enter a name to join the lobby.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              join(name.trim() || "Player");
            }}
          >
            <input
              autoFocus
              maxLength={16}
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit">Join</button>
          </form>
        </div>
      </div>
    );
  }

  const mine = lobby?.slots.find((s) => s.playerId === myId);
  const iAmHost = mine?.isHost ?? false;

  return (
    <div className="screen center">
      <div className="card wide">
        <h1>Lobby</h1>
        <div className="slots">
          {Array.from({ length: MAX_PLAYERS }).map((_, i) => {
            const slot = lobby?.slots.find((s) => s.playerId === i);
            return (
              <div className={`slot ${slot ? "filled" : "empty"}`} key={i}>
                {slot ? (
                  <>
                    <span className="dot" style={{ background: slot.color }} />
                    <span className="slot-name">
                      {slot.name}
                      {slot.isHost ? " 👑" : ""}
                      {slot.playerId === myId ? " (you)" : ""}
                    </span>
                    <span className={`tag ${slot.ready ? "ready" : ""}`}>
                      {slot.ready ? "Ready" : "Not ready"}
                    </span>
                  </>
                ) : (
                  <span className="muted">Open slot</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="row">
          <span className="muted">Colour:</span>
          {PLAYER_COLORS.map((c) => {
            const taken = lobby?.slots.some((s) => s.color === c && s.playerId !== myId);
            return (
              <button
                key={c}
                className={`swatch ${mine?.color === c ? "active" : ""}`}
                style={{ background: c, opacity: taken ? 0.3 : 1 }}
                disabled={taken}
                onClick={() => setColor(c)}
                aria-label={`colour ${c}`}
              />
            );
          })}
        </div>

        <div className="row">
          <button onClick={() => setReady(!mine?.ready)}>
            {mine?.ready ? "Cancel ready" : "Ready up"}
          </button>
          {iAmHost && (
            <button className="primary" disabled={!lobby?.canStart} onClick={startGame}>
              Start game
            </button>
          )}
        </div>
        {!lobby?.canStart && (
          <p className="muted small">Need 2–4 players, all ready, to start.</p>
        )}
      </div>
    </div>
  );
}
