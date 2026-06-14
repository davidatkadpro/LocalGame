// PixiJS renderer + camera + input for the in-match view.
// Reads interpolated snapshots from the store and sends commands back.

import { Application, Container, Graphics, Sprite } from "pixi.js";
import {
  ANIMAL_DEFS,
  BUILDING_DEFS,
  RESOURCE_NODE_AMOUNT,
  TICK_MS,
  UNIT_DEFS,
  base64ToBytes,
  rectContains,
  type AnimalDTO,
  type BuildingType,
  type Command,
  type GameMap,
  type Snapshot,
  type Terrain,
  type UnitDTO,
  type UnitType,
} from "@bg/shared";
import { accentKey, loadAssets, textures, type SpriteKey } from "./assets";
import { sfx, resumeAudio } from "./audio";
import { useStore } from "../net/store";

const TILE = 36; // base pixels per tile at zoom 1
const TERRAIN_COLOR: Record<Terrain, number> = {
  grass: 0x4f7d3a,
  water: 0x2b6cb0,
  forest: 0x3a5d2a,
  rock: 0x6b6b6b,
};

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Multiply a packed RGB colour's brightness by (1 + f). */
function shade(hex: number, f: number): number {
  const r = clamp255(((hex >> 16) & 255) * (1 + f));
  const g = clamp255(((hex >> 8) & 255) * (1 + f));
  const b = clamp255((hex & 255) * (1 + f));
  return (r << 16) | (g << 8) | b;
}

/** Deterministic per-tile pseudo-noise in [0,1) — stable across redraws. */
function tileNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h ^= h >> 16;
  return ((h >>> 0) % 1000) / 1000;
}

interface PointerInfo {
  x: number;
  y: number;
  startX: number;
  startY: number;
  button: number;
  type: string;
  moved: boolean;
}

export class PixiGame {
  private app = new Application();
  private world = new Container();
  private terrainLayer = new Graphics();
  private fogLayer = new Graphics();
  private resourceLayer = new Container();
  // Units and buildings share one container so they can be depth-sorted (by
  // their feet/bottom edge) — a unit standing behind a building draws behind it.
  private entityLayer = new Container();
  private selectionLayer = new Graphics();
  private projLayer = new Graphics();
  private hpLayer = new Graphics();
  private boxLayer = new Graphics();
  private placeLayer = new Graphics();

  private map: GameMap | null = null;
  private cam = { x: 0, y: 0, zoom: 1 };
  // When set, the camera eases toward this world point each frame instead of
  // hard-snapping (control-group recall, go-to-TC, minimap jump). Cleared once
  // it arrives, or immediately when the player pans manually.
  private camTarget: { x: number; y: number } | null = null;
  private hoverWorld = { x: 0, y: 0 };

  private unitSprites = new Map<number, Sprite>();
  private buildingSprites = new Map<number, Sprite>();
  private resourceSprites = new Map<number, Sprite>();
  // Largest amount seen per resource node, so depletion scales even for carcasses
  // (whose full size isn't a fixed constant).
  private resourceMax = new Map<number, number>();
  private animalSprites = new Map<number, Sprite>();
  private animalFx = new Map<number, { hp: number; flashUntil: number }>();

  private selected = new Set<number>();
  private selectedBuilding: number | null = null;
  private placing: BuildingType | null = null;
  // While placing a wall, the tile a drag started on — a drag lays a whole line.
  private wallDragStart: { x: number; y: number } | null = null;
  private armedAttack = false; // attack-move: next click issues an attack-move

  // control groups (keyboard 1–9) and idle-worker cycling
  private groups = new Map<number, number[]>();
  private lastGroupRecall = { n: -1, t: 0 };
  private idleCycle = 0;

  // event detection for sfx (ids/progress seen last frame)
  private knownOwnUnits = new Set<number>();
  private ownUnitsInit = false;
  private buildProgress = new Map<number, number>();

  // animation / visual-fx state
  private now = 0;
  private unitFx = new Map<number, { hp: number; lastX: number; facing: number; flashUntil: number }>();
  private buildingFx = new Map<number, { hp: number; flashUntil: number }>();
  private dying: { sp: Sprite; born: number }[] = [];
  private projectiles: { x: number; y: number; tx: number; ty: number; born: number; dur: number }[] = [];
  private nextShot = new Map<number, number>(); // shooter id -> earliest next projectile time

  // "under attack" alerting: throttle a minimap ping per map region + a sound.
  private attackPingCells = new Map<number, number>();
  private lastAttackSound = 0;

  private lastFogTick = -1;
  private pointers = new Map<number, PointerInfo>();
  private panLast: { x: number; y: number } | null = null;
  private pinchDist = 0;
  private selecting = false;
  // Touch box-select: armed by the HUD button, the next single-finger drag draws
  // a selection box instead of panning. One-shot so panning stays the default.
  private selectMode = false;
  // Double-tap-a-unit detection (tablet "select all of this type on screen").
  private lastUnitTap = { id: -1, t: 0 };
  // touch long-press = "issue command" (the right-click analog): a held tap that
  // hasn't moved fires a command instead of (re)selecting what's under the finger.
  private longPressTimer: number | null = null;
  private longPressFired = false;
  private destroyed = false;
  private onKeyDown?: (e: KeyboardEvent) => void;

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      background: 0x0d0f12,
      resizeTo: container,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    container.appendChild(this.app.canvas);
    await loadAssets();

    this.entityLayer.sortableChildren = true; // sort by zIndex (feet depth) each render
    this.world.addChild(
      this.terrainLayer,
      this.resourceLayer,
      this.selectionLayer,
      this.entityLayer,
      this.projLayer,
      this.hpLayer,
      this.fogLayer,
      this.boxLayer,
      this.placeLayer,
    );
    this.app.stage.addChild(this.world);

    const { map, players, myPlayerId } = useStore.getState();
    this.map = map;
    if (map) this.drawTerrain(map);

    // Centre camera on this player's town center if we can find it.
    const me = myPlayerId ?? 0;
    void players;
    this.cam.x = (map?.width ?? 32) / 2;
    this.cam.y = (map?.height ?? 32) / 2;
    this.recenterOnStart(me);
    this.fitInitialZoom();

