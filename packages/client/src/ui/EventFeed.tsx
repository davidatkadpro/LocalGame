import { useEffect, useRef, useState } from "react";
import { UPGRADE_DEFS, type BuildingType } from "@bg/shared";
import { useStore } from "../net/store";
import { BUILDING_LABEL } from "./Hud";

interface FeedEvent {
  id: number;
  text: string;
  born: number;
}

interface Prev {
  complete: Set<number>;
  upgrades: number;
  alive: Map<number, boolean>;
  capped: boolean;
}

const TTL_MS = 7000;
const MAX = 6;

/**
 * A transient notification log. Derived entirely client-side by diffing the
 * snapshot stream (own building completions, research, population cap) plus the
 * per-player alive states (eliminations). No server/protocol changes needed.
 */
export function EventFeed() {
  const curr = useStore((s) => s.curr);
  const players = useStore((s) => s.players);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const prev = useRef<Prev | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    if (!curr) return;
    const myId = curr.me.playerId;
    const completeNow = new Set(
      curr.buildings.filter((b) => b.owner === myId && b.progress >= 1).map((b) => b.id),
    );
    const upgradesNow = curr.me.upgrades.length;
    const aliveNow = new Map(curr.players.map((p) => [p.id, p.alive]));
    const cappedNow = curr.me.popCap > 0 && curr.me.pop >= curr.me.popCap;

    const p = prev.current;
    const add: string[] = [];
    if (p) {
      for (const id of completeNow) {
        if (!p.complete.has(id)) {
          const b = curr.buildings.find((x) => x.id === id);
          if (b) add.push(`${BUILDING_LABEL[b.type as BuildingType]} complete`);
        }
      }
      if (upgradesNow > p.upgrades) {
        const newUp = curr.me.upgrades[curr.me.upgrades.length - 1];
        if (newUp) add.push(`Researched ${UPGRADE_DEFS[newUp].name}`);
      }
      for (const [id, al] of aliveNow) {
        if (p.alive.get(id) === true && al === false) {
          const name = players.find((pp) => pp.id === id)?.name ?? `Player ${id + 1}`;
          add.push(`${name} was eliminated`);
        }
      }
      if (cappedNow && !p.capped) add.push("Population capped — build houses");
    }
    prev.current = { complete: completeNow, upgrades: upgradesNow, alive: aliveNow, capped: cappedNow };

    if (add.length > 0) {
      const now = performance.now();
      setEvents((prevE) =>
        [...prevE, ...add.map((text) => ({ id: nextId.current++, text, born: now }))].slice(-MAX),
      );
    }
  }, [curr, players]);

  // Snapshots arrive ~10 Hz during play, so re-render cadence prunes expired
  // events promptly without a dedicated timer.
  const now = performance.now();
  const visible = events.filter((e) => now - e.born < TTL_MS);
  if (visible.length === 0) return null;

  return (
    <div className="event-feed">
      {visible.map((e) => (
        <div className="event" key={e.id}>
          {e.text}
        </div>
      ))}
    </div>
  );
}
