// 전역 Game: 현재 런 상태를 들고 화면 전환을 담당한다.
import { initAudio } from './audio';
import type { GameApp } from './core/app';
import { SceneManager } from './core/scene';
import { GAME_DATA } from './data';
import { clampRunHp, clearRun, loadRun, newRun, saveRun } from './logic/run';
import { randomSeed } from './logic/rng';
import type { GameData, RunState, RunStats, Tier } from './types';
import { CharacterSelectScene } from './scenes/CharacterSelectScene';
import { CombatScene } from './scenes/combat/CombatScene';
import { ResultScene } from './scenes/ResultScene';
import { ShopScene } from './scenes/ShopScene';
import { StageClearScene } from './scenes/StageClearScene';
import { TitleScene } from './scenes/TitleScene';

export interface StageSummary {
  stageIndex: number;
  kills: number;
  goldEarned: number;
  drops: { defId: string; tier: Tier }[];
  clearGold: number;
  healed: number;
  /** 마지막 스테이지까지 클리어했으면 true → 결과 화면으로 */
  finished: boolean;
}

export interface RunResult {
  won: boolean;
  stageIndex: number;
  characterId: string;
  stats: RunStats;
}

export interface Game {
  readonly gameApp: GameApp;
  readonly data: GameData;
  readonly scenes: SceneManager;
  run: RunState | null;
  hasSave(): boolean;
  toTitle(): void;
  toCharacterSelect(): void;
  /** newRun → toCombat(저장 포함) */
  startRun(characterId: string): void;
  /** loadRun → resumeAt에 따라 상점/전투. 세이브가 없거나 깨졌으면 캐릭터 선택 */
  continueRun(): void;
  toCombat(): void;
  toStageClear(summary: StageSummary): void;
  toShop(): void;
  /** 세이브 삭제 후 결과 화면 */
  toResult(result: RunResult): void;
}

export let game: Game;

export function initGame(gameApp: GameApp): Game {
  // 효과음: 제스처 잠금 해제 리스너 + 백그라운드 로드 예약 (manifest가 없거나 비었으면 조용히 무음)
  initAudio();
  const data = GAME_DATA;
  const scenes = new SceneManager(gameApp);

  const g: Game = {
    gameApp,
    data,
    scenes,
    run: null,
    hasSave: () => loadRun(data) !== null,
    toTitle: () => scenes.goto(new TitleScene()),
    toCharacterSelect: () => scenes.goto(new CharacterSelectScene()),
    startRun(characterId) {
      g.run = newRun(data, characterId, randomSeed());
      g.toCombat();
    },
    continueRun() {
      const run = loadRun(data);
      if (!run) {
        g.toCharacterSelect();
        return;
      }
      g.run = run;
      if (run.resumeAt === 'shop') g.toShop();
      else g.toCombat();
    },
    toCombat() {
      const run = g.run;
      if (!run) return g.toTitle();
      run.resumeAt = 'combat';
      clampRunHp(data, run);
      saveRun(run);
      scenes.goto(new CombatScene());
    },
    toStageClear: (summary) => scenes.goto(new StageClearScene(summary)),
    toShop() {
      const run = g.run;
      if (!run) return g.toTitle();
      run.resumeAt = 'shop';
      clampRunHp(data, run);
      saveRun(run);
      scenes.goto(new ShopScene());
    },
    toResult(result) {
      clearRun();
      g.run = null;
      scenes.goto(new ResultScene(result));
    },
  };

  game = g;
  return g;
}
