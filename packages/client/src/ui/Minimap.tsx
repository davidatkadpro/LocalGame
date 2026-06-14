import { useEffect, useRef } from "react";
import { BUILDING_DEFS, base64ToBytes, type BuildingType, type Terrain } from "@bg/shared";
import { useStore } from "../net/store";

const SIZE = 180;

const MM_TERRAIN: Record<Terrain, string> = {
  grass: "#2f4d24",
  water: "#1d4a78",
  forest: "#243d1a",
  rock: "#4a4a4a",
};

interface MinimapProps {
  getViewport: () => { x: number; y: number; w: number; h: number } | undefined;
}

export function Minimap({ getViewport }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Hold the latest getViewport in a ref so the rAF loop can stay mounted once
  // for the component's lifetime instead of tearing down whenever the parent
  // passes a fresh closure (which previously caused the loop to churn/stall).
  const viewportRef = useRef(getViewport);
  viewportRef.current = getViewport;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Scale the backing store by devicePixelRatio so the minimap stays crisp on
    // high-DPI tablets (a fixed 180×180 store looked blurry/"frozen" there).
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;

    let raf = 0;
    let alive = true;

    const draw = () => {
      // One bad frame must never kill the loop, so guard the whole body and
      // always re-arm in `finally`.
      try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { map, curr, players, myPlayerId, pings } = useStore.getState();
        if (map && curr) {
          const mw = map.width;
          const mh = map.height;
          const sx = SIZE / mw;
          const sy = SIZE / mh;
          const colorOf = (owner: number) =>
            players.find((p) => p.id === owner)?.color ?? "#ffffff";

          ctx.fillStyle = "#05070a";
          ctx.fillRect(0, 0, SIZE, SIZE);

          const exp = base64ToBytes(curr.explored);
          for (let y = 0; y < mh; y++) {
            for (let x = 0; x < mw; x++) {
              if (exp[y * mw + x] !== 1) continue;
              ctx.fillStyle = MM_TERRAIN[map.tiles[y * mw + x]];
              ctx.fillRect(x * sx, y * sy, sx + 0.6, sy + 0.6);
            }
          }

          for (const n of curr.resources) {
            ctx.fillStyle =
              n.kind === "wood"
                ? "#37b24d"
                : n.kind === "gold"
                  ? "#f1c40f"
                  : n.kind === "stone"
                    ? "#adb5bd"
                    : "#e03131";
            ctx.fillRect(n.tx * sx, n.ty * sy, sx + 0.6, sy + 0.6);
          }
          for (const b of curr.buildings) {
            ctx.fillStyle = colorOf(b.owner);
            const bd = BUILDING_DEFS[b.type as BuildingType].size;
            ctx.fillRect(b.tx * sx - 0.5, b.ty * sy - 0.5, sx * bd.w + 1, sy * bd.h + 1);
          }
          for (const u of curr.units) {
            ctx.fillStyle = colorOf(u.owner);
            const s = u.owner === myPlayerId ? 3 : 2.5;
            ctx.fillRect(u.x * sx - s / 2, u.y * sy - s / 2, s, s);
          }

          // "under attack" pings: expanding red rings that fade over ~2.5s
          const now = performance.now();
          for (const p of pings) {
            const age = now - p.born;
            if (age < 0 || age > 2500) continue;
            const k = age / 2500;
            ctx.strokeStyle = `rgba(255,70,70,${(1 - k) * 0.9})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x * sx, p.y * sy, 2 + k * 12, 0, Math.PI * 2);
            ctx.stroke();
          }

          // viewport rectangle
          const vp = viewportRef.current();
          if (vp) {
            ctx.strokeStyle = "rgba(255,255,255,0.85)";
            ctx.lineWidth = 1;
            ctx.strokeRect(
              (vp.x - vp.w / 2) * sx,
              (vp.y - vp.h / 2) * sy,
              vp.w * sx,
              vp.h * sy,
            );
          }
        }
      } catch (err) {
        // Swallow and keep the loop alive; log once-ish for diagnosis.
        if (typeof console !== "undefined") console.warn("minimap draw failed", err);
      } finally {
        if (alive) raf = requestAnimationFrame(draw);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { map, jumpCamera } = useStore.getState();
    if (!map) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * map.width;
    const my = ((e.clientY - rect.top) / rect.height) * map.height;
    jumpCamera(mx, my);
  };

  return (
    <canvas
      ref={canvasRef}
      className="minimap"
      width={SIZE}
      height={SIZE}
      onPointerDown={jump}
    />
  );
}
