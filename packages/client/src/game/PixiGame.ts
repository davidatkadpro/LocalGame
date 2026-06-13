// PixiJS renderer + camera + input for the in-match view.
// Reads interpolated snapshots from the store and sends commands back.

import { Application, Container, Graphics, Sprite } from "pixi.js";
import {
  BUILDING_DEFS,
  TICK_MS,
  base64ToBytes,
  type BuildingType,
  type Command,
  type GameMap,
  type Snapshot,
  type Terrain,
  type UnitDTO,
} from "@bg/shared";
import { loadAssets, textures, type SpriteKey } from "./assets";
import { useStore } from "../net/store";

const TILE = 36; // base pixels per tile at zoom 1
const TERRAIN_COLOR: Record<Terrain, number> = {
  grass: 0x4f7d3a,
  water: 0x2b6cb0,
  forest: 0x3a5d2a,
  rock: 0x6b6b6b,
};

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
  private buildingLayer = new Container();
  private unitLayer = new Container();
  private selectionLayer = new Graphics();
  private boxLayer = new Graphics();

  private map: GameMap | null = null;
  private cam = { x: 0, y: 0, zoom: 1 };

  private unitSprites = new Map<number, Sprite>();
  private buildingSprites = new Map<number, Sprite>();
  private resourceSprites = new Map<number, Sprite>();

  private selected = new Set<number>();
  private placing: BuildingType | null = null;

  private lastFogTick = -1;
  private pointers = new Map<number, PointerInfo>();
  private panLast: { x: number; y: number } | null = null;
  private pinchDist = 0;
  private selecting = false;
  private destroyed = false;

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

    this.world.addChild(
      this.terrainLayer,
      this.resourceLayer,
      this.buildingLayer,
      this.unitLayer,
      this.selectionLayer,
      this.fogLayer,
      this.boxLayer,
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

    this.bindInput();
    this.app.ticker.add(() => this.frame());
  }

  destroy(): void {
    this.destroyed = true;
    this.app.destroy(true, { children: true });
  }

  // --- public API used by the HUD ---
  setPlacing(b: BuildingType | null): void {
    this.placing = b;
  }
  getSelected(): number[] {
    return [...this.selected];
  }

  // ----------------------------------------------------------- setup helpers

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
        g.rect(x, y, 1, 1).fill(TERRAIN_COLOR[t]);
      }
    }
    // subtle grid
    g.rect(0, 0, map.width, map.height).stroke({ width: 0.03, color: 0x000000, alpha: 0.2 });
  }

  // ----------------------------------------------------------- per-frame

  private frame(): void {
    if (this.destroyed) return;
    this.applyKeyboardPan();
    this.applyCamera();

    const st = useStore.getState();
    if (!st.curr) return;

    this.reconcileResources(st.curr);
    this.reconcileBuildings(st.curr, st);
    this.reconcileUnits(st.prev, st.curr);
    this.drawSelection();

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
    const k = keys;
    const speed = 0.25 / this.cam.zoom;
    if (k.has("arrowleft") || k.has("a")) this.cam.x -= speed;
    if (k.has("arrowright") || k.has("d")) this.cam.x += speed;
    if (k.has("arrowup") || k.has("w")) this.cam.y -= speed;
    if (k.has("arrowdown") || k.has("s")) this.cam.y += speed;
  }

  // ----------------------------------------------------------- reconcilers

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
        this.unitLayer.addChild(sp);
        this.unitSprites.set(u.id, sp);
      }
      sp.tint = this.colorOf(u.owner);
      const p = prevById.get(u.id);
      const x = p ? p.x + (u.x - p.x) * t : u.x;
      const y = p ? p.y + (u.y - p.y) * t : u.y;
      sp.position.set(x, y);
    }
    for (const [id, sp] of this.unitSprites) {
      if (!seen.has(id)) {
        sp.destroy();
        this.unitSprites.delete(id);
        this.selected.delete(id);
      }
    }
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
        this.buildingLayer.addChild(sp);
        this.buildingSprites.set(b.id, sp);
      }
      sp.tint = this.colorOf(b.owner);
      sp.alpha = 0.45 + 0.55 * b.progress;
      sp.position.set(b.tx + def.size.w / 2, b.ty + def.size.h / 2);
    }
    for (const [id, sp] of this.buildingSprites) {
      if (!seen.has(id)) {
        sp.destroy();
        this.buildingSprites.delete(id);
      }
    }
  }

  private reconcileResources(curr: Snapshot): void {
    const seen = new Set<number>();
    for (const n of curr.resources) {
      seen.add(n.id);
      let sp = this.resourceSprites.get(n.id);
      if (!sp) {
        const key: SpriteKey = n.kind === "wood" ? "tree" : n.kind === "gold" ? "gold" : "food";
        sp = new Sprite(textures[key]);
        sp.anchor.set(0.5);
        sp.width = 0.95;
        sp.height = 0.95;
        this.resourceLayer.addChild(sp);
        this.resourceSprites.set(n.id, sp);
      }
      sp.position.set(n.tx + 0.5, n.ty + 0.5);
    }
    for (const [id, sp] of this.resourceSprites) {
      if (!seen.has(id)) {
        sp.destroy();
        this.resourceSprites.delete(id);
      }
    }
  }

  private drawSelection(): void {
    const g = this.selectionLayer;
    g.clear();
    for (const id of this.selected) {
      const sp = this.unitSprites.get(id);
      if (!sp) continue;
      g.circle(sp.x, sp.y, 0.55).stroke({ width: 0.08, color: 0xffffff, alpha: 0.9 });
    }
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
  }

  private onPointerDown(e: PointerEvent): void {
    const rect = this.app.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.pointers.set(e.pointerId, {
      x, y, startX: x, startY: y, button: e.button, type: e.pointerType, moved: false,
    });

    if (e.pointerType === "mouse") {
      if (e.button === 2) {
        // right click: context command (or cancel placement)
        if (this.placing) this.placing = null;
        else this.issueCommandAt(this.screenToWorld(x, y));
      } else if (e.button === 1) {
        this.panLast = { x, y };
      } else if (e.button === 0) {
        if (this.placing) {
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
      } else {
        this.panLast = { x, y };
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    const rect = this.app.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (Math.abs(x - info.startX) > 5 || Math.abs(y - info.startY) > 5) info.moved = true;
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

    if (this.panLast && (e.button === 1 || e.pointerType === "touch" || (e.buttons & 4) !== 0)) {
      const scale = TILE * this.cam.zoom;
      this.cam.x -= (x - this.panLast.x) / scale;
      this.cam.y -= (y - this.panLast.y) / scale;
      this.panLast = { x, y };
    }

    if (this.selecting) this.drawBox(info.startX, info.startY, x, y);
  }

  private onPointerUp(e: PointerEvent): void {
    const info = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);

    if (e.pointerType === "mouse") {
      if (e.button === 1) this.panLast = null;
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
      // touch tap (single finger, no move)
      if (info && !info.moved && this.pointers.size === 0) {
        const wp = this.screenToWorld(info.x, info.y);
        if (this.placing) this.tryPlace(wp);
        else if (this.selected.size > 0) this.issueCommandAt(wp);
        else this.singleSelect(wp);
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

  private singleSelect(wp: { x: number; y: number }): void {
    const snap = useStore.getState().curr;
    if (!snap) return;
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
    this.selected.clear();
    if (best !== null) this.selected.add(best);
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number): void {
    const a = this.screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = this.screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    const snap = useStore.getState().curr;
    if (!snap) return;
    this.selected.clear();
    for (const u of snap.units) {
      if (u.owner !== this.me()) continue;
      if (u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y) this.selected.add(u.id);
    }
  }

  private issueCommandAt(wp: { x: number; y: number }): void {
    if (this.selected.size === 0) return;
    const snap = useStore.getState().curr;
    if (!snap) return;
    const units = [...this.selected];
    const tx = Math.floor(wp.x);
    const ty = Math.floor(wp.y);

    // enemy unit?
    for (const u of snap.units) {
      if (u.owner !== this.me() && Math.hypot(u.x - wp.x, u.y - wp.y) < 0.6) {
        return this.send({ c: "attack", units, target: u.id });
      }
    }
    // enemy building?
    for (const b of snap.buildings) {
      const def = BUILDING_DEFS[b.type as BuildingType];
      if (b.owner !== this.me() && tx >= b.tx && tx < b.tx + def.size.w && ty >= b.ty && ty < b.ty + def.size.h) {
        return this.send({ c: "attack", units, target: b.id });
      }
    }
    // resource node?
    for (const n of snap.resources) {
      if (n.tx === tx && n.ty === ty) {
        return this.send({ c: "gather", units, node: n.id });
      }
    }
    // otherwise move
    this.send({ c: "move", units, tile: { x: tx, y: ty } });
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
    this.send({
      c: "build",
      unit: worker,
      building: this.placing,
      tile: { x: Math.floor(wp.x), y: Math.floor(wp.y) },
    });
    this.placing = null;
  }

  private send(cmd: Command): void {
    useStore.getState().command(cmd);
  }
}

// module-level keyboard state (shared by the single active game)
const keys = new Set<string>();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