    this.bindInput();
    this.app.ticker.add(() => this.frame());
  }

  destroy(): void {
    this.destroyed = true;
    this.clearLongPress();
    if (this.onKeyDown) window.removeEventListener("keydown", this.onKeyDown);
    this.app.destroy(true, { children: true });
  }

  // --- public API used by the HUD / minimap ---
  setPlacing(b: BuildingType | null): void {
    this.placing = b;
    this.wallDragStart = null;
    if (b) {
      this.armedAttack = false;
      this.disarmSelectMode();
    }
  }
  getSelected(): number[] {
    return [...this.selected];
  }

  /** Replace the unit selection with a specific id set (HUD sub-select). */
  setSelectionIds(ids: number[]): void {
    const snap = useStore.getState().curr;
    const live = snap ? ids.filter((id) => snap.units.some((u) => u.id === id)) : ids;
    if (live.length === 0) return;
    this.selected = new Set(live);
    this.selectedBuilding = null;
    this.commitSelection();
    sfx.select();
  }

  /** Arm attack-move: the next map click issues an attack-move for the selection. */
  armAttackMove(): void {
    if (this.selected.size === 0) return;
    this.armedAttack = true;
    this.placing = null;
    this.disarmSelectMode();
  }

  /** Arm touch box-select: the next single-finger drag draws a selection box. */
  armSelectMode(): void {
    this.selectMode = true;
    this.placing = null;
    this.armedAttack = false;
    useStore.getState().setSelectArmed(true);
  }

  private disarmSelectMode(): void {
    if (!this.selectMode) return;
    this.selectMode = false;
    useStore.getState().setSelectArmed(false);
  }

  /** Select the next idle worker and centre the camera on it. */
  selectNextIdleWorker(): void {
    const snap = useStore.getState().curr;
    if (!snap) return;
    const idle = snap.units
      .filter((u) => u.owner === this.me() && u.type === "worker" && u.state === "idle")
      .sort((a, b) => a.id - b.id);
    if (idle.length === 0) return;
    const u = idle[this.idleCycle % idle.length];
    this.idleCycle = (this.idleCycle + 1) % idle.length;
    this.selectSingle(u.id, null);
    this.cam.x = u.x;
    this.cam.y = u.y;
  }
  /** Camera centre + visible extent in tile units (for the minimap viewport). */
  getViewport(): { x: number; y: number; w: number; h: number } {
    const dpr = window.devicePixelRatio || 1;
    const scale = TILE * this.cam.zoom;
    return {
      x: this.cam.x,
      y: this.cam.y,
      w: this.app.renderer.width / dpr / scale,
      h: this.app.renderer.height / dpr / scale,
    };
  }

  /**
   * One of my entities took damage. If it's off-screen, drop a throttled minimap
   * ping there and (less often) play an alert, so I notice a base/army I can't
   * currently see is under attack. On-screen hits need no alert — I can see them.
   */
  private noteDamage(x: number, y: number, owner: number): void {
    if (owner !== this.me()) return;
    const vp = this.getViewport();
    const m = 2; // tiles of slack around the visible area
    const onScreen =
      x >= vp.x - vp.w / 2 - m && x <= vp.x + vp.w / 2 + m &&
      y >= vp.y - vp.h / 2 - m && y <= vp.y + vp.h / 2 + m;
    if (onScreen) return;
    const now = performance.now();
    const cell = Math.floor(x / 8) + Math.floor(y / 8) * 4096; // ~8-tile regions
    const last = this.attackPingCells.get(cell) ?? -1e9;
    if (now - last < 3000) return; // one ping per region per 3s
    this.attackPingCells.set(cell, now);
    useStore.getState().addPing(x, y);
    if (now - this.lastAttackSound > 2500) {
      this.lastAttackSound = now;
      sfx.alert();
    }
  }

  // ----------------------------------------------------------- setup helpers

  /** On small screens the default 1× zoom shows only ~10 tiles across, which is
   *  claustrophobic on a phone. Pull the camera back so the shorter screen axis
   *  shows ~16 tiles. Desktop/tablet (>=560px min side) keeps the 1× default. */
  private fitInitialZoom(): void {
    const dpr = window.devicePixelRatio || 1;
    const minCss = Math.min(this.app.renderer.width, this.app.renderer.height) / dpr;
    if (minCss >= 560) return;
    const z = minCss / (TILE * 16);
    this.cam.zoom = Math.max(0.45, Math.min(1, z));
  }

  private recenterOnStart(me: number): void {
    const snap = useStore.getState().curr;
    if (!snap) return;
    const tc = snap.buildings.find((b) => b.owner === me && b.type === "town_center");
    if (tc) {
      this.cam.x = tc.tx + 1.5;
      this.cam.y = tc.ty + 1.5;
    }
  }

  private drawTerrain(map: GameMap): void {
    const g = this.terrainLayer;
    g.clear();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const t = map.tiles[y * map.width + x];
        const base = TERRAIN_COLOR[t];
        // per-tile brightness variation breaks up the flat colour slabs
        const n = tileNoise(x, y);
        g.rect(x, y, 1, 1).fill(shade(base, (n - 0.5) * 0.22));

        // scatter a small fleck on ~a third of tiles for texture
        if (tileNoise(x + 101, y + 57) < 0.33) {
          const fx = x + 0.2 + 0.6 * tileNoise(x + 13, y + 91);
          const fy = y + 0.2 + 0.6 * tileNoise(x + 71, y + 29);
          const fleck = t === "water" ? shade(base, 0.18) : shade(base, -0.18);
          g.circle(fx, fy, 0.075).fill({ color: fleck, alpha: 0.5 });
        }
      }
    }
  }

  // ----------------------------------------------------------- per-frame

  private frame(): void {
    if (this.destroyed) return;

    // Minimap click -> glide camera.
    const jump = useStore.getState().cameraJump;
    if (jump) {
      this.glideTo(jump.x, jump.y);
      useStore.setState({ cameraJump: null });
    }

    this.applyKeyboardPan(); // a held arrow key cancels any active glide
    this.stepCameraGlide();
    this.applyCamera();

    this.now = performance.now();

    const st = useStore.getState();
    if (!st.curr) return;

    this.pruneSelection(st.curr);
    this.reconcileResources(st.curr);
    this.reconcileBuildings(st.curr, st);
    this.reconcileUnits(st.prev, st.curr);
    this.reconcileAnimals(st.prev, st.curr);
    this.updateDying();
    this.drawProjectiles();
    this.drawSelection();
    this.drawHpBars(st.curr);
    this.drawPlacement();

    if (st.curr.tick !== this.lastFogTick) {
      this.drawFog(st.curr);
      this.lastFogTick = st.curr.tick;
    }
  }

  private colorOf(owner: number): number {
    const p = useStore.getState().players.find((pl) => pl.id === owner);
    return p ? parseInt(p.color.slice(1), 16) : 0xffffff;
  }

  private applyCamera(): void {
    const scale = TILE * this.cam.zoom;
    this.world.scale.set(scale);
    this.world.position.set(
      this.app.renderer.width / 2 / (window.devicePixelRatio || 1) - this.cam.x * scale,
      this.app.renderer.height / 2 / (window.devicePixelRatio || 1) - this.cam.y * scale,
    );
  }

  private applyKeyboardPan(): void {
    // Arrow keys pan (letter keys are reserved for commands, e.g. A = attack-move).
    const k = keys;
    const speed = 0.25 / this.cam.zoom;
    const panning =
      k.has("arrowleft") || k.has("arrowright") || k.has("arrowup") || k.has("arrowdown");
    if (panning) this.camTarget = null; // manual pan wins over an in-flight glide
    if (k.has("arrowleft")) this.cam.x -= speed;
    if (k.has("arrowright")) this.cam.x += speed;
    if (k.has("arrowup")) this.cam.y -= speed;
    if (k.has("arrowdown")) this.cam.y += speed;
  }

  /** Begin easing the camera toward a world point (see {@link camTarget}). */
  private glideTo(x: number, y: number): void {
    this.camTarget = { x, y };
  }

  /** Ease the camera one frame toward {@link camTarget}; snap + clear on arrival. */
  private stepCameraGlide(): void {
    const t = this.camTarget;
    if (!t) return;
    const dx = t.x - this.cam.x;
    const dy = t.y - this.cam.y;
    if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) {
      this.cam.x = t.x;
      this.cam.y = t.y;
      this.camTarget = null;
      return;
    }
    const ease = 0.2; // ~0.3s ease-out at 60fps
    this.cam.x += dx * ease;
    this.cam.y += dy * ease;
  }

  // ----------------------------------------------------------- reconcilers

  /**
   * Attach the team-colour accent as a child sprite. It inherits the base's
   * transform (position, facing flip, fade), so we only ever set its tint.
   */
  private attachAccent(base: Sprite, type: string): void {
    const k = accentKey(type);
    if (!k) return;
    const a = new Sprite(textures[k]);
    a.anchor.set(0.5); // both textures are 100×100, so scale 1 matches the base
    base.addChild(a);
  }

  private reconcileUnits(prev: Snapshot | null, curr: Snapshot): void {
    const t = Math.min(1, (performance.now() - useStore.getState().currReceivedAt) / TICK_MS);
    const seen = new Set<number>();
    const prevById = new Map<number, UnitDTO>();
    if (prev) for (const u of prev.units) prevById.set(u.id, u);

    for (const u of curr.units) {
      seen.add(u.id);
      let sp = this.unitSprites.get(u.id);
      if (!sp) {
        sp = new Sprite(textures[u.type as SpriteKey]);
        sp.anchor.set(0.5);
        sp.width = 0.8;
        sp.height = 0.8;
        this.attachAccent(sp, u.type);
        this.entityLayer.addChild(sp);
        this.unitSprites.set(u.id, sp);
      }
      const p = prevById.get(u.id);
      const x = p ? p.x + (u.x - p.x) * t : u.x;
      const y = p ? p.y + (u.y - p.y) * t : u.y;

      const fx = this.unitFx.get(u.id) ?? { hp: u.hp, lastX: x, facing: 1, flashUntil: 0 };
      if (u.hp < fx.hp) {
        fx.flashUntil = this.now + 170; // took damage → flash
        this.noteDamage(u.x, u.y, u.owner);
      }
      fx.hp = u.hp;
      const dx = x - fx.lastX;
      if (Math.abs(dx) > 0.0015) fx.facing = dx < 0 ? -1 : 1; // face travel direction
      fx.lastX = x;
      this.unitFx.set(u.id, fx);

      const moving = u.state === "moving" || u.state === "returning";
      const bob = moving ? Math.sin(this.now / 110 + u.id) * 0.05 : 0;
      const wobble = u.state === "gathering" ? Math.sin(this.now / 90 + u.id) * 0.08 : 0;
      const pulse = u.state === "attacking" ? 1 + 0.09 * Math.sin(this.now / 55) : 1;

      sp.width = 0.8 * pulse;
      sp.height = 0.8 * pulse;
      sp.scale.x = Math.abs(sp.scale.x) * fx.facing;
      sp.rotation = wobble;
      sp.position.set(x, y - bob);
      sp.zIndex = y + 0.4; // sort by feet
      // Base shows true material colours; only the accent child carries team colour.
      const flashing = this.now < fx.flashUntil;
      sp.tint = flashing ? 0xff5a5a : 0xffffff;
      const accent = sp.children[0] as Sprite | undefined;
      if (accent) accent.tint = flashing ? 0xff5a5a : this.colorOf(u.owner);

      // ranged units flick an arrow at the nearest enemy while attacking
      if (u.type === "archer" && u.state === "attacking") {
        const e = this.nearestEnemy(x, y, curr, UNIT_DEFS.archer.range);
        if (e) this.emitShot(u.id, x, y - 0.2, e.x, e.y, 1400);
      }
    }
    for (const [id, sp] of this.unitSprites) {
      if (!seen.has(id)) {
        // fade + shrink out instead of vanishing
        this.dying.push({ sp, born: this.now });
        this.unitSprites.delete(id);
        this.unitFx.delete(id);
        this.selected.delete(id);
      }
    }

    // "unit ready" chime when a brand-new unit of mine appears (trained).
    const me = this.me();
    const mine = new Set(curr.units.filter((u) => u.owner === me).map((u) => u.id));
    if (this.ownUnitsInit) {
      for (const id of mine) if (!this.knownOwnUnits.has(id)) { sfx.ready(); break; }
    }
    this.knownOwnUnits = mine;
    this.ownUnitsInit = true;
  }

  private reconcileBuildings(curr: Snapshot, st: ReturnType<typeof useStore.getState>): void {
    void st;
    const seen = new Set<number>();
    for (const b of curr.buildings) {
      seen.add(b.id);
      let sp = this.buildingSprites.get(b.id);
      const def = BUILDING_DEFS[b.type as BuildingType];
      if (!sp) {
        sp = new Sprite(textures[b.type as SpriteKey]);
        sp.anchor.set(0.5);
        sp.width = def.size.w;
        sp.height = def.size.h;
        this.attachAccent(sp, b.type);
        this.entityLayer.addChild(sp);
        this.buildingSprites.set(b.id, sp);
      }
      const cx = b.tx + def.size.w / 2;
      const cy = b.ty + def.size.h / 2;
      sp.alpha = 0.45 + 0.55 * b.progress;
      sp.position.set(cx, cy);
      sp.zIndex = b.ty + def.size.h; // sort by bottom edge

      const bfx = this.buildingFx.get(b.id) ?? { hp: b.hp, flashUntil: 0 };
      if (b.hp < bfx.hp) {
        bfx.flashUntil = this.now + 170;
        this.noteDamage(b.tx + def.size.w / 2, b.ty + def.size.h / 2, b.owner);
      }
      bfx.hp = b.hp;
      this.buildingFx.set(b.id, bfx);
      const bFlashing = this.now < bfx.flashUntil;
      sp.tint = bFlashing ? 0xff7a7a : 0xffffff; // base keeps true colours
      const bAccent = sp.children[0] as Sprite | undefined;
      if (bAccent) bAccent.tint = bFlashing ? 0xff7a7a : this.colorOf(b.owner);

      // towers loose arrows at the nearest enemy in range
      if (b.type === "tower" && b.progress >= 1) {
        const def2 = BUILDING_DEFS.tower.attack!;
        const e = this.nearestEnemy(cx, cy, curr, def2.range);
        if (e) this.emitShot(b.id, cx, cy - 0.6, e.x, e.y, def2.attackMs);
      }

      // "construction complete" jingle when one of my buildings finishes.
      if (b.owner === this.me()) {
        const prev = this.buildProgress.get(b.id);
        if (prev !== undefined && prev < 1 && b.progress >= 1) sfx.complete();
        this.buildProgress.set(b.id, b.progress);
      }
    }
    for (const [id, sp] of this.buildingSprites) {
      if (!seen.has(id)) {
        sp.destroy();
        this.buildingSprites.delete(id);
        this.buildProgress.delete(id);
        this.buildingFx.delete(id);
      }
    }
  }

  private reconcileResources(curr: Snapshot): void {
    const seen = new Set<number>();
    // A node under a building footprint (e.g. a farm's hosted food node) is
    // represented by the building sprite, so don't draw a bush/crop on top.
    const underBuilding = (tx: number, ty: number) =>
      curr.buildings.some((b) => {
        const d = BUILDING_DEFS[b.type as BuildingType].size;
        return rectContains(b.tx, b.ty, d.w, d.h, tx, ty);
      });
    for (const n of curr.resources) {
      // Farm-hosted (owned) nodes are represented by the farm building, never a
      // loose crop sprite — even when the farm itself is fogged out of view.
      if (n.owner !== undefined) continue;
      if (underBuilding(n.tx, n.ty)) continue;
      seen.add(n.id);
      let sp = this.resourceSprites.get(n.id);
      if (!sp) {
        const key: SpriteKey = n.carcass
          ? "meat"
          : n.kind === "wood"
            ? "tree"
            : n.kind === "gold"
              ? "gold"
              : "food";
        sp = new Sprite(textures[key]);
        sp.anchor.set(0.5);
        this.resourceLayer.addChild(sp);
        this.resourceSprites.set(n.id, sp);
      }
      sp.position.set(n.tx + 0.5, n.ty + 0.5);

      // Shrink + fade a node as it's mined out, so a patch running low reads at a
      // glance. The "full" size is the largest amount we've ever seen for it
      // (spawn maximum for normal nodes; first-seen amount for carcasses).
      const max = Math.max(
        this.resourceMax.get(n.id) ?? 0,
        n.amount,
        n.carcass ? 0 : RESOURCE_NODE_AMOUNT[n.kind],
      );
      this.resourceMax.set(n.id, max);
      const ratio = max > 0 ? Math.max(0, Math.min(1, n.amount / max)) : 1;
      const base = n.carcass ? 0.72 : 0.95;
      const s = base * (0.55 + 0.45 * ratio);
      sp.width = s;
      sp.height = s;
      sp.alpha = 0.8 + 0.2 * ratio;
    }
    for (const [id, sp] of this.resourceSprites) {
      if (!seen.has(id)) {
        sp.destroy();
        this.resourceSprites.delete(id);
        this.resourceMax.delete(id);
      }
    }
  }

  private reconcileAnimals(prev: Snapshot | null, curr: Snapshot): void {
    const t = Math.min(1, (performance.now() - useStore.getState().currReceivedAt) / TICK_MS);
    const prevById = new Map<number, AnimalDTO>();
    if (prev) for (const a of prev.animals) prevById.set(a.id, a);
    const seen = new Set<number>();
    for (const a of curr.animals) {
      seen.add(a.id);
      let sp = this.animalSprites.get(a.id);
      if (!sp) {
        sp = new Sprite(textures[a.kind as SpriteKey]);
        sp.anchor.set(0.5);
        const s = a.kind === "cow" ? 1.0 : 0.85;
        sp.width = s;
        sp.height = s;
        this.entityLayer.addChild(sp);
        this.animalSprites.set(a.id, sp);
      }
      const p = prevById.get(a.id);
      const x = p ? p.x + (a.x - p.x) * t : a.x;
      const y = p ? p.y + (a.y - p.y) * t : a.y;
      const fx = this.animalFx.get(a.id) ?? { hp: a.hp, flashUntil: 0 };
      if (a.hp < fx.hp) fx.flashUntil = this.now + 170; // took damage → flash
      fx.hp = a.hp;
      this.animalFx.set(a.id, fx);
      sp.tint = this.now < fx.flashUntil ? 0xff5a5a : 0xffffff;
      sp.position.set(x, y);
      sp.zIndex = y + 0.3; // sort by feet, just under units on the same row
    }
    for (const [id, sp] of this.animalSprites) {
      if (!seen.has(id)) {
        this.dying.push({ sp, born: this.now });
        this.animalSprites.delete(id);
        this.animalFx.delete(id);
      }
    }
  }

  private drawSelection(): void {
    const g = this.selectionLayer;
    g.clear();
    const snap = useStore.getState().curr;
    const r = 0.52 + 0.03 * Math.sin(this.now / 200);
    for (const id of this.selected) {
      const sp = this.unitSprites.get(id);
      if (!sp) continue;
      g.circle(sp.x, sp.y, r).stroke({ width: 0.07, color: 0xffffff, alpha: 0.9 });
      // queued-order path (shift-click): line + dot through each waypoint.
      const u = snap?.units.find((x) => x.id === id);
      if (u?.orders && u.orders.length > 0) {
        let px = sp.x;
        let py = sp.y;
        for (const o of u.orders) {
          g.moveTo(px, py).lineTo(o.x, o.y).stroke({ width: 0.04, color: 0x9ad1ff, alpha: 0.5 });
          g.circle(o.x, o.y, 0.14).fill({ color: 0x9ad1ff, alpha: 0.7 });
          px = o.x;
          py = o.y;
        }
      }
    }
    if (this.selectedBuilding !== null) {
      const b = snap?.buildings.find((x) => x.id === this.selectedBuilding);
      if (b) {
        const def = BUILDING_DEFS[b.type as BuildingType];
        g.rect(b.tx - 0.1, b.ty - 0.1, def.size.w + 0.2, def.size.h + 0.2).stroke({
          width: 0.08,
          color: 0xffffff,
          alpha: 0.9,
        });
        // rally point + line. Green when it sits on a resource node — new
        // workers will auto-gather it instead of just walking there.
        if (b.rallyX !== undefined && b.rallyY !== undefined) {
          const cx = b.tx + def.size.w / 2;
          const cy = b.ty + def.size.h / 2;
          const rtx = Math.floor(b.rallyX);
          const rty = Math.floor(b.rallyY);
          const onNode = snap?.resources.some(
            (n) => n.tx === rtx && n.ty === rty && (n.owner === undefined || n.owner === this.me()),
          );
          const col = onNode ? 0x51cf66 : 0xffffff;
          g.moveTo(cx, cy).lineTo(b.rallyX, b.rallyY).stroke({ width: 0.05, color: col, alpha: 0.5 });
          g.circle(b.rallyX, b.rallyY, 0.22).fill({ color: col, alpha: 0.85 });
        }
      }
    }
  }

  /** Nearest enemy unit to a point within `range`, from the current snapshot. */
  private nearestEnemy(x: number, y: number, snap: Snapshot, range: number): UnitDTO | null {
    let best: UnitDTO | null = null;
    let bd = range;
    for (const u of snap.units) {
      if (u.owner === this.me()) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  /** Spawn a projectile visual on a per-shooter cadence (approximates fire rate). */
  private emitShot(shooterId: number, fx: number, fy: number, tx: number, ty: number, cadence: number): void {
    const next = this.nextShot.get(shooterId) ?? 0;
    if (this.now < next) return;
    this.nextShot.set(shooterId, this.now + cadence);
    this.projectiles.push({ x: fx, y: fy, tx, ty, born: this.now, dur: 260 });
  }

  private drawProjectiles(): void {
    const g = this.projLayer;
    g.clear();
    this.projectiles = this.projectiles.filter((p) => this.now - p.born < p.dur);
    for (const p of this.projectiles) {
      const prog = (this.now - p.born) / p.dur;
      const cx = p.x + (p.tx - p.x) * prog;
      const cy = p.y + (p.ty - p.y) * prog;
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      g.moveTo(cx - ux * 0.28, cy - uy * 0.28)
        .lineTo(cx, cy)
        .stroke({ width: 0.07, color: 0xffe9a8, alpha: 0.95 });
      g.circle(cx, cy, 0.05).fill({ color: 0xfff3cc, alpha: 0.95 });
    }
  }

  /** Fade + shrink sprites of units that vanished (death / lost vision). */
  private updateDying(): void {
    const DUR = 260;
    this.dying = this.dying.filter((d) => {
      const prog = (this.now - d.born) / DUR;
      if (prog >= 1) {
        d.sp.destroy();
        return false;
      }
      const sign = Math.sign(d.sp.scale.x) || 1;
      const s = 0.8 * (1 - 0.45 * prog);
      d.sp.width = s;
      d.sp.height = s;
      d.sp.scale.x = Math.abs(d.sp.scale.x) * sign;
      d.sp.alpha = 1 - prog;
      d.sp.rotation += 0.16;
      return true;
    });
  }

  private drawHpBars(snap: Snapshot): void {
    const g = this.hpLayer;
    g.clear();
    const bar = (cx: number, top: number, w: number, ratio: number) => {
      const h = 0.12;
      const x = cx - w / 2;
      g.rect(x, top, w, h).fill({ color: 0x000000, alpha: 0.55 });
      const col = ratio > 0.5 ? 0x51cf66 : ratio > 0.25 ? 0xf1c40f : 0xe03131;
      g.rect(x, top, w * Math.max(0, ratio), h).fill({ color: col, alpha: 0.95 });
    };

    for (const u of snap.units) {
      const max = UNIT_DEFS[u.type as UnitType].hp;
      if (u.hp >= max) continue; // only show when damaged
      const sp = this.unitSprites.get(u.id);
      if (!sp) continue;
      bar(sp.x, sp.y - 0.62, 0.8, u.hp / max);
    }
    for (const b of snap.buildings) {
      const def = BUILDING_DEFS[b.type as BuildingType];
      const ratio = b.hp / def.hp;
      if (ratio >= 1 && b.progress >= 1) continue;
      bar(b.tx + def.size.w / 2, b.ty - 0.18, def.size.w * 0.9, ratio);
    }
    for (const a of snap.animals) {
      const max = ANIMAL_DEFS[a.kind].hp;
      if (a.hp >= max) continue; // only once a hunt has started
      const sp = this.animalSprites.get(a.id);
      if (!sp) continue;
      bar(sp.x, sp.y - 0.58, 0.7, a.hp / max);
    }
  }

  private drawPlacement(): void {
    const g = this.placeLayer;
    g.clear();
    // Keep marker strokes ~constant on screen so they stay visible zoomed out.
    const sw = 0.08 / this.cam.zoom;
    if (this.armedAttack) {
      const { x, y } = this.hoverWorld;
      const col = 0xe03131;
      g.circle(x, y, 0.5).stroke({ width: sw, color: col, alpha: 0.95 });
      g.moveTo(x - 0.7, y).lineTo(x + 0.7, y).stroke({ width: sw, color: col, alpha: 0.95 });
      g.moveTo(x, y - 0.7).lineTo(x, y + 0.7).stroke({ width: sw, color: col, alpha: 0.95 });
      return;
    }
    if (!this.placing) return;
    if (this.placing === "wall") {
      // Preview the whole dragged run (or just the hovered tile before a drag).
      const end = this.floorTile(this.hoverWorld);
      const tiles = this.wallDragStart ? this.wallLineTiles(this.wallDragStart, end) : [end];
      for (const t of tiles) {
        const col = this.clientPlacementValid("wall", t.x, t.y) ? 0x51cf66 : 0xe03131;
        g.rect(t.x, t.y, 1, 1)
          .fill({ color: col, alpha: 0.25 })
          .stroke({ width: sw, color: col, alpha: 0.9 });
      }
      return;
    }
    const def = BUILDING_DEFS[this.placing];
    const tx = Math.floor(this.hoverWorld.x - def.size.w / 2 + 0.5);
    const ty = Math.floor(this.hoverWorld.y - def.size.h / 2 + 0.5);
    const ok = this.clientPlacementValid(this.placing, tx, ty);
    const col = ok ? 0x51cf66 : 0xe03131;
    g.rect(tx, ty, def.size.w, def.size.h)
      .fill({ color: col, alpha: 0.25 })
      .stroke({ width: sw, color: col, alpha: 0.9 });
    // Crosshair at the actual tap point — a finger covers the footprint, so
    // mark exactly where the placement is anchored.
    const { x: cx, y: cy } = this.hoverWorld;
    const r = 0.45;
    g.moveTo(cx - r, cy).lineTo(cx + r, cy).stroke({ width: sw, color: col, alpha: 0.95 });
    g.moveTo(cx, cy - r).lineTo(cx, cy + r).stroke({ width: sw, color: col, alpha: 0.95 });
  }

  /** Mirror of the server's placement rule, using snapshot data, for the ghost. */
  private clientPlacementValid(type: BuildingType, tx: number, ty: number): boolean {
    if (!this.map) return false;
    const def = BUILDING_DEFS[type];
    const snap = useStore.getState().curr;
    for (let y = ty; y < ty + def.size.h; y++) {
      for (let x = tx; x < tx + def.size.w; x++) {
        if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return false;
        const terr = this.map.tiles[y * this.map.width + x];
        if (terr === "water" || terr === "rock") return false;
        if (snap?.resources.some((n) => n.tx === x && n.ty === y)) return false;
        const hit = snap?.buildings.some((b) => {
          const bd = BUILDING_DEFS[b.type as BuildingType].size;
          return rectContains(b.tx, b.ty, bd.w, bd.h, x, y);
        });
        if (hit) return false;
      }
    }
    return true;
  }

  private drawFog(snap: Snapshot): void {
    if (!this.map) return;
    const vis = base64ToBytes(snap.visible);
    const exp = base64ToBytes(snap.explored);
    const g = this.fogLayer;
    g.clear();
    const w = this.map.width;
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (exp[i] !== 1) {
          g.rect(x, y, 1, 1).fill({ color: 0x000000, alpha: 1 });
        } else if (vis[i] !== 1) {
          g.rect(x, y, 1, 1).fill({ color: 0x000000, alpha: 0.45 });
        }
      }
    }
  }

  // ----------------------------------------------------------- input

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const dpr = window.devicePixelRatio || 1;
    const scale = TILE * this.cam.zoom;
    const ox = this.app.renderer.width / 2 / dpr - this.cam.x * scale;
    const oy = this.app.renderer.height / 2 / dpr - this.cam.y * scale;
    return { x: (sx - ox) / scale, y: (sy - oy) / scale };
  }

  private bindInput(): void {
    const c = this.app.canvas;
    c.style.touchAction = "none";

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.cam.zoom = Math.max(0.4, Math.min(3, this.cam.zoom * factor));
    }, { passive: false });

    c.addEventListener("contextmenu", (e) => e.preventDefault());

    c.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    c.addEventListener("pointermove", (e) => this.onPointerMove(e));
    c.addEventListener("pointerup", (e) => this.onPointerUp(e));
    c.addEventListener("pointercancel", (e) => this.onPointerUp(e));

    this.onKeyDown = (e) => this.handleKey(e);
    window.addEventListener("keydown", this.onKeyDown);
  }

  private handleKey(e: KeyboardEvent): void {
    // ignore keystrokes aimed at form fields (lobby name, etc.)
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    resumeAudio();

    // control groups: Ctrl/⌘+digit assigns, digit recalls
    if (e.key >= "1" && e.key <= "9") {
      const n = Number(e.key);
      if (e.ctrlKey || e.metaKey) this.assignGroup(n);
      else this.recallGroup(n);
      e.preventDefault();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "a") {
      this.armAttackMove();
      e.preventDefault();
    } else if (k === "s") {
      this.stopSelected();
      e.preventDefault();
    } else if (k === "h") {
      this.centerOnTownCenter();
      e.preventDefault();
    } else if (k === ".") {
      this.selectNextIdleWorker();
      e.preventDefault();
    } else if (k === " " || k === "spacebar") {
      this.jumpToLatestAlert();
      e.preventDefault();
    } else if (k === "escape") {
      this.armedAttack = false;
      this.placing = null;
      this.wallDragStart = null;
      this.selectSingle(null, null);
    }
  }

  /** Halt the current unit selection in place (cancels move/gather/attack). */
  stopSelected(): void {
    if (this.selected.size === 0) return;
    this.send({ c: "stop", units: [...this.selected] });
    sfx.command();
  }

  /** Snap the camera back to this player's town center. */
  private centerOnTownCenter(): void {
    const snap = useStore.getState().curr;
    if (!snap) return;
    const tc = snap.buildings.find((b) => b.owner === this.me() && b.type === "town_center");
    if (tc) this.glideTo(tc.tx + 1.5, tc.ty + 1.5);
  }

  /** Glide the camera to the most recent under-attack ping (Space). */
  private jumpToLatestAlert(): void {
    const pings = useStore.getState().pings;
    const now = performance.now();
    // Newest ping is appended last; only honour reasonably fresh alerts.
    for (let i = pings.length - 1; i >= 0; i--) {
      if (now - pings[i].born < 8000) {
        this.glideTo(pings[i].x, pings[i].y);
        return;
      }
    }
  }

  private assignGroup(n: number): void {
    if (this.selected.size === 0) return;
    this.groups.set(n, [...this.selected]);
  }

  private recallGroup(n: number): void {
    const ids = this.groups.get(n);
    if (!ids || ids.length === 0) return;
    const snap = useStore.getState().curr;
    const alive = snap ? ids.filter((id) => snap.units.some((u) => u.id === id)) : ids;
    if (alive.length === 0) return;
    this.selected = new Set(alive);
    this.selectedBuilding = null;
    this.commitSelection();
    sfx.select();
    // double-tap the same group number to re-centre the camera on it
    const now = performance.now();
    if (this.lastGroupRecall.n === n && now - this.lastGroupRecall.t < 400 && snap) {
      const pts = snap.units.filter((u) => alive.includes(u.id));
      if (pts.length) {
        this.glideTo(
          pts.reduce((s, u) => s + u.x, 0) / pts.length,
          pts.reduce((s, u) => s + u.y, 0) / pts.length,
        );
      }
    }
    this.lastGroupRecall = { n, t: now };
  }

  private onPointerDown(e: PointerEvent): void {
    resumeAudio();
    const rect = this.app.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.hoverWorld = this.screenToWorld(x, y);
    this.pointers.set(e.pointerId, {
      x, y, startX: x, startY: y, button: e.button, type: e.pointerType, moved: false,
    });

    if (e.pointerType === "mouse") {
      if (e.button === 2) {
        // right click: context command / set rally / cancel placement
        if (this.placing) {
          this.placing = null;
          this.wallDragStart = null;
        } else this.issueCommandAt(this.screenToWorld(x, y));
      } else if (e.button === 1) {
        this.panLast = { x, y };
      } else if (e.button === 0) {
        if (this.armedAttack) {
          this.issueAttackMove(this.screenToWorld(x, y));
        } else if (this.placing === "wall") {
          this.wallDragStart = this.floorTile(this.screenToWorld(x, y)); // drag = line
        } else if (this.placing) {
          this.tryPlace(this.screenToWorld(x, y));
        } else {
          this.selecting = true;
        }
      }
    } else {
      // touch
      if (this.pointers.size === 2) {
        this.pinchDist = this.currentPinchDist();
        this.selecting = false;
        this.panLast = null;
        this.wallDragStart = null; // a second finger cancels a wall drag
        this.clearLongPress();
      } else if (this.pointers.size === 1) {
        if (this.placing === "wall") {
          // Drag a finger to lay a line of walls (release to place).
          this.wallDragStart = this.floorTile(this.screenToWorld(x, y));
        } else if (this.selectMode) {
          // Armed box-select: this finger drags a selection box, not a pan.
          this.selecting = true;
          this.panLast = null;
        } else {
          this.panLast = { x, y };
          this.beginLongPress(this.screenToWorld(x, y));
        }
      } else {
        this.panLast = { x, y };
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.app.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Track hover for the build-placement ghost (works for mouse hover too).
    this.hoverWorld = this.screenToWorld(x, y);

    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    // Touch needs a looser threshold than the mouse: a finger held for a
    // long-press always jitters a few px, and at 5px that tremor cancelled the
    // press (so it silently became a pan and no command fired).
    const moveThresh = e.pointerType === "touch" ? 14 : 5;
    if (!info.moved && (Math.abs(x - info.startX) > moveThresh || Math.abs(y - info.startY) > moveThresh)) {
      info.moved = true;
      this.clearLongPress();
      // Begin panning cleanly from here, so the camera doesn't jump by the dead
      // zone — and doesn't drift at all while the finger is held for a long-press.
      if (e.pointerType === "touch" && this.panLast) this.panLast = { x, y };
    }
    info.x = x;
    info.y = y;

    if (e.pointerType === "touch" && this.pointers.size === 2) {
      const d = this.currentPinchDist();
      if (this.pinchDist > 0) {
        const factor = d / this.pinchDist;
        this.cam.zoom = Math.max(0.4, Math.min(3, this.cam.zoom * factor));
      }
      this.pinchDist = d;
      return;
    }

    // Touch pans only once the finger has clearly moved (info.moved) — sub-
    // threshold jitter during a long-press hold must not scroll the map.
    const touchPanning = e.pointerType === "touch" && info.moved;
    if (this.panLast && (e.button === 1 || touchPanning || (e.buttons & 4) !== 0)) {
      const scale = TILE * this.cam.zoom;
      this.cam.x -= (x - this.panLast.x) / scale;
      this.cam.y -= (y - this.panLast.y) / scale;
      this.panLast = { x, y };
      this.camTarget = null; // manual pan wins over an in-flight glide
    }

    if (this.selecting) this.drawBox(info.startX, info.startY, x, y);
  }

  private onPointerUp(e: PointerEvent): void {
    const info = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);

    if (e.pointerType === "mouse") {
      if (e.button === 1) this.panLast = null;
      if (e.button === 0 && this.wallDragStart) {
        if (info) this.placeWallLine(this.wallDragStart, this.floorTile(this.screenToWorld(info.x, info.y)));
        this.wallDragStart = null;
        return;
      }
      if (e.button === 0 && this.selecting) {
        this.selecting = false;
        this.boxLayer.clear();
        if (info && info.moved) {
          this.boxSelect(info.startX, info.startY, info.x, info.y);
        } else if (info) {
          this.singleSelect(this.screenToWorld(info.x, info.y));
        }
      }
    } else {
      // Finish a wall drag: lay the line (unless the gesture was cancelled).
      if (this.wallDragStart) {
        if (info && e.type !== "pointercancel") {
          this.placeWallLine(this.wallDragStart, this.floorTile(this.screenToWorld(info.x, info.y)));
        }
        this.wallDragStart = null;
        this.clearLongPress();
        if (this.pointers.size < 2) this.pinchDist = 0;
        if (this.pointers.size === 0) this.panLast = null;
        return;
      }
      // Armed box-select: a drag selects a box, a tap selects the single unit.
      if (this.selecting && info) {
        this.selecting = false;
        this.boxLayer.clear();
        this.clearLongPress();
        this.disarmSelectMode();
        if (Math.abs(info.x - info.startX) > 6 || Math.abs(info.y - info.startY) > 6) {
          this.boxSelect(info.startX, info.startY, info.x, info.y);
        } else {
          this.singleSelect(this.screenToWorld(info.x, info.y));
        }
        if (this.pointers.size < 2) this.pinchDist = 0;
        if (this.pointers.size === 0) this.panLast = null;
        return;
      }
      // touch tap (single finger, no move)
      const fired = this.longPressFired;
      this.longPressFired = false;
      this.clearLongPress();
      if (!fired && info && !info.moved && this.pointers.size === 0) {
        const wp = this.screenToWorld(info.x, info.y);
        if (this.armedAttack) {
          this.issueAttackMove(wp);
        } else if (this.placing) {
          this.tryPlace(wp);
        } else {
          this.handleTouchTap(wp);
        }
      }
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.pointers.size === 0) this.panLast = null;
    }
  }

  private currentPinchDist(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /** Arm the long-press-to-command timer for a single-finger touch at `wp`. */
  private beginLongPress(wp: { x: number; y: number }): void {
    this.clearLongPress();
    this.longPressFired = false;
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      this.fireLongPress(wp);
    }, 400);
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  /**
   * Long-press fired without the finger moving: issue a command at `wp` — the
   * touch analog of a right-click. This is how you task a unit onto your own
   * entity (e.g. send a selected worker to finish an unfinished building), which
   * a plain tap can't do because a tap on your own entity always (re)selects it.
   */
  private fireLongPress(wp: { x: number; y: number }): void {
    if (this.pointers.size !== 1) return; // a second finger / lift cancels it
    if (this.armedAttack) {
      this.issueAttackMove(wp);
    } else if (this.placing) {
      this.tryPlace(wp);
    } else if (this.selected.size > 0 || this.selectedBuilding !== null) {
      this.issueCommandAt(wp);
    } else {
      return; // nothing selected — let the tap fall through to selection
    }
    this.longPressFired = true;
    this.selecting = false;
    this.boxLayer.clear();
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(20);
  }

  private drawBox(x0: number, y0: number, x1: number, y1: number): void {
    const a = this.screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = this.screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    this.boxLayer.clear();
    this.boxLayer
      .rect(a.x, a.y, b.x - a.x, b.y - a.y)
      .fill({ color: 0xffffff, alpha: 0.08 })
      .stroke({ width: 0.05, color: 0xffffff, alpha: 0.8 });
  }

  // ----------------------------------------------------------- selection/commands

  private me(): number {
    return useStore.getState().myPlayerId ?? 0;
  }

  /** Is `owner` an enemy (different team)? Allies and self are not. */
  private isEnemy(owner: number): boolean {
    if (owner === this.me()) return false;
    const players = useStore.getState().players;
    const myTeam = players.find((p) => p.id === this.me())?.team;
    const theirTeam = players.find((p) => p.id === owner)?.team;
    if (myTeam === undefined || theirTeam === undefined) return true; // FFA fallback
    return myTeam !== theirTeam;
  }

  /** Nearest own unit to a world point, within a small radius, or null. */
  private ownUnitAt(wp: { x: number; y: number }): number | null {
    const snap = useStore.getState().curr;
    if (!snap) return null;
    let best: number | null = null;
    let bestD = 0.7;
    for (const u of snap.units) {
      if (u.owner !== this.me()) continue;
      const d = Math.hypot(u.x - wp.x, u.y - wp.y);
      if (d < bestD) {
        bestD = d;
        best = u.id;
      }
    }
    return best;
  }

  /** Own building whose footprint contains the world point, or null. */
  private ownBuildingAt(wp: { x: number; y: number }): number | null {
    const snap = useStore.getState().curr;
    if (!snap) return null;
    const tx = Math.floor(wp.x);
    const ty = Math.floor(wp.y);
    for (const b of snap.buildings) {
      if (b.owner !== this.me()) continue;
      const d = BUILDING_DEFS[b.type as BuildingType].size;
      if (rectContains(b.tx, b.ty, d.w, d.h, tx, ty)) return b.id;
    }
    return null;
  }

  /** Mirror current selection into the store so the React HUD can read it. */
  private commitSelection(): void {
    useStore.getState().setSelection([...this.selected], this.selectedBuilding);
  }

  /** Drop dead units / destroyed buildings from the selection. */
  private pruneSelection(snap: Snapshot): void {
    let changed = false;
    for (const id of [...this.selected]) {
      if (!snap.units.some((u) => u.id === id)) {
        this.selected.delete(id);
        changed = true;
      }
    }
    if (this.selectedBuilding !== null && !snap.buildings.some((b) => b.id === this.selectedBuilding)) {
      this.selectedBuilding = null;
      changed = true;
    }
    if (changed) this.commitSelection();
  }

  /** Select a single unit OR a single building (mutually exclusive). */
  private selectSingle(unitId: number | null, buildingId: number | null): void {
    this.selected.clear();
    this.selectedBuilding = null;
    if (unitId !== null) this.selected.add(unitId);
    else if (buildingId !== null) this.selectedBuilding = buildingId;
    this.commitSelection();
    if (unitId !== null || buildingId !== null) sfx.select();
  }

  private singleSelect(wp: { x: number; y: number }): void {
    const unit = this.ownUnitAt(wp);
    if (unit !== null) {
      // Double-click a unit -> select every unit of that type on screen (the
      // desktop analog of the touch double-tap).
      const now = performance.now();
      if (this.lastUnitTap.id === unit && now - this.lastUnitTap.t < 350) {
        this.lastUnitTap = { id: -1, t: 0 };
        this.selectAllOfTypeOnScreen(unit);
        return;
      }
      this.lastUnitTap = { id: unit, t: now };
    }
    const building = unit === null ? this.ownBuildingAt(wp) : null;
    this.selectSingle(unit, building);
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number): void {
    const a = this.screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = this.screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    const snap = useStore.getState().curr;
    if (!snap) return;
    this.selected.clear();
    this.selectedBuilding = null;
    for (const u of snap.units) {
      if (u.owner !== this.me()) continue;
      if (u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) this.selected.add(u.id);
    }
    this.commitSelection();
    if (this.selected.size > 0) sfx.select();
  }

  /**
   * Resolve a single-finger touch tap. Tapping your own unit selects it (and a
   * quick double-tap selects every unit of that type on screen); tapping your
   * own unfinished building with workers selected sends them to finish it;
   * tapping empty ground issues a command for the current selection.
   */
  private handleTouchTap(wp: { x: number; y: number }): void {
    const snap = useStore.getState().curr;
    const own = this.ownUnitAt(wp);
    const ownB = own === null ? this.ownBuildingAt(wp) : null;

    if (own !== null) {
      const now = performance.now();
      if (this.lastUnitTap.id === own && now - this.lastUnitTap.t < 400) {
        this.lastUnitTap = { id: -1, t: 0 };
        this.selectAllOfTypeOnScreen(own);
        return;
      }
      this.lastUnitTap = { id: own, t: now };
      this.selectSingle(own, null);
      return;
    }

    if (ownB !== null) {
      const b = snap?.buildings.find((x) => x.id === ownB);
      // Tapping a "work site" with workers selected assigns them rather than
      // reselecting the building: a foundation -> construct it; a damaged
      // building -> repair it; a finished farm -> gather its hosted food node.
      // Otherwise just (re)select the building.
      const def = b ? BUILDING_DEFS[b.type as BuildingType] : null;
      const isWorkSite =
        !!b &&
        (b.progress < 1 || (b.type === "farm" && b.progress >= 1) || (!!def && b.hp < def.hp));
      if (isWorkSite && this.selectionHasWorker()) {
        this.issueCommandAt(wp);
        return;
      }
      this.selectSingle(null, ownB);
      return;
    }

    if (this.selected.size > 0 || this.selectedBuilding !== null) {
      this.issueCommandAt(wp);
    }
  }

  /** Does the current unit selection contain at least one worker? */
  private selectionHasWorker(): boolean {
    const snap = useStore.getState().curr;
    if (!snap) return false;
    for (const id of this.selected) {
      if (snap.units.find((u) => u.id === id)?.type === "worker") return true;
    }
    return false;
  }

  /** Select every own unit sharing the tapped unit's type within the viewport. */
  private selectAllOfTypeOnScreen(unitId: number): void {
    const snap = useStore.getState().curr;
    if (!snap) return;
    const ref = snap.units.find((u) => u.id === unitId);
    if (!ref) return;
    const vp = this.getViewport();
    const minX = vp.x - vp.w / 2;
    const maxX = vp.x + vp.w / 2;
    const minY = vp.y - vp.h / 2;
    const maxY = vp.y + vp.h / 2;
    this.selected.clear();
    this.selectedBuilding = null;
    for (const u of snap.units) {
      if (u.owner !== this.me() || u.type !== ref.type) continue;
      if (u.x >= minX && u.x <= maxX && u.y >= minY && u.y <= maxY) this.selected.add(u.id);
    }
    this.commitSelection();
    if (this.selected.size > 0) sfx.select();
  }

  private issueCommandAt(wp: { x: number; y: number }): void {
    const snap = useStore.getState().curr;
    if (!snap) return;
    const tx = Math.floor(wp.x);
    const ty = Math.floor(wp.y);

    // A selected building (no units) -> set its rally point.
    if (this.selected.size === 0) {
      if (this.selectedBuilding !== null) {
        this.send({ c: "rally", building: this.selectedBuilding, tile: { x: tx, y: ty } });
      }
      return;
    }
    const units = [...this.selected];
    // Holding Shift queues the order after the current one (desktop).
    const queue = keys.has("shift");

    // enemy unit? (allies in 2v2 are not valid targets)
    for (const u of snap.units) {
      if (this.isEnemy(u.owner) && Math.hypot(u.x - wp.x, u.y - wp.y) < 0.6) {
        sfx.attack();
        return this.send({ c: "attack", units, target: u.id, queue });
      }
    }
    // enemy building?
    for (const b of snap.buildings) {
      const def = BUILDING_DEFS[b.type as BuildingType];
      if (this.isEnemy(b.owner) && rectContains(b.tx, b.ty, def.size.w, def.size.h, tx, ty)) {
        sfx.attack();
        return this.send({ c: "attack", units, target: b.id, queue });
      }
    }
    // wild animal? -> send workers to hunt it (kill it, then auto-gather the
    // carcass). Only workers hunt; a worker-less selection falls through to move.
    for (const a of snap.animals) {
      if (Math.hypot(a.x - wp.x, a.y - wp.y) < 0.6) {
        const workers = units.filter((id) => snap.units.find((u) => u.id === id)?.type === "worker");
        if (workers.length === 0) break;
        sfx.attack();
        return this.send({ c: "attack", units: workers, target: a.id, queue });
      }
    }
    // friendly building that needs work — unfinished (finish it) or damaged
    // (repair it)? -> send workers. Both go through the `construct` command.
    for (const b of snap.buildings) {
      const def = BUILDING_DEFS[b.type as BuildingType];
      const needsWork = b.progress < 1 || b.hp < def.hp;
      if (b.owner === this.me() && needsWork && rectContains(b.tx, b.ty, def.size.w, def.size.h, tx, ty)) {
        const workers = units.filter((id) => snap.units.find((u) => u.id === id)?.type === "worker");
        if (workers.length > 0) {
          sfx.command();
          return this.send({ c: "construct", units: workers, building: b.id });
        }
      }
    }
    // friendly completed farm? -> gather its hosted food node. The node sits on
    // a single tile under the 2x2 footprint (no crop sprite), so a tap anywhere
    // on the farm should assign workers — not just the exact node tile.
    for (const b of snap.buildings) {
      if (b.owner !== this.me() || b.type !== "farm" || b.progress < 1) continue;
      const def = BUILDING_DEFS[b.type as BuildingType];
      if (!rectContains(b.tx, b.ty, def.size.w, def.size.h, tx, ty)) continue;
      const node = snap.resources.find(
        (n) => n.owner === this.me() && rectContains(b.tx, b.ty, def.size.w, def.size.h, n.tx, n.ty),
      );
      if (!node) break;
      const workers = units.filter((id) => snap.units.find((u) => u.id === id)?.type === "worker");
      if (workers.length === 0) break; // no workers selected -> fall through to move
      sfx.command();
      return this.send({ c: "gather", units: workers, node: node.id, queue });
    }
    // resource node? (skip enemy-owned farm nodes — the server would reject the
    // gather; fall through to a move so the order isn't silently dropped)
    for (const n of snap.resources) {
      if (n.tx === tx && n.ty === ty && (n.owner === undefined || n.owner === this.me())) {
        sfx.command();
        return this.send({ c: "gather", units, node: n.id, queue });
      }
    }
    // otherwise move
    sfx.command();
    this.send({ c: "move", units, tile: { x: tx, y: ty }, queue });
  }

  /** Issue an attack-move for the current selection and disarm. */
  private issueAttackMove(wp: { x: number; y: number }): void {
    this.armedAttack = false;
    if (this.selected.size === 0) return;
    sfx.attack();
    this.send({
      c: "attackMove",
      units: [...this.selected],
      tile: { x: Math.floor(wp.x), y: Math.floor(wp.y) },
      queue: keys.has("shift"),
    });
  }

  private tryPlace(wp: { x: number; y: number }): void {
    if (!this.placing) return;
    const worker = [...this.selected].find((id) => {
      const u = useStore.getState().curr?.units.find((x) => x.id === id);
      return u && u.type === "worker";
    });
    if (worker === undefined) {
      this.placing = null;
      return;
    }
    // Centre the footprint on the cursor/tap, matching the ghost preview.
    const def = BUILDING_DEFS[this.placing];
    const tx = Math.floor(wp.x - def.size.w / 2 + 0.5);
    const ty = Math.floor(wp.y - def.size.h / 2 + 0.5);
    if (!this.clientPlacementValid(this.placing, tx, ty)) return; // keep placing mode on invalid
    sfx.build();
    this.send({ c: "build", unit: worker, building: this.placing, tile: { x: tx, y: ty } });
    this.placing = null;
  }

  private floorTile(wp: { x: number; y: number }): { x: number; y: number } {
    return { x: Math.floor(wp.x), y: Math.floor(wp.y) };
  }

  /** Integer tiles along the line a→b (Bresenham), capped so a drag can't place a
   *  runaway number of segments. */
  private wallLineTiles(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number }[] {
    const tiles: { x: number; y: number }[] = [];
    let x0 = a.x;
    let y0 = a.y;
    const dx = Math.abs(b.x - x0);
    const dy = Math.abs(b.y - y0);
    const sx = x0 < b.x ? 1 : -1;
    const sy = y0 < b.y ? 1 : -1;
    let err = dx - dy;
    for (let i = 0; i < 256; i++) {
      tiles.push({ x: x0, y: y0 });
      if (x0 === b.x && y0 === b.y) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return tiles.slice(0, 64);
  }

  /** Place every valid wall tile along the dragged line (one build per segment;
   *  the server pays/validates each, and a worker auto-chains down the run). */
  private placeWallLine(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const worker = [...this.selected].find((id) => {
      const u = useStore.getState().curr?.units.find((x) => x.id === id);
      return u && u.type === "worker";
    });
    if (worker === undefined) {
      this.placing = null;
      return;
    }
    let placed = false;
    for (const t of this.wallLineTiles(a, b)) {
      if (!this.clientPlacementValid("wall", t.x, t.y)) continue;
      this.send({ c: "build", unit: worker, building: "wall", tile: t });
      placed = true;
    }
    if (placed) sfx.build();
    this.placing = null; // disarm after a run; re-arm from the HUD for another
  }

  private send(cmd: Command): void {
    useStore.getState().command(cmd);
  }
}

// module-level keyboard state (shared by the single active game)
const keys = new Set<string>();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
