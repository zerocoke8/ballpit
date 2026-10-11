import type { AssetDef, GameData } from '../types';
import assetList from './assets.json';
import { CHARACTERS } from './characters';
import { ENEMIES } from './enemies';
import { ITEMS } from './items';
import { RECIPES } from './recipes';
import { STAGES } from './stages';

export { CHARACTERS, ENEMIES, ITEMS, RECIPES, STAGES };

export const GAME_DATA: GameData = {
  items: ITEMS,
  recipes: RECIPES,
  enemies: ENEMIES,
  stages: STAGES,
  characters: CHARACTERS,
};

export const ASSETS: AssetDef[] = assetList as AssetDef[];

export const ASSET_MAP: Record<string, AssetDef> = Object.fromEntries(ASSETS.map((a) => [a.key, a]));
