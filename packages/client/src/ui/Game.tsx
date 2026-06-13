import { useEffect, useRef } from "react";
import type { BuildingType } from "@bg/shared";
import { PixiGame } from "../game/PixiGame";
import { Hud } from "./Hud";
import { Minimap } from "./Minimap";

export function Game() {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<PixiGame | null>(null);

  useEffect(() => {
    const g = new PixiGame();
    gameRef.current = g;
    if (hostRef.current) void g.init(hostRef.current);
    return () => {
      gameRef.current = null;
      g.destroy();
    };
  }, []);

  const onPlace = (b: BuildingType) => gameRef.current?.setPlacing(b);
  const onAttackMove = () => gameRef.current?.armAttackMove();
  const onIdleWorker = () => gameRef.current?.selectNextIdleWorker();
  const onSelectMode = () => gameRef.current?.armSelectMode();
  const getViewport = () => gameRef.current?.getViewport();

  return (
    <div className="game">
      <div className="canvas-host" ref={hostRef} />
      <Minimap getViewport={getViewport} />
      <Hud
        onPlace={onPlace}
        onAttackMove={onAttackMove}
        onIdleWorker={onIdleWorker}
        onSelectMode={onSelectMode}
      />
    </div>
  );
}
