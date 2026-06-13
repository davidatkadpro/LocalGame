import type {
  BuildingType,
  ResourceKind,
  Resources,
  UnitType,
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
export const STARTING_RESOURCES: Resources = { wood: 200, food: 200, gold: 100 };
export const CARRY_CAPACITY = 10; // units carry this much before returning
export const GATHER_PER_SEC = 5; // resource units harvested per second

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
    speed: 2.2,
    sight: 5,
    cost: { food: 50 },
    popCost: 1,
    trainMs: 6000,
    damage: 3,
    range: 0.6,
    attackMs: 1200,
    trainedAt: "town_center",
  },
  soldier: {
    type: "soldier",
    hp: 100,
    speed: 1.9,
    sight: 6,
    cost: { food: 60, gold: 20 },
    popCost: 1,
    trainMs: 9000,
    damage: 12,
    range: 0.8,
    attackMs: 1000,
    trainedAt: "barracks",
  },
};

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
    canTrain: ["soldier"],
  },
};

export const BASE_POP_CAP = 5;
export const HARD_POP_CAP = 50;

export const RESOURCE_NODE_AMOUNT: Record<ResourceKind, number> = {
  wood: 250,
  food: 150,
  gold: 400,
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

