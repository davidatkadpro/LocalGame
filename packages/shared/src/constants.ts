import type {
  AnimalKind,
  BuildingType,
  Player,
  ResourceKind,
  Resources,
  UnitType,
  UpgradeId,
} from "./types";

// ---- Simulation ----
export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_DT = TICK_MS / 1000; // seconds per tick

// ---- Lobby / players ----
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const PLAYER_COLORS = ["#e6492d", "#2d7fe6", "#27ae60", "#f1c40f"];

// ---- Map ----
export const MAP_WIDTH = 64;
export const MAP_HEIGHT = 64;

// ---- Economy ----
export const STARTING_RESOURCES: Resources = { wood: 200, food: 200, gold: 120 };
export const CARRY_CAPACITY = 10; // units carry this much before returning
export const GATHER_PER_SEC = 6; // resource units harvested per second

export interface UnitDef {
  type: UnitType;
  hp: number;
  speed: number; // tiles per second
  sight: number; // tiles
  cost: Partial<Resources>;
  popCost: number;
  trainMs: number;
  // combat
  damage: number;
  range: number; // tiles
  attackMs: number; // cooldown between attacks
  trainedAt: BuildingType;
}

export const UNIT_DEFS: Record<UnitType, UnitDef> = {
  worker: {
    type: "worker",
    hp: 40,
    speed: 2.3,
    sight: 5,
    cost: { food: 50 },
    popCost: 1,
    trainMs: 5000,
    damage: 3,
    range: 0.75, // must exceed unit separation (0.64) so melee can connect
    attackMs: 1200,
    trainedAt: "town_center",
  },
  soldier: {
    type: "soldier",
    hp: 110,
    speed: 1.9,
    sight: 6,
    cost: { food: 60, gold: 20 }, // gold-gated elite frontline
    popCost: 1,
    trainMs: 9000,
    damage: 13,
    range: 0.8,
    attackMs: 1000,
    trainedAt: "barracks",
  },
  archer: {
    type: "archer",
    hp: 50,
    speed: 2.0,
    sight: 7,
    cost: { food: 40, wood: 25 }, // accessible ranged unit (no gold gate)
    popCost: 1,
    trainMs: 8000,
    damage: 9,
    range: 5, // ranged: attacks from a distance
    attackMs: 1400,
    trainedAt: "barracks",
  },
  ram: {
    type: "ram",
    hp: 120,
    speed: 1.4, // slow: needs an escort
    sight: 4,
    cost: { wood: 120, gold: 40 },
    popCost: 2, // heavy
    trainMs: 16000,
    damage: 14, // ×5 vs buildings (see DAMAGE_COUNTERS) = 70/hit; ~5 vs units
    range: 0.9,
    attackMs: 2000,
    trainedAt: "siege_workshop",
  },
};

/** Unit types that count as military (for combat upgrades). */
export const MILITARY: UnitType[] = ["soldier", "archer", "ram"];

export interface BuildingDef {
  type: BuildingType;
  hp: number;
  sight: number;
  size: { w: number; h: number }; // in tiles
  cost: Partial<Resources>;
  buildMs: number; // worker construction time
  providesPop: number;
  isDropOff: boolean; // can workers deposit resources here
  canTrain: UnitType[];
  /** auto-attack stats for defensive buildings (towers) */
  attack?: { damage: number; range: number; attackMs: number };
  /** upgrades that can be researched here */
  research?: UpgradeId[];
  /** renewable food source: hosts a regenerating food node workers harvest */
  farm?: { capacity: number; regenPerSec: number };
  /** can a worker construct this from the build menu */
  buildable: boolean;
}

export const BUILDING_DEFS: Record<BuildingType, BuildingDef> = {
  town_center: {
    type: "town_center",
    hp: 1200,
    sight: 8,
    size: { w: 3, h: 3 },
    cost: { wood: 350 },
    buildMs: 30000,
    providesPop: 5,
    isDropOff: true,
    canTrain: ["worker"],
    research: ["improvedTools"],
    buildable: false,
  },
  house: {
    type: "house",
    hp: 300,
    sight: 4,
    size: { w: 2, h: 2 },
    cost: { wood: 50 },
    buildMs: 12000,
    providesPop: 5,
    isDropOff: false,
    canTrain: [],
    buildable: true,
  },
  barracks: {
    type: "barracks",
    hp: 600,
    sight: 5,
    size: { w: 3, h: 3 },
    cost: { wood: 175 },
    buildMs: 20000,
    providesPop: 0,
    isDropOff: false,
    canTrain: ["soldier", "archer"],
    research: ["sharpenedBlades", "paddedArmor"],
    buildable: true,
  },
  tower: {
    type: "tower",
    hp: 500,
    sight: 8,
    size: { w: 2, h: 2 },
    cost: { wood: 100, gold: 25 },
    buildMs: 15000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    // Nerf: was 16 dmg / range 6 / 800ms (out-ranged archers and out-DPS'd
    // soldiers). Now trades evenly with massed ranged units.
    attack: { damage: 10, range: 5, attackMs: 1000 },
    buildable: true,
  },
  storehouse: {
    type: "storehouse",
    hp: 250,
    sight: 3,
    size: { w: 2, h: 2 },
    cost: { wood: 60 },
    buildMs: 10000,
    providesPop: 0,
    isDropOff: true, // forward drop-off so far resource patches are worth working
    canTrain: [],
    buildable: true,
  },
  farm: {
    type: "farm",
    hp: 200,
    sight: 2,
    size: { w: 2, h: 2 },
    cost: { wood: 80 },
    buildMs: 14000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    // Hosts a food node that regenerates at ~one worker's gather rate, so a
    // single farmer sustains it indefinitely; extra farmers drain it faster.
    farm: { capacity: 250, regenPerSec: 6 },
    buildable: true,
  },
  wall: {
    type: "wall",
    hp: 200,
    sight: 1,
    size: { w: 1, h: 1 },
    cost: { wood: 10 },
    buildMs: 3000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    buildable: true,
  },
  siege_workshop: {
    type: "siege_workshop",
    hp: 500,
    sight: 4,
    size: { w: 3, h: 3 },
    cost: { wood: 200, gold: 50 },
    buildMs: 22000,
    providesPop: 0,
    isDropOff: false,
    canTrain: ["ram"], // gates siege behind a dedicated tech building
    buildable: true,
  },
};

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  blurb: string;
  cost: Partial<Resources>;
  researchMs: number;
  building: BuildingType;
}

