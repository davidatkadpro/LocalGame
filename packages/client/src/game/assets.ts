import { Assets, type Texture } from "pixi.js";

import workerUrl from "../assets/worker.svg";
import soldierUrl from "../assets/soldier.svg";
import townCenterUrl from "../assets/town_center.svg";
import houseUrl from "../assets/house.svg";
import barracksUrl from "../assets/barracks.svg";
import treeUrl from "../assets/tree.svg";
import goldUrl from "../assets/gold.svg";
import foodUrl from "../assets/food.svg";

export type SpriteKey =
  | "worker"
  | "soldier"
  | "town_center"
  | "house"
  | "barracks"
  | "tree"
  | "gold"
  | "food";

const URLS: Record<SpriteKey, string> = {
  worker: workerUrl,
  soldier: soldierUrl,
  town_center: townCenterUrl,
  house: houseUrl,
  barracks: barracksUrl,
  tree: treeUrl,
  gold: goldUrl,
  food: foodUrl,
};

export const textures = {} as Record<SpriteKey, Texture>;

export async function loadAssets(): Promise<void> {
  await Promise.all(
    (Object.keys(URLS) as SpriteKey[]).map(async (key) => {
      textures[key] = await Assets.load(URLS[key]);
    }),
  );
}
