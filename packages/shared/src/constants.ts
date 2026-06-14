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

// Soft-body radius of a unit; the collision pass keeps unit centres at least
// UNIT_SEPARATION apart. A melee unit's attack `range` must exceed this gap or it
// could never close to striking distance (see the worker def below).
export const UNIT_RADIUS = 0.32;
export const UNIT_SEPARATION = UNIT_RADIUS * 2; // 0.64 — min gap between centres

// ---- Lobby / players ----
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const PLAYER_COLORS = ["#e6492d", "#2d7fe6", "#27ae60", "#f1c40f"];

// ---- Map ----
export const MAP_WIDTH = 64;
export const MAP_HEIGHT = 64;

// ---- §7.10 Map objectives ----
// A completed Wonder starts this countdown; if it survives, the owner's team
// wins outright (a non-annihilation victory). Long enough to be answerable.
export const WONDER_COUNTDOWN_MS = 360_000; // 6 minutes
// Relics: neutral monuments that pay gold to whoever currently holds them.
export const RELIC_COUNT = 4; // placed on contested ground at map gen
export const RELIC_CAPTURE_RADIUS = 1.5; // a unit this close (tiles) claims it
export const RELIC_GOLD_PER_SEC = 0.5; // gold/sec trickled to the holding player

// ---- Economy ----
// Stone is the defensive resource (towers / fortifications); a small starter
// stock lets a Feudal player raise their first tower without mining first.
export const STARTING_RESOURCES: Resources = { wood: 200, food: 200, gold: 120, stone: 100 };
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
  /** earliest age this unit can be trained (0 = Dark, 1 = Feudal, 2 = Imperial) */
  minAge?: number;
  /** §7.7 siege splash: when set, an attack also damages every enemy unit within
   *  this radius (tiles) of the target — the mangonel's anti-clump role. */
  splashRadius?: number;
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
    range: 0.75, // must exceed UNIT_SEPARATION (0.64) so melee can connect
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
    minAge: 1, // Feudal
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
    minAge: 1, // Feudal
  },
  cavalry: {
    type: "cavalry",
    hp: 100,
    speed: 3.0, // fastest unit: a raider that runs workers and archers down
    sight: 7,
    cost: { food: 70, gold: 30 }, // gold-gated raider trained at the Stable
    popCost: 1,
    trainMs: 11000,
    damage: 12,
    range: 0.8, // melee
    attackMs: 1000,
    trainedAt: "stable",
    minAge: 1, // Feudal
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
    minAge: 2, // Imperial
  },
  mangonel: {
    type: "mangonel",
    hp: 80,
    speed: 1.3, // slow siege; needs an escort
    sight: 8,
    cost: { wood: 160, gold: 75 },
    popCost: 2,
    trainMs: 16000,
    damage: 14,
    range: 6, // out-ranges archers (5) so it can open on a massed ball
    attackMs: 2500, // slow reload
    trainedAt: "siege_workshop",
    minAge: 2, // Imperial
    splashRadius: 1.5, // anti-clump: shreds bunched archers/infantry (§7.7)
  },
  trebuchet: {
    type: "trebuchet",
    hp: 100,
    speed: 1.0, // very slow: a positional siege weapon
    sight: 10,
    cost: { wood: 200, gold: 200 },
    popCost: 3, // heavy
    trainMs: 20000,
    damage: 30, // ×6 vs buildings (see DAMAGE_COUNTERS) = 180/hit; ~10 vs units
    range: 11, // very long range — out-ranges towers (5) and the TC (6)
    attackMs: 4000, // ponderous
    trainedAt: "siege_workshop",
    minAge: 2, // Imperial
  },
};

