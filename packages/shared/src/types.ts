// Core game types shared by client and server.

export type PlayerId = number; // 0..3 (game slot)
export type EntityId = number;

export type ResourceKind = "wood" | "food" | "gold";
export type Resources = Record<ResourceKind, number>;

export type Terrain = "grass" | "water" | "forest" | "rock";

export type UnitType = "worker" | "soldier" | "archer" | "ram";
export type BuildingType =
  | "town_center"
  | "house"
  | "barracks"
  | "tower"
  | "storehouse"
  | "farm"
  | "wall"
  | "siege_workshop";

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
  /** true if this food node is a hunted-animal carcass (rendered as meat) */
  carcass?: boolean;
}

/** Wild fauna: neutral animals that wander the map. A worker hunts one (attacks
 *  it) and, once killed, the carcass becomes a neutral food node to gather. */
export type AnimalKind = "sheep" | "cow";

export interface Animal {
  id: EntityId;
  kind: AnimalKind;
  pos: Vec2; // float tile coords (center)
  hp: number;
  /** food the carcass yields once the animal is killed */
  food: number;
  /** current wander heading (unit vector); re-rolled when wanderTimer lapses */
  vx: number;
  vy: number;
  /** ticks remaining on the current heading */
  wanderTimer: number;
}

export type UnitState =
  | "idle"
  | "moving"
  | "gathering"
  | "returning"
  | "building"
  | "attacking";

/** A queued order (shift-click). Executed in sequence once the unit goes idle. */
export type QueuedOrder =
  | { k: "move"; tile: Vec2 }
  | { k: "gather"; node: EntityId }
  | { k: "attack"; target: EntityId }
  | { k: "attackMove"; tile: Vec2 };

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
  /** queued orders (shift-click), executed in order once the unit goes idle */
  orders: QueuedOrder[];
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
  /** team id; players sharing a team are allies (FFA = each player own team) */
  team: number;
  resources: Resources;
  pop: number;
  popCap: number;
  alive: boolean;
  /** true once the player has resigned; sticks them as eliminated */
  conceded: boolean;
  /** researched upgrades */
  upgrades: UpgradeId[];
}

/** Cumulative per-player match stats, surfaced on the post-game scoreboard. */
export interface PlayerStats {
  unitsTrained: number;
  unitsLost: number;
  resourcesGathered: number;
  buildingsBuilt: number;
  peakPop: number;
}

export interface World {
  seed: number;
  tick: number; // sim tick counter
  map: GameMap;
  players: Player[];
  units: Unit[];
  buildings: Building[];
  resourceNodes: ResourceNode[];
  /** neutral wandering wildlife (sheep/cows) workers can hunt for food */
  animals: Animal[];
  nextEntityId: EntityId;
  winner: PlayerId | null;
  /** per-player cumulative stats, indexed by PlayerId */
  stats: PlayerStats[];
}

