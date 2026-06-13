import { Assets, type Texture } from "pixi.js";

import workerUrl from "../assets/worker.svg";
import soldierUrl from "../assets/soldier.svg";
import archerUrl from "../assets/archer.svg";
import townCenterUrl from "../assets/town_center.svg";
import houseUrl from "../assets/house.svg";
import barracksUrl from "../assets/barracks.svg";
import towerUrl from "../assets/tower.svg";
import storehouseUrl from "../assets/storehouse.svg";
import farmUrl from "../assets/farm.svg";
import wallUrl from "../assets/wall.svg";
import treeUrl from "../assets/tree.svg";
import goldUrl from "../assets/gold.svg";
import foodUrl from "../assets/food.svg";
// Team-colour accent layers (white shapes, tinted with the player's colour).
import workerAccentUrl from "../assets/worker_accent.svg";
import soldierAccentUrl from "../assets/soldier_accent.svg";
import archerAccentUrl from "../assets/archer_accent.svg";
import townCenterAccentUrl from "../assets/town_center_accent.svg";
import houseAccentUrl from "../assets/house_accent.svg";
import barracksAccentUrl from "../assets/barracks_accent.svg";
import towerAccentUrl from "../assets/tower_accent.svg";
import storehouseAccentUrl from "../assets/storehouse_accent.svg";
import farmAccentUrl from "../assets/farm_accent.svg";
import wallAccentUrl from "../assets/wall_accent.svg";

export type SpriteKey =
  | "worker"
  | "soldier"
  | "archer"
  | "town_center"
  | "house"
  | "barracks"
  | "tower"
  | "storehouse"
  | "farm"
  | "wall"
  | "tree"
  | "gold"
  | "food"
  | "worker_accent"
  | "soldier_accent"
  | "archer_accent"
  | "town_center_accent"
  | "house_accent"
  | "barracks_accent"
  | "tower_accent"
  | "storehouse_accent"
  | "farm_accent"
  | "wall_accent";

const URLS: Record<SpriteKey, string> = {
  worker: workerUrl,
  soldier: soldierUrl,
  archer: archerUrl,
  town_center: townCenterUrl,
  house: houseUrl,
  barracks: barracksUrl,
  tower: towerUrl,
  storehouse: storehouseUrl,
  farm: farmUrl,
  wall: wallUrl,
  tree: treeUrl,
  gold: goldUrl,
  food: foodUrl,
  worker_accent: workerAccentUrl,
  soldier_accent: soldierAccentUrl,
  archer_accent: archerAccentUrl,
  town_center_accent: townCenterAccentUrl,
  house_accent: houseAccentUrl,
  barracks_accent: barracksAccentUrl,
  tower_accent: towerAccentUrl,
  storehouse_accent: storehouseAccentUrl,
  farm_accent: farmAccentUrl,
  wall_accent: wallAccentUrl,
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