/** Unit types that count as military (for combat upgrades). */
export const MILITARY: UnitType[] = ["soldier", "archer", "cavalry", "ram", "mangonel", "trebuchet"];

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
  /** earliest age this building can be built (0 = Dark, 1 = Feudal, 2 = Imperial) */
  minAge?: number;
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
    // §7.5a: the TC bites back like a tower — a free, universal soft-deterrent
    // vs early raids. Out-ranges archers (6 vs 5) so a lone archer can't snipe
    // villagers under it; massed ranged units still overwhelm it. Tunable.
    attack: { damage: 6, range: 6, attackMs: 1000 },
    research: ["improvedTools", "fineTools", "masterTools"],
    buildable: false,
  },
  house: {
    type: "house",
    hp: 300,
    sight: 4,
    size: { w: 2, h: 2 },
    cost: { wood: 50 },
    // Pure pop-enabler with no other use; 12s stalled mid-game army growth, so
    // bring it in line with the storehouse (10s) for a smoother pop curve.
    buildMs: 10000,
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
    minAge: 1, // Feudal
  },
  stable: {
    type: "stable",
    hp: 600,
    sight: 5,
    size: { w: 3, h: 3 },
    cost: { wood: 175 },
    buildMs: 20000,
    providesPop: 0,
    isDropOff: false,
    canTrain: ["cavalry"], // mounted raiders: fast eco harassment, weak to soldiers
    buildable: true,
    minAge: 1, // Feudal
  },
  blacksmith: {
    type: "blacksmith",
    hp: 600,
    sight: 4,
    size: { w: 3, h: 3 },
    cost: { wood: 150, stone: 40 },
    buildMs: 20000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    // Home of the upper combat tiers (§7.3): attack II/III + armor II/III. Tier I
    // stays at the barracks, so a Blacksmith is the gate to *deepening* an army's
    // edge rather than just having one.
    research: ["temperedBlades", "honedBlades", "leatherArmor", "plateArmor"],
    buildable: true,
    minAge: 1, // Feudal
  },
  tower: {
    type: "tower",
    hp: 500,
    sight: 8,
    size: { w: 2, h: 2 },
    // §7.4: towers are the stone sink — gold now funds units & tech, stone funds
    // defence. So a turtle/defensive plan has to contest the map's stone patches.
    cost: { wood: 75, stone: 50 },
    buildMs: 15000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    // Nerf: was 16 dmg / range 6 / 800ms (out-ranged archers and out-DPS'd
    // soldiers). Now trades evenly with massed ranged units.
    attack: { damage: 10, range: 5, attackMs: 1000 },
    buildable: true,
    minAge: 1, // Feudal
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
  // Specialised drop-off camps: a forward drop-off like the storehouse, but each
  // also grants a +gather bonus (CAMP_GATHER_BONUS) for ITS resource when it is
  // the worker's nearest drop-off. Costs a touch more than the generic storehouse,
  // so placement (right camp by the right patch) is a real eco decision. See
  // CAMP_RESOURCE / campBonusFor below.
  lumber_camp: {
    type: "lumber_camp",
    hp: 250,
    sight: 3,
    size: { w: 2, h: 2 },
    cost: { wood: 75 },
    buildMs: 10000,
    providesPop: 0,
    isDropOff: true,
    canTrain: [],
    buildable: true,
  },
  mining_camp: {
    type: "mining_camp",
    hp: 250,
    sight: 3,
    size: { w: 2, h: 2 },
    cost: { wood: 75 },
    buildMs: 10000,
    providesPop: 0,
    isDropOff: true,
    canTrain: [],
    buildable: true,
  },
  mill: {
    type: "mill",
    hp: 250,
    sight: 3,
    size: { w: 2, h: 2 },
    cost: { wood: 75 },
    buildMs: 10000,
    providesPop: 0,
    isDropOff: true,
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
  // Wall tiers (§7.6): palisade → stone → fortified. Each is a 1×1 wall-like
  // building that drag-places into a line and auto-connects; higher tiers cost
  // stone, take longer, and have far more hp (siege-resistance scales with age +
  // a stone economy). See WALL_TYPES / isWall.
  wall: {
    type: "wall",
    hp: 200,
    sight: 1,
    size: { w: 1, h: 1 },
    cost: { wood: 10 }, // palisade — cheap wooden speed-bump, available immediately
    buildMs: 3000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    buildable: true,
  },
  stone_wall: {
    type: "stone_wall",
    hp: 600,
    sight: 1,
    size: { w: 1, h: 1 },
    cost: { wood: 5, stone: 15 }, // real defence once you've a stone economy
    buildMs: 6000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    buildable: true,
    minAge: 1, // Feudal
  },
  fortified_wall: {
    type: "fortified_wall",
    hp: 1500,
    sight: 1,
    size: { w: 1, h: 1 },
    cost: { wood: 5, stone: 35 }, // a late-game fortress wall; shrugs off rams
    buildMs: 10000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    buildable: true,
    minAge: 2, // Imperial
  },
  gate: {
    type: "gate",
    // A wall-line door: sturdier than a wall, and passable to its owner's team
    // (handled in the sim) while staying solid to enemies. Built singly into a
    // gap in a wall run.
    hp: 300,
    sight: 1,
    size: { w: 1, h: 1 },
    cost: { wood: 30 },
    buildMs: 6000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    buildable: true,
    minAge: 0, // Dark Age, same as walls
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
    canTrain: ["ram", "mangonel", "trebuchet"], // gates siege behind a dedicated tech building
    buildable: true,
    minAge: 2, // Imperial
  },
  wonder: {
    type: "wonder",
    hp: 1500,
    sight: 6,
    size: { w: 3, h: 3 },
    // §7.10 — an alternate, non-annihilation win. Hugely expensive (wood + gold +
    // stone, an army's worth of economy to race the clock) and very slow to
    // raise, so the enemy gets real time to mount an assault. Tunable.
    cost: { wood: 600, gold: 500, stone: 400 },
    buildMs: 90000,
    providesPop: 0,
    isDropOff: false,
    canTrain: [],
    buildable: true,
    minAge: 2, // Imperial only
  },
};

/** The wall tiers, weakest→strongest. All behave identically (1×1, blocks
 *  pathing, drag-places into an auto-connecting line); they differ only in
 *  cost / build time / hp / age. Gates are wall-line doors, handled separately. */
export const WALL_TYPES: BuildingType[] = ["wall", "stone_wall", "fortified_wall"];

/** True if `type` is one of the wall tiers (not a gate). */
export function isWall(type: BuildingType): boolean {
  return WALL_TYPES.includes(type);
}

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  blurb: string;
  cost: Partial<Resources>;
  researchMs: number;
  building: BuildingType;
  /** earliest age this upgrade can be researched (0 = Dark, 1 = Feudal, 2 = Imperial) */
  minAge?: number;
  /** the upgrade that must already be researched first (the previous tier in a
   *  line); undefined for a tier-I / standalone upgrade */
  requires?: UpgradeId;
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
    minAge: 1, // Feudal (its building is too)
  },
  paddedArmor: {
    id: "paddedArmor",
    name: "Padded Armor",
    blurb: "Military units take −25% damage",
    cost: { wood: 150, gold: 100 },
    researchMs: 25000,
    building: "barracks",
    minAge: 1, // Feudal
  },
  // ---- Tier II/III lines (§7.3, researched at the Blacksmith / Town Center) ----
  // Magnitudes live in the UPGRADE_LINES tables below; the effective stat uses
  // the highest tier owned, so a line never stacks on itself.
  fineTools: {
    id: "fineTools",
    name: "Fine Tools",
    blurb: "Workers gather +75% faster",
    cost: { wood: 250, food: 200 },
    researchMs: 30000,
    building: "town_center",
    minAge: 1, // Feudal
    requires: "improvedTools",
  },
  masterTools: {
    id: "masterTools",
    name: "Master Tools",
    blurb: "Workers gather +100% faster",
    cost: { wood: 400, food: 300 },
    researchMs: 45000,
    building: "town_center",
    minAge: 2, // Imperial
    requires: "fineTools",
  },
  temperedBlades: {
    id: "temperedBlades",
    name: "Tempered Blades",
    blurb: "Military units deal +45% damage",
    cost: { food: 200, gold: 150 },
    researchMs: 30000,
    building: "blacksmith",
    minAge: 1, // Feudal
    requires: "sharpenedBlades",
  },
  honedBlades: {
    id: "honedBlades",
    name: "Honed Blades",
    blurb: "Military units deal +65% damage",
    cost: { food: 300, gold: 250 },
    researchMs: 45000,
    building: "blacksmith",
    minAge: 2, // Imperial
    requires: "temperedBlades",
  },
  leatherArmor: {
    id: "leatherArmor",
    name: "Leather Armor",
    blurb: "Military units take −38% damage",
    cost: { wood: 200, gold: 150 },
    researchMs: 30000,
    building: "blacksmith",
    minAge: 1, // Feudal
    requires: "paddedArmor",
  },
  plateArmor: {
    id: "plateArmor",
    name: "Plate Armor",
    blurb: "Military units take −50% damage",
    cost: { wood: 300, gold: 250 },
    researchMs: 45000,
    building: "blacksmith",
    minAge: 2, // Imperial
    requires: "leatherArmor",
  },
};

