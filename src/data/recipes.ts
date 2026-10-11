import type { RecipeDef } from '../types';

// base 무기의 소켓(◇) 칸에 ingredient를 놓으면 result로 진화. result는 base와 같은 크기.
export const RECIPES: RecipeDef[] = [
  { id: 'r_tuna_missile', base: 'w_fish', ingredient: 's_ice', result: 'w_tuna_missile' },
  { id: 'r_static_hairball', base: 'w_hairball', ingredient: 's_lightning', result: 'w_static_hairball' },
  { id: 'r_yuzu_molotov', base: 'w_yuzu', ingredient: 's_fire', result: 'w_yuzu_molotov' },
  { id: 'r_sock_gatling', base: 'w_sock', ingredient: 's_haste', result: 'w_sock_gatling' },
  { id: 'r_mama_duck', base: 'w_duck', ingredient: 's_power', result: 'w_mama_duck' },
  { id: 'r_flame_toaster', base: 'w_toaster', ingredient: 's_fire', result: 'w_flame_toaster' },
  { id: 'r_methane_bomb', base: 'w_whoopee', ingredient: 's_fire', result: 'w_methane_bomb' },
  { id: 'r_melon_bingsu', base: 'w_watermelon', ingredient: 's_ice', result: 'w_melon_bingsu' },
];
