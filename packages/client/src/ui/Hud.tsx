import type { BuildingType } from "@bg/shared";
import { BUILDING_DEFS, UNIT_DEFS } from "@bg/shared";
import { useStore } from "../net/store";

interface HudProps {
  onPlace: (b: BuildingType) => void;
}

export function Hud({ onPlace }: HudProps) {
  const snap = useStore((s) => s.curr);
  const me = useStore((s) => s.myPlayerId);
  const command = useStore((s) => s.command);

  const res = snap?.me.resources ?? { wood: 0, food: 0, gold: 0 };
  const pop = snap?.me.pop ?? 0;
  const popCap = snap?.me.popCap ?? 0;

  const ownBuilding = (type: BuildingType) =>
    snap?.buildings.find((b) => b.owner === me && b.type === type && b.progress >= 1);

  const trainWorker = () => {
    const tc = ownBuilding("town_center");
    if (tc) command({ c: "train", building: tc.id, unit: "worker" });
  };
  const trainSoldier = () => {
    const bar = ownBuilding("barracks");
    if (bar) command({ c: "train", building: bar.id, unit: "soldier" });
  };

  return (
    <>
      <div className="hud-top">
        <Res icon="🪵" label="Wood" value={res.wood} />
        <Res icon="🍖" label="Food" value={res.food} />
        <Res icon="🪙" label="Gold" value={res.gold} />
        <Res icon="👥" label="Pop" value={`${pop}/${popCap}`} />
      </div>

      <div className="hud-bottom">
        <div className="panel">
          <div className="panel-title">Build</div>
          <button onClick={() => onPlace("house")}>
            House <Cost type="house" />
          </button>
          <button onClick={() => onPlace("barracks")}>
            Barracks <Cost type="barracks" />
          </button>
        </div>
        <div className="panel">
          <div className="panel-title">Train</div>
          <button onClick={trainWorker} disabled={!ownBuilding("town_center")}>
            Worker <span className="muted small">({UNIT_DEFS.worker.cost.food}🍖)</span>
          </button>
          <button onClick={trainSoldier} disabled={!ownBuilding("barracks")}>
            Soldier{" "}
            <span className="muted small">
              ({UNIT_DEFS.soldier.cost.food}🍖 {UNIT_DEFS.soldier.cost.gold}🪙)
            </span>
          </button>
        </div>
        <div className="panel hint">
          <div className="panel-title">Controls</div>
          <div className="small muted">
            Drag-select / click your units. Right-click (or tap) to move, gather, or attack.
            Wheel / pinch to zoom, middle-drag / one-finger-drag to pan, WASD too.
          </div>
        </div>
      </div>
    </>
  );
}

function Res({ icon, label, value }: { icon: string; label: string; value: number | string }) {
  return (
    <div className="res" title={label}>
      <span>{icon}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Cost({ type }: { type: BuildingType }) {
  const c = BUILDING_DEFS[type].cost;
  return <span className="muted small">({c.wood ?? 0}🪵)</span>;
}
