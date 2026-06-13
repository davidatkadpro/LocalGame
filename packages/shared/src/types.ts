// Core game types shared by client and server.

export type PlayerId = number; // 0..3 (game slot)
export type EntityId = number;

export type ResourceKind = "wood" | "food" | "gold";
export type Resources = Record<ResourceKind, number>;

export type Terrain = "grass" | "water" | "forest" | "rock";

export type UnitType = "worker" | "soldier" | "archer";
export type BuildingType =
  | "town_center"
  | "house"
  | "barracks"
  | "tower"
  | "storehouse"
  | "farm"
  | "wall";

/** Player-wide researches that modify effective stats. */
export type UpgradeId = "improvedTools" | "sharpenedBlades" | "paddedArmor";

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
  /** owner for farm-hosted nodes (only this player may harvest); undefined = neutral */
  owner?: PlayerId;
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
  /** consecutive ticks spent unable to advance (for stuck detection) */
  stuck: number;
  /** consecutive forced re-paths on the current order (give up after a few) */
  repaths: number;
  /** attack-move destination: walk toward it, engaging any enemy seen en route */
  aggro: Vec2 | null;
  /** id of the last enemy that damaged us (for idle auto-retaliation) */
  attackedBy: EntityId | null;
  /** ms remaining on the auto-retaliation memory before it lapses */
  attackedTtl: number;
  /** true when the current attack engagement is auto-retaliation (leashed to
   *  sight), false for a player-issued attack (which may chase) */
  retaliating: boolean;
  /** last resource node a worker gathered (to resume after building) */
  lastGatherNode: EntityId | null;
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
  /** where newly produced units walk to (tile center), or null for the door */
  rally: Vec2 | null;
  /** upgrade currently being researched here, or null */
  research: UpgradeId | null;
  /** ms remaining on the current research */
  researchTimer: number;
  /** attack cooldown for defensive buildings (towers), ms remaining */
  attackCooldown: number;
  /** for farms: id of the hosted, regenerating food node it spawned when built */
  farmNodeId?: EntityId | null;
}

export interface Player {
  id: PlayerId;
  name: string;
  color: string; // hex
  resources: Resources;
  pop: number;
  popCap: number;
  alive: boolean;
  /** researched upgrades */
  upgrades: UpgradeId[];
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

