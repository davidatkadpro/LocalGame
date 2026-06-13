// Core game types shared by client and server.

export type PlayerId = number; // 0..3 (game slot)
export type EntityId = number;

export type ResourceKind = "wood" | "food" | "gold";
export type Resources = Record<ResourceKind, number>;

export type Terrain = "grass" | "water" | "forest" | "rock";

export type UnitType = "worker" | "soldier";
export type BuildingType = "town_center" | "house" | "barracks";

export interface Vec2 {
  x: number;
  y: number;
}

/** A square-tile map. tiles[y * width + x] gives the terrain at (x, y). */
export interface GameMap {
  width: number;
  height: number;
  tiles: Terrain[];
}

export interface ResourceNode {
  id: EntityId;
  kind: ResourceKind;
  tile: Vec2; // integer tile coords
  amount: number; // remaining
}

export type UnitState =
  | "idle"
  | "moving"
  | "gathering"
  | "returning"
  | "building"
  | "attacking";

export interface Unit {
  id: EntityId;
  owner: PlayerId;
  type: UnitType;
  pos: Vec2; // float tile coords (center of unit)
  hp: number;
  state: UnitState;
  path: Vec2[]; // remaining waypoints (tile centers)
  /** carried resource while gathering */
  carry: { kind: ResourceKind; amount: number } | null;
  /** current order target, meaning depends on state */
  targetEntity: EntityId | null;
  targetTile: Vec2 | null;
  attackCooldown: number; // ms remaining
}

export interface Building {
  id: EntityId;
  owner: PlayerId;
  type: BuildingType;
  tile: Vec2; // top-left integer tile
  hp: number;
  /** 0..1; 1 means fully constructed */
  progress: number;
  /** production queue of unit types */
  queue: UnitType[];
  /** ms remaining on the unit currently being produced */
  produceTimer: number;
}

export interface Player {
  id: PlayerId;
  name: string;
  color: string; // hex
  resources: Resources;
  pop: number;
  popCap: number;
  alive: boolean;
}

export interface World {
  seed: number;
  tick: number; // sim tick counter
  map: GameMap;
  players: Player[];
  units: Unit[];
  buildings: Building[];
  resourceNodes: ResourceNode[];
  nextEntityId: EntityId;
  winner: PlayerId | null;
}

