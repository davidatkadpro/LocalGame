import { useEffect, useRef, useState } from "react";
import type { BuildingType } from "@bg/shared";
import { PixiGame } from "../game/PixiGame";
import { Hud } from "./Hud";
import { Minimap } from "./Minimap";
import { EventFeed } from "./EventFeed";
import { useIsMobile } from "./useIsMobile";

export function Game() {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<PixiGame | null>(null);
  const isMobile = useIsMobile();
  // On phones the minimap is hidden behind a tab toggle to reclaim screen; on
  // desktop it is always shown.
  const [minimapOpen, setMinimapOpen] = useState(false);

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
  const onSelectIds = (ids: number[]) => gameRef.current?.setSelectionIds(ids);
  const getViewport = () => gameRef.current?.getViewport();

  return (
    <div className="game">
      <div className="canvas-host" ref={hostRef} />
      {(!isMobile || minimapOpen) && <Minimap getViewport={getViewport} />}
      <EventFeed />
      <Hud
        onPlace={onPlace}
        onAttackMove={onAttackMove}
        onIdleWorker={onIdleWorker}
        onSelectMode={onSelectMode}
        onSelectIds={onSelectIds}
        isMobile={isMobile}
        minimapOpen={minimapOpen}
        onToggleMinimap={() => setMinimapOpen((v) => !v)}
      />
    </div>
  );
}
