import { useEffect, useRef } from "react";
import type { BuildingType } from "@bg/shared";
import { PixiGame } from "../game/PixiGame";
import { Hud } from "./Hud";

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

  return (
    <div className="game">
      <div className="canvas-host" ref={hostRef} />
      <Hud onPlace={onPlace} />
    </div>
  );
}