/** Tiered upgrade lines (§7.3). Each line is researched in order — tier N
 *  requires N-1 — and the effective stat applies the *highest* tier owned (the
 *  tables below are parallel to these, indexed I/II/III). Tier I keeps the
 *  original single-upgrade magnitudes, so existing balance holds. */
export const UPGRADE_LINES: Record<"attack" | "armor" | "gather", UpgradeId[]> = {
  attack: ["sharpenedBlades", "temperedBlades", "honedBlades"],
  armor: ["paddedArmor", "leatherArmor", "plateArmor"],
  gather: ["improvedTools", "fineTools", "masterTools"],
};
const ATTACK_MULT = [1.25, 1.45, 1.65]; // military damage dealt
const ARMOR_MULT = [0.75, 0.62, 0.5]; // military damage taken (lower = better)
const GATHER_MULT = [1.5, 1.75, 2.0]; // worker gather rate

/** Index of the highest tier owned in `line` (research is sequential), or -1. */
function bestTier(p: Player, line: UpgradeId[]): number {
  let t = -1;
  for (let i = 0; i < line.length; i++) if (p.upgrades.includes(line[i])) t = i;
  return t;
}

// ---- Ages (Dark -> Feudal -> Imperial) ----

export const MAX_AGE = 2; // 0 = Dark, 1 = Feudal, 2 = Imperial

