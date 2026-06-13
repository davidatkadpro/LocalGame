import { useEffect, useRef, useState } from "react";
import type {
  BuildingDTO,
  BuildingType,
  EntityId,
  Resources,
  UnitType,
  UpgradeId,
} from "@bg/shared";
import { BUILDING_DEFS, UNIT_DEFS, UPGRADE_DEFS, canAfford } from "@bg/shared";
import { useStore } from "../net/store";
import { isMuted, toggleMuted } from "../game/audio";

interface HudProps {
  onPlace: (b: BuildingType) => void;
  onAttackMove: () => void;
  onIdleWorker: () => void;
  onSelectMode: () => void;
  isMobile: boolean;
  minimapOpen: boolean;
  onToggleMinimap: () => void;
}

const UNIT_LABEL: Record<UnitType, string> = {
  worker: "Worker",
  soldier: "Soldier",
  archer: "Archer",
  ram: "Ram",
};
export const BUILDING_LABEL: Record<BuildingType, string> = {
  town_center: "Town Center",
  house: "House",
  barracks: "Barracks",
  tower: "Guard Tower",
  storehouse: "Storehouse",
  farm: "Farm",
  wall: "Wall",
  siege_workshop: "Siege Workshop",
};

const BUILDABLE = Object.values(BUILDING_DEFS).filter((d) => d.buildable);

type MobileTab = "build" | "commands" | "selection" | "controls";