export const UPGRADE_DEFS: Record<UpgradeId, UpgradeDef> = {
  improvedTools: {
    id: "improvedTools",
    name: "Improved Tools",
    blurb: "Workers gather +50% faster",
    cost: { wood: 150, food: 100 },
    researchMs: 20000,
    building: "town_center",
  },
  sharpenedBlades: {
    id: "sharpenedBlades",
    name: "Sharpened Blades",
    blurb: "Military units deal +25% damage",
    cost: { food: 150, gold: 100 },
    researchMs: 25000,
    building: "barracks",
  },
  paddedArmor: {
    id: "paddedArmor",
    name: "Padded Armor",
    blurb: "Military units take −25% damage",
    cost: { wood: 150, gold: 100 },
    researchMs: 25000,
    building: "barracks",
  },
};

// ---- effective stats (apply per-player upgrades) ----

export function hasUpgrade(p: Player, id: UpgradeId): boolean {
  return p.upgrades.includes(id);
}

export function gatherRate(p: Player): number {
  return GATHER_PER_SEC * (hasUpgrade(p, "improvedTools") ? 1.5 : 1);
}

/** Damage a unit of `type` owned by `p` deals (before target armor). */
export function unitDamage(p: Player, type: UnitType): number {
  const base = UNIT_DEFS[type].damage;
  return MILITARY.includes(type) && hasUpgrade(p, "sharpenedBlades") ? base * 1.25 : base;
}

/** Damage actually taken by a unit of `type` owned by `target`, after armor. */
export function incomingDamage(target: Player, type: UnitType, dmg: number): number {
  return MILITARY.includes(type) && hasUpgrade(target, "paddedArmor") ? dmg * 0.75 : dmg;
}

/**
 * Combat counters: a multiplier on an attacker's damage based on the target's
 * category (a unit type, or "building"). Encodes the rock-paper-scissors so
 * army composition matters — archers shred soldiers at range but barely dent
 * walls; soldiers run down archers. Unlisted matchups default to 1×. These are
 * a tuning surface; expect to revise from playtests.
 */
const DAMAGE_COUNTERS: Partial<
  Record<UnitType, Partial<Record<UnitType | "building", number>>>
> = {
  // Soldiers run down archers and rams.
  soldier: { archer: 1.5, ram: 1.5 },
  // Archers shred soldiers/rams at range, harass workers, weak on structures.
  archer: { soldier: 1.75, ram: 1.5, worker: 1.25, building: 0.5 },
  // Rams demolish buildings/walls but are near-useless against units (needs an escort).
  ram: { worker: 0.34, soldier: 0.34, archer: 0.34, ram: 0.34, building: 5 },
};

export function damageMultiplier(attacker: UnitType, target: UnitType | "building"): number {
  return DAMAGE_COUNTERS[attacker]?.[target] ?? 1;
}

export const BASE_POP_CAP = 5;
export const HARD_POP_CAP = 50;

export const RESOURCE_NODE_AMOUNT: Record<ResourceKind, number> = {
  wood: 300,
  food: 200,
  gold: 400,
};

// ---- Wildlife ----

export interface AnimalDef {
  kind: AnimalKind;
  hp: number; // low — a worker or two fells it quickly
  food: number; // carcass food yielded when gathered
  speed: number; // tiles/sec while wandering (slow, so it's huntable)
}

export const ANIMAL_DEFS: Record<AnimalKind, AnimalDef> = {
  // A roaming snack: quick to kill, modest food. Good early scouting forage.
  sheep: { kind: "sheep", hp: 8, food: 100, speed: 0.45 },
  // A bigger prize worth hunting down: tougher, but a large food cache.
  cow: { kind: "cow", hp: 22, food: 250, speed: 0.35 },
};

export function emptyResources(): Resources {
  return { wood: 0, food: 0, gold: 0 };
}

export function canAfford(have: Resources, cost: Partial<Resources>): boolean {
  return (
    have.wood >= (cost.wood ?? 0) &&
    have.food >= (cost.food ?? 0) &&
    have.gold >= (cost.gold ?? 0)
  );
}

export function payCost(have: Resources, cost: Partial<Resources>): void {
  have.wood -= cost.wood ?? 0;
  have.food -= cost.food ?? 0;
  have.gold -= cost.gold ?? 0;
}