export interface AgeDef {
  /** display name of THIS age */
  name: string;
  /** cost to advance INTO this age (index 0 is the starting age — unused) */
  advanceCost: Partial<Resources>;
  /** time to advance into this age, ms */
  advanceMs: number;
  /** at least one completed building of one of these types is required to advance */
  prereq: BuildingType[];
}

export const AGE_DEFS: AgeDef[] = [
  { name: "Dark Age", advanceCost: {}, advanceMs: 0, prereq: [] },
  {
    name: "Feudal Age",
    advanceCost: { food: 400, gold: 150 },
    advanceMs: 30000,
    prereq: ["storehouse", "farm"], // an established economy
  },
  {
    name: "Imperial Age",
    advanceCost: { food: 600, gold: 350 },
    advanceMs: 45000,
    prereq: ["barracks"], // an established military
  },
];

// Cumulative per-age bonuses, indexed by age. Applied live in the stat helpers
// below, so an age-up takes effect on every existing unit immediately.
export const AGE_GATHER_MULT = [1.0, 1.15, 1.3]; // economy-wide
export const AGE_DAMAGE_MULT = [1.0, 1.1, 1.2]; // military damage dealt
export const AGE_ARMOR_MULT = [1.0, 0.9, 0.85]; // military damage taken
export const AGE_POP_BONUS = [0, 10, 25]; // extra pop headroom

export function nextAge(age: number): number | null {
  return age < MAX_AGE ? age + 1 : null;
}

export function minAgeOfUnit(type: UnitType): number {
  return UNIT_DEFS[type].minAge ?? 0;
}
export function minAgeOfBuilding(type: BuildingType): number {
  return BUILDING_DEFS[type].minAge ?? 0;
}
export function minAgeOfUpgrade(id: UpgradeId): number {
  return UPGRADE_DEFS[id].minAge ?? 0;
}

// ---- effective stats (apply per-player upgrades + age) ----

export function hasUpgrade(p: Player, id: UpgradeId): boolean {
  return p.upgrades.includes(id);
}