export function Hud({
  onPlace,
  onAttackMove,
  onIdleWorker,
  onSelectMode,
  isMobile,
  minimapOpen,
  onToggleMinimap,
}: HudProps) {
  const snap = useStore((s) => s.curr);
  const selectedUnits = useStore((s) => s.selectedUnits);
  const selectedBuilding = useStore((s) => s.selectedBuilding);
  const selectArmed = useStore((s) => s.selectArmed);
  const command = useStore((s) => s.command);
  const [confirmConcede, setConfirmConcede] = useState(false);
  const [muted, setMuted] = useState(isMuted());
  const [showControls, setShowControls] = useState(
    () => localStorage.getItem("bg-hideControls") !== "1",
  );
  const setControls = (show: boolean) => {
    localStorage.setItem("bg-hideControls", show ? "0" : "1");
    setShowControls(show);
  };

  const res = snap?.me.resources ?? { wood: 0, food: 0, gold: 0 };
  const pop = snap?.me.pop ?? 0;
  const popCap = snap?.me.popCap ?? 0;
  const upgrades = snap?.me.upgrades ?? [];

  const me = snap?.me.playerId;
  const idleWorkers = snap
    ? snap.units.filter((u) => u.owner === me && u.type === "worker" && u.state === "idle").length
    : 0;

  const building = snap?.buildings.find((b) => b.id === selectedBuilding) ?? null;

  // Eliminated players keep watching the match (full-map vision from the server)
  // with the build/command HUD removed — only a spectate banner remains.
  const spectating = snap ? snap.me.alive === false : false;
  if (spectating) {
    return <div className="spectate-banner">👁 You were eliminated — spectating</div>;
  }

  return (
    <>
      <div className="hud-top">
        <Res icon="🪵" label="Wood" value={res.wood} />
        <Res icon="🍖" label="Food" value={res.food} />
        <Res icon="🪙" label="Gold" value={res.gold} />
        <Res icon="👥" label="Pop" value={`${pop}/${popCap}`} />
        {upgrades.length > 0 && (
          <span className="upgrades" title="Researched upgrades">
            {upgrades.map((u) => (
              <span className="badge" key={u} title={UPGRADE_DEFS[u].name}>
                ⬆ {UPGRADE_DEFS[u].name.split(" ")[1] ?? UPGRADE_DEFS[u].name}
              </span>
            ))}
          </span>
        )}
        <button
          className="icon-btn"
          title={muted ? "Unmute" : "Mute"}
          onClick={() => setMuted(toggleMuted())}
        >
          {muted ? "🔇" : "🔊"}
        </button>
      </div>

      {isMobile ? (
        <MobileBottom
          onPlace={onPlace}
          onAttackMove={onAttackMove}
          onIdleWorker={onIdleWorker}
          onSelectMode={onSelectMode}
          selectArmed={selectArmed}
          selectedCount={selectedUnits.length}
          idleWorkers={idleWorkers}
          building={building}
          selectedBuilding={selectedBuilding}
          res={res}
          upgrades={upgrades}
          minimapOpen={minimapOpen}
          onToggleMinimap={onToggleMinimap}
          onConcede={() => setConfirmConcede(true)}
        />
      ) : (
        <div className="hud-bottom">
          <BuildPanelView onPlace={onPlace} />
          <CommandsPanelView
            selectArmed={selectArmed}
            onSelectMode={onSelectMode}
            onAttackMove={onAttackMove}
            selectedCount={selectedUnits.length}
            onIdleWorker={onIdleWorker}
            idleWorkers={idleWorkers}
            onConcede={() => setConfirmConcede(true)}
          />
          <SelectionPanelView
            building={building}
            res={res}
            upgrades={upgrades}
            selectedCount={selectedUnits.length}
          />
          <ControlsPanelView showControls={showControls} setControls={setControls} />
        </div>
      )}

      {confirmConcede && (
        <div className="screen center modal-backdrop">
          <div className="card">
            <h1>Concede the match?</h1>
            <p className="muted">
              You’ll be eliminated and switch to spectating. This can’t be undone.
            </p>
            <div className="row">
              <button onClick={() => setConfirmConcede(false)}>Cancel</button>
              <button
                className="danger"
                onClick={() => {
                  command({ c: "concede" });
                  setConfirmConcede(false);
                }}
              >
                🏳 Concede
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- Panel views (shared by desktop row and mobile drawer) ---------- */

function BuildPanelView({ onPlace }: { onPlace: (b: BuildingType) => void }) {
  return (
    <div className="panel panel-build">
      <div className="panel-title">Build</div>
      {BUILDABLE.map((d) => (
        <button key={d.type} onClick={() => onPlace(d.type)}>
          {BUILDING_LABEL[d.type]} <CostBadge cost={d.cost} />
        </button>
      ))}
    </div>
  );
}

function CommandsPanelView({
  selectArmed,
  onSelectMode,
  onAttackMove,
  selectedCount,
  onIdleWorker,
  idleWorkers,
  onConcede,
}: {
  selectArmed: boolean;
  onSelectMode: () => void;
  onAttackMove: () => void;
  selectedCount: number;
  onIdleWorker: () => void;
  idleWorkers: number;
  onConcede: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-title">Commands</div>
      <button
        className={selectArmed ? "armed" : ""}
        onClick={onSelectMode}
        title="Then drag a box on the map to select multiple units (touch)"
      >
        {selectArmed ? "▣ Drag to select…" : "▣ Box select"}
      </button>
      <button onClick={onAttackMove} disabled={selectedCount === 0}>
        ⚔ Attack-move <span className="muted small">(A)</span>
      </button>
      <button onClick={onIdleWorker} disabled={idleWorkers === 0}>
        💤 Idle worker{idleWorkers > 0 ? ` (${idleWorkers})` : ""}{" "}
        <span className="muted small">(.)</span>
      </button>
      <button className="danger" onClick={onConcede} title="Resign the match">
        🏳 Concede
      </button>
    </div>
  );
}

function SelectionPanelView({
  building,
  res,
  upgrades,
  selectedCount,
}: {
  building: BuildingDTO | null;
  res: Resources;
  upgrades: UpgradeId[];
  selectedCount: number;
}) {
  if (building) {
    return <BuildingPanel building={building} resources={res} owned={upgrades} />;
  }
  return (
    <div className="panel">
      <div className="panel-title">Selection</div>
      <div className="small muted">
        {selectedCount > 0
          ? `${selectedCount} unit${selectedCount > 1 ? "s" : ""} selected`
          : "Nothing selected"}
      </div>
      <div className="small muted">Select a building to train units or research upgrades.</div>
    </div>
  );
}

function ControlsText() {
  return (
    <div className="small muted">
      Drag-select / click your units. Right-click (or tap) to move, gather, or attack. Press{" "}
      <b>A</b> then click for attack-move; <b>.</b> cycles idle workers.
      <b> Ctrl+1–9</b> sets a control group, <b>1–9</b> recalls it (double-tap to centre). Select a
      building, then right-click/tap to set its rally point. Pick <b>Wall</b> (with a worker
      selected) and drag to build a line. Arrow keys / drag to pan, wheel / pinch to zoom.
      <br />
      <b>Touch:</b> tap <b>▣ Box select</b> then drag to marquee units; double-tap a unit to grab
      all of its type on screen; long-press to issue a command (e.g. send a worker to finish a
      building).
    </div>
  );
}

function ControlsPanelView({
  showControls,
  setControls,
}: {
  showControls: boolean;
  setControls: (show: boolean) => void;
}) {
  if (!showControls) {
    return (
      <button
        className="hint-reopen"
        onClick={() => setControls(true)}
        title="Show controls"
        aria-label="Show controls"
      >
        ?
      </button>
    );
  }
  return (
    <div className="panel hint">
      <div className="panel-title hint-head">
        <span>Controls</span>
        <button
          className="panel-close"
          onClick={() => setControls(false)}
          title="Hide controls"
          aria-label="Hide controls"
        >
          ×
        </button>
      </div>
      <ControlsText />
    </div>
  );
}

/* ---------- Mobile tabbed bottom HUD ---------- */

function MobileBottom({
  onPlace,
  onAttackMove,
  onIdleWorker,
  onSelectMode,
  selectArmed,
  selectedCount,
  idleWorkers,
  building,
  selectedBuilding,
  res,
  upgrades,
  minimapOpen,
  onToggleMinimap,
  onConcede,
}: {
  onPlace: (b: BuildingType) => void;
  onAttackMove: () => void;
  onIdleWorker: () => void;
  onSelectMode: () => void;
  selectArmed: boolean;
  selectedCount: number;
  idleWorkers: number;
  building: BuildingDTO | null;
  selectedBuilding: EntityId | null;
  res: Resources;
  upgrades: UpgradeId[];
  minimapOpen: boolean;
  onToggleMinimap: () => void;
  onConcede: () => void;
}) {
  const [tab, setTab] = useState<MobileTab | null>(null);

  // Auto-open the Selection drawer when a building gets selected, so training
  // and research controls surface without an extra tap.
  const prevBuilding = useRef(selectedBuilding);
  useEffect(() => {
    if (selectedBuilding !== null && selectedBuilding !== prevBuilding.current) {
      setTab("selection");
    }
    prevBuilding.current = selectedBuilding;
  }, [selectedBuilding]);

  const toggle = (t: MobileTab) => setTab((cur) => (cur === t ? null : t));

  const selLabel = building
    ? BUILDING_LABEL[building.type as BuildingType]
    : selectedCount > 0
      ? `${selectedCount} sel`
      : "Select";

  return (
    <div className="hud-mobile">
      {tab && (
        <div className="hud-drawer">
          {tab === "build" && <BuildPanelView onPlace={onPlace} />}
          {tab === "commands" && (
            <CommandsPanelView
              selectArmed={selectArmed}
              onSelectMode={onSelectMode}
              onAttackMove={onAttackMove}
              selectedCount={selectedCount}
              onIdleWorker={onIdleWorker}
              idleWorkers={idleWorkers}
              onConcede={onConcede}
            />
          )}
          {tab === "selection" && (
            <SelectionPanelView
              building={building}
              res={res}
              upgrades={upgrades}
              selectedCount={selectedCount}
            />
          )}
          {tab === "controls" && (
            <div className="panel hint">
              <div className="panel-title">Controls</div>
              <ControlsText />
            </div>
          )}
        </div>
      )}

      <div className="hud-tabs">
        <TabButton emoji="🔨" label="Build" active={tab === "build"} onClick={() => toggle("build")} />
        <TabButton
          emoji="⚔"
          label="Cmd"
          active={tab === "commands"}
          badge={idleWorkers > 0 ? idleWorkers : undefined}
          onClick={() => toggle("commands")}
        />
        <TabButton
          emoji="🎯"
          label={selLabel}
          active={tab === "selection"}
          onClick={() => toggle("selection")}
        />
        <TabButton emoji="🗺" label="Map" active={minimapOpen} onClick={onToggleMinimap} />
        <TabButton
          emoji="❔"
          label="Help"
          active={tab === "controls"}
          onClick={() => toggle("controls")}
        />
      </div>
    </div>
  );
}

function TabButton({
  emoji,
  label,
  active,
  badge,
  onClick,
}: {
  emoji: string;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button className={`hud-tab ${active ? "active" : ""}`} onClick={onClick}>
      <span className="tab-icon">{emoji}</span>
      <span className="tab-label">{label}</span>
      {badge !== undefined && <em className="tab-badge">{badge}</em>}
    </button>
  );
}

function BuildingPanel({
  building,
  resources,
  owned,
}: {
  building: BuildingDTO;
  resources: Resources;
  owned: UpgradeId[];
}) {
  const command = useStore((s) => s.command);
  const def = BUILDING_DEFS[building.type as BuildingType];
  const built = building.progress >= 1;
  const queue = building.queue ?? [];
  const trainProgress =
    building.produceMs && building.produceMs > 0
      ? 1 - (building.produceTimer ?? 0) / building.produceMs
      : 0;
  const researchProgress =
    building.researchMs && building.researchMs > 0
      ? 1 - (building.researchTimer ?? 0) / building.researchMs
      : 0;
  const researchOpts = def.research ?? [];

  return (
    <div className="panel">
      <div className="panel-title">{BUILDING_LABEL[building.type as BuildingType]}</div>

      {!built && (
        <div className="small muted">Under construction… {Math.round(building.progress * 100)}%</div>
      )}

      {built && def.canTrain.length > 0 && (
        <>
          <div className="train-row">
            {def.canTrain.map((u) => (
              <button
                key={u}
                disabled={!canAfford(resources, UNIT_DEFS[u].cost)}
                onClick={() => command({ c: "train", building: building.id, unit: u })}
              >
                + {UNIT_LABEL[u]} <CostBadge cost={UNIT_DEFS[u].cost} />
              </button>
            ))}
          </div>
          {queue.length > 0 && (
            <>
              <div className="queue">
                {queue.map((u, i) => (
                  <span className="chip" key={i}>
                    {UNIT_LABEL[u][0]}
                  </span>
                ))}
                <span className="small muted">×{queue.length}</span>
                <button className="cancel" onClick={() => command({ c: "cancelTrain", building: building.id })}>
                  Cancel
                </button>
              </div>
              <div className="progress">
                <div className="progress-fill" style={{ width: `${Math.round(trainProgress * 100)}%` }} />
              </div>
            </>
          )}
        </>
      )}

      {built && researchOpts.length > 0 && (
        <div className="research">
          <div className="panel-title">Research</div>
          <div className="train-row">
            {researchOpts.map((id) => {
              const u = UPGRADE_DEFS[id];
              const have = owned.includes(id);
              const busy = building.research != null;
              const poor = !canAfford(resources, u.cost);
              return (
                <button
                  key={id}
                  title={u.blurb}
                  disabled={have || busy || poor}
                  onClick={() => command({ c: "research", building: building.id, upgrade: id })}
                >
                  {have ? "✓ " : ""}
                  {u.name} {have ? null : <CostBadge cost={u.cost} />}
                </button>
              );
            })}
          </div>
          {building.research && (
            <>
              <div className="small muted">Researching {UPGRADE_DEFS[building.research].name}…</div>
              <div className="progress">
                <div className="progress-fill" style={{ width: `${Math.round(researchProgress * 100)}%` }} />
              </div>
            </>
          )}
        </div>
      )}

      {built && (def.canTrain.length > 0 || building.type === "barracks") && (
        <div className="small muted">Right-click / tap map to set rally.</div>
      )}
    </div>
  );
}

function Res({ icon, label, value }: { icon: string; label: string; value: number | string }) {
  return (
    <div className="res" title={label}>
      <span>{icon}</span>
      <strong>{typeof value === "number" ? Math.floor(value) : value}</strong>
    </div>
  );
}

function CostBadge({ cost }: { cost: Partial<Resources> }) {
  const parts: string[] = [];
  if (cost.wood) parts.push(`${cost.wood}🪵`);
  if (cost.food) parts.push(`${cost.food}🍖`);
  if (cost.gold) parts.push(`${cost.gold}🪙`);
  return <span className="muted small">({parts.join(" ") || "free"})</span>;
}
