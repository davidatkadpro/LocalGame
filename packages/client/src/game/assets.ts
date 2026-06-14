import { Assets, type Texture } from "pixi.js";

import workerUrl from "../assets/worker.svg";
import soldierUrl from "../assets/soldier.svg";
import archerUrl from "../assets/archer.svg";
import cavalryUrl from "../assets/cavalry.svg";
import ramUrl from "../assets/ram.svg";
import mangonelUrl from "../assets/mangonel.svg";
import trebuchetUrl from "../assets/trebuchet.svg";
import townCenterUrl from "../assets/town_center.svg";
import houseUrl from "../assets/house.svg";
import barracksUrl from "../assets/barracks.svg";
import stableUrl from "../assets/stable.svg";
import blacksmithUrl from "../assets/blacksmith.svg";
import towerUrl from "../assets/tower.svg";
import storehouseUrl from "../assets/storehouse.svg";
import lumberCampUrl from "../assets/lumber_camp.svg";
import miningCampUrl from "../assets/mining_camp.svg";
import millUrl from "../assets/mill.svg";
import farmUrl from "../assets/farm.svg";
import wallUrl from "../assets/wall.svg";
import wallStraightUrl from "../assets/wall_straight.svg";
import wallEndUrl from "../assets/wall_end.svg";
import wallCornerUrl from "../assets/wall_corner.svg";
import wallTeeUrl from "../assets/wall_tee.svg";
import wallCrossUrl from "../assets/wall_cross.svg";
import gateUrl from "../assets/gate.svg";
import siegeWorkshopUrl from "../assets/siege_workshop.svg";
import treeUrl from "../assets/tree.svg";
import goldUrl from "../assets/gold.svg";
import stoneUrl from "../assets/stone.svg";
import foodUrl from "../assets/food.svg";
import sheepUrl from "../assets/sheep.svg";
import cowUrl from "../assets/cow.svg";
import meatUrl from "../assets/meat.svg";
// Team-colour accent layers (white shapes, tinted with the player's colour).
import workerAccentUrl from "../assets/worker_accent.svg";
import soldierAccentUrl from "../assets/soldier_accent.svg";
import archerAccentUrl from "../assets/archer_accent.svg";
import cavalryAccentUrl from "../assets/cavalry_accent.svg";
import ramAccentUrl from "../assets/ram_accent.svg";
import mangonelAccentUrl from "../assets/mangonel_accent.svg";
import trebuchetAccentUrl from "../assets/trebuchet_accent.svg";
import townCenterAccentUrl from "../assets/town_center_accent.svg";
import houseAccentUrl from "../assets/house_accent.svg";
import barracksAccentUrl from "../assets/barracks_accent.svg";
import stableAccentUrl from "../assets/stable_accent.svg";
import blacksmithAccentUrl from "../assets/blacksmith_accent.svg";
import towerAccentUrl from "../assets/tower_accent.svg";
import storehouseAccentUrl from "../assets/storehouse_accent.svg";
import lumberCampAccentUrl from "../assets/lumber_camp_accent.svg";
import miningCampAccentUrl from "../assets/mining_camp_accent.svg";
import millAccentUrl from "../assets/mill_accent.svg";
import farmAccentUrl from "../assets/farm_accent.svg";
import wallAccentUrl from "../assets/wall_accent.svg";
import gateAccentUrl from "../assets/gate_accent.svg";
import siegeWorkshopAccentUrl from "../assets/siege_workshop_accent.svg";

export type SpriteKey =
  | "worker"
  | "soldier"
  | "archer"
  | "cavalry"
  | "ram"
  | "mangonel"
  | "trebuchet"
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
  | "wall_straight"
  | "wall_end"
  | "wall_corner"
  | "wall_tee"
  | "wall_cross"
  | "gate"
  | "siege_workshop"
  | "tree"
  | "gold"
  | "stone"
  | "food"
  | "sheep"
  | "cow"
  | "meat"
  | "worker_accent"
  | "soldier_accent"
  | "archer_accent"
  | "cavalry_accent"
  | "ram_accent"
  | "mangonel_accent"
  | "trebuchet_accent"
  | "town_center_accent"
  | "house_accent"
  | "barracks_accent"
  | "stable_accent"
  | "blacksmith_accent"
  | "tower_accent"
  | "storehouse_accent"
  | "lumber_camp_accent"
  | "mining_camp_accent"
  | "mill_accent"
  | "farm_accent"
  | "wall_accent"
  | "gate_accent"
  | "siege_workshop_accent";

const URLS: Record<SpriteKey, string> = {
  worker: workerUrl,
  soldier: soldierUrl,
  archer: archerUrl,
  cavalry: cavalryUrl,
  ram: ramUrl,
  mangonel: mangonelUrl,
  trebuchet: trebuchetUrl,
  town_center: townCenterUrl,
  house: houseUrl,
  barracks: barracksUrl,
  stable: stableUrl,
  blacksmith: blacksmithUrl,
  tower: towerUrl,
  storehouse: storehouseUrl,
  lumber_camp: lumberCampUrl,
  mining_camp: miningCampUrl,
  mill: millUrl,
  farm: farmUrl,
  // Wall tiers reuse the palisade geometry; the auto-tiler swaps in the right
  // variant and the renderer tints by tier, so no extra art is needed.
  wall: wallUrl,
  stone_wall: wallUrl,
  fortified_wall: wallUrl,
  wall_straight: wallStraightUrl,
  wall_end: wallEndUrl,
  wall_corner: wallCornerUrl,
  wall_tee: wallTeeUrl,
  wall_cross: wallCrossUrl,
  gate: gateUrl,
  siege_workshop: siegeWorkshopUrl,
  tree: treeUrl,
  gold: goldUrl,
  stone: stoneUrl,
  food: foodUrl,
  sheep: sheepUrl,
  cow: cowUrl,
  meat: meatUrl,
  worker_accent: workerAccentUrl,
  soldier_accent: soldierAccentUrl,
  archer_accent: archerAccentUrl,
  cavalry_accent: cavalryAccentUrl,
  ram_accent: ramAccentUrl,
  mangonel_accent: mangonelAccentUrl,
  trebuchet_accent: trebuchetAccentUrl,
  town_center_accent: townCenterAccentUrl,
  house_accent: houseAccentUrl,
  barracks_accent: barracksAccentUrl,
  stable_accent: stableAccentUrl,
  blacksmith_accent: blacksmithAccentUrl,
  tower_accent: towerAccentUrl,
  storehouse_accent: storehouseAccentUrl,
  lumber_camp_accent: lumberCampAccentUrl,
  mining_camp_accent: miningCampAccentUrl,
  mill_accent: millAccentUrl,
  farm_accent: farmAccentUrl,
  wall_accent: wallAccentUrl,
  gate_accent: gateAccentUrl,
  siege_workshop_accent: siegeWorkshopAccentUrl,
};

/** Whether a sprite type has a team-colour accent layer. */
export function accentKey(type: string): SpriteKey | null {
  const k = `${type}_accent` as SpriteKey;
  return k in URLS ? k : null;
}

export const textures = {} as Record<SpriteKey, Texture>;

export async function loadAssets(): Promise<void> {
  await Promise.all(
    (Object.keys(URLS) as SpriteKey[]).map(async (key) => {
      textures[key] = await Assets.load(URLS[key]);
    }),
  );
}