export function gatherRate(p: Player): number {
  const t = bestTier(p, UPGRADE_LINES.gather);
  const tools = t >= 0 ? GATHER_MULT[t] : 1;
  return GATHER_PER_SEC * tools * AGE_GATHER_MULT[p.age ?? 0];
}

/** Resource(s) each specialised drop-off camp is themed around and boosts. The
 *  Mining Camp works both ores (gold + stone), so it's the drop-off for §7.4
 *  stone as well as gold. */
export const CAMP_RESOURCE: Partial<Record<BuildingType, ResourceKind[]>> = {
  lumber_camp: ["wood"],
  mining_camp: ["gold", "stone"],
  mill: ["food"],
};

/** Bonus a matching camp applies to its resource's gather rate. */
export const CAMP_GATHER_BONUS = 1.2; // +20%

/** Gather-rate multiplier a drop-off of `type` grants for harvesting `kind`
 *  (1 = no bonus). Only specialised camps boost the resource(s) they handle. */
export function campBonusFor(type: BuildingType, kind: ResourceKind): number {
  return CAMP_RESOURCE[type]?.includes(kind) ? CAMP_GATHER_BONUS : 1;
}

/** Damage a unit of `type` owned by `p` deals (before target armor). */
export function unitDamage(p: Player, type: UnitType): number {
  const base = UNIT_DEFS[type].damage;
  if (!MILITARY.includes(type)) return base;
  const t = bestTier(p, UPGRADE_LINES.attack);
  const blades = t >= 0 ? ATTACK_MULT[t] : 1;
  return base * blades * AGE_DAMAGE_MULT[p.age ?? 0];
}

/** Damage actually taken by a unit of `type` owned by `target`, after armor. */
export function incomingDamage(target: Player, type: UnitType, dmg: number): number {
  if (!MILITARY.includes(type)) return dmg;
  const t = bestTier(target, UPGRADE_LINES.armor);
  const armor = t >= 0 ? ARMOR_MULT[t] : 1;
  return dmg * armor * AGE_ARMOR_MULT[target.age ?? 0];
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
  // Soldiers (infantry) run down archers, cavalry, and all siege.
  soldier: { archer: 1.5, cavalry: 1.5, ram: 1.5, mangonel: 1.5, trebuchet: 1.5 },
  // Archers shred soldiers/rams at range, harass workers, weak on structures.
  // They pick apart a lone trebuchet, but a mangonel out-ranges and splashes them.
  archer: { soldier: 1.75, ram: 1.5, trebuchet: 1.5, worker: 1.25, building: 0.5 },
  // Cavalry: a raider — rides down archers, workers, and the slow siege line, but
  // soldiers counter it and it can't besiege (soldier > cavalry > archer > soldier).
  cavalry: { archer: 1.5, worker: 1.5, mangonel: 1.5, trebuchet: 1.5, building: 0.5 },
  // Rams demolish buildings/walls but are near-useless against units (needs an escort).
  ram: { worker: 0.34, soldier: 0.34, archer: 0.34, cavalry: 0.34, ram: 0.34, building: 5 },
  // Mangonel: anti-clump. Its damage comes from the area splash (see splashRadius),
  // so per-target it's unremarkable and weak against buildings.
  mangonel: { building: 0.4 },
  // Trebuchet: the premier siege engine — devastating, long-range anti-building,
  // but nearly useless if an enemy closes to melee it.
  trebuchet: {
    worker: 0.34, soldier: 0.34, archer: 0.34, cavalry: 0.34,
    ram: 0.34, mangonel: 0.34, trebuchet: 0.34, building: 6,
  },
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
  stone: 350,
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
  return { wood: 0, food: 0, gold: 0, stone: 0 };
}

export function canAfford(have: Resources, cost: Partial<Resources>): boolean {
  return (
    have.wood >= (cost.wood ?? 0) &&
    have.food >= (cost.food ?? 0) &&
    have.gold >= (cost.gold ?? 0) &&
    have.stone >= (cost.stone ?? 0)
  );
}

export function payCost(have: Resources, cost: Partial<Resources>): void {
  have.wood -= cost.wood ?? 0;
  have.food -= cost.food ?? 0;
  have.gold -= cost.gold ?? 0;
  have.stone -= cost.stone ?? 0;
}

