// Core game types shared by client and server.

export type PlayerId = number; // 0..3 (game slot)
export type EntityId = number;

export type ResourceKind = "wood" | "food" | "gold" | "stone";
export type Resources = Record<ResourceKind, number>;

export type Terrain = "grass" | "water" | "forest" | "rock";

export type UnitType =
  | "worker"
  | "soldier"
  | "archer"
  | "cavalry"
  | "ram"
  | "mangonel"
  | "trebuchet";
export type BuildingType =
  | "town_center"
  | "house"
  | "barracks"
  | "stable"
  | "blacksmith"
  | "tower"
  | "storehouse"
  | "lumber_camp"
  | "mining_camp"
  | "mill"
  | "farm"
  | "wall"
  | "stone_wall"
  | "fortified_wall"
  | "gate"
  | "siege_workshop"
  | "wonder";

/** Player-wide researches that modify effective stats. Tiered into three lines
 *  (§7.3): attack (sharpened→tempered→honed), armor (padded→leather→plate), and
 *  gather (improved→fine→master tools). Each tier requires the one below it. */
export type UpgradeId =
  | "improvedTools"
  | "fineTools"
  | "masterTools"
  | "sharpenedBlades"
  | "temperedBlades"
  | "honedBlades"
  | "paddedArmor"
  | "leatherArmor"
  | "plateArmor";

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

/** A neutral, capturable monument (§7.10). Any unit that comes within capture
 *  range claims it for its team; while held it trickles gold to the owner. It is
 *  static — placed at map gen, occupies a 1×1 tile, and is never removed. */
export interface Relic {
  id: EntityId;
  tile: Vec2; // integer tile coords
  /** controlling player (their team collects the gold); undefined = neutral */
  owner?: PlayerId;
  /** fractional gold buffer; whole gold is paid to the owner as this crosses 1 */
  accum: number;
}

export type UnitState =
  | "idle"
  | "moving"
  | "gathering"
  | "returning"
  | "building"
  | "attacking";

/** Per-unit combat posture, governing how it reacts to enemies when it isn't
 *  executing an explicit order:
 *   - aggressive:  seek and engage any foe in sight, chasing within a leash
 *   - defensive:   fight back when attacked, leashed to sight (the default —
 *                  reproduces the classic retaliate-but-don't-roam behaviour)
 *   - standGround: attack only what is already in range; never take a step
 *   - noAttack:    never auto-engage (hold fire); only explicit orders apply */
export type Stance = "aggressive" | "defensive" | "standGround" | "noAttack";

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
  /** combat posture: bounds auto-engage/chase when not under an explicit order */
  stance: Stance;
  /** patrol loop waypoints (tile coords); null = not patrolling. The unit walks
   *  toward patrol[0] engaging any foe en route, then rotates the list to loop. */
  patrol: Vec2[] | null;
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
  /** §7.10 Wonder victory: ms remaining on the win countdown once the wonder is
   *  complete (undefined for non-wonders / still building). Reaches 0 → the
   *  owner's team wins; destroying the wonder removes it and cancels the clock. */
  wonderTimer?: number;
  /** §7.5b units sheltered inside this building (TC/tower). Garrisoned units are
   *  off the map — protected, not rendered, not targetable — until ejected, and
   *  garrisoned archers add arrows to the building's volley. */
  garrison?: Unit[];
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
  /** current age (0 = Dark, 1 = Feudal, 2 = Imperial); gates buildings/units */
  age: number;
  /** ms remaining on an in-progress age advance (0 = not advancing) */
  ageUpTimer: number;
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
  /** neutral capturable relics that trickle gold to whoever holds them (§7.10) */
  relics: Relic[];
  nextEntityId: EntityId;
  winner: PlayerId | null;
  /** per-player cumulative stats, indexed by PlayerId */
  stats: PlayerStats[];
}

