// 부팅 로딩 중 GPU 미리 올리기: 에셋 텍스처 전부를 업로드하고, 쓰이는 렌더 파이프(셰이더)를 한 번씩 컴파일한다.
//
// 왜: pixi는 텍스처를 '처음 그려질 때' 올린다 → 타이틀 첫 프레임, 처음 보는 적·투사체가 나오는 프레임에 업로드가 몰렸다
// (측정: 부팅 직후 타이틀 첫 두 프레임 217 + 168 ms @ CPU 4배 감속). 또 pixi 렌더러 GC는 60초 넘게 안 그려진 이미지
// 텍스처를 GPU에서 내려서(30초마다 검사), 상점에 오래 있다가 전투로 돌아오면 다시 올리느라 끊겼다.
// 여기서 올린 에셋 텍스처는 GC 대상에서 뺀다(autoGarbageCollect = false — 에셋 전체 RGBA 약 13 MB, 항상 쓰는 것들).
import {
  ColorMatrixFilter,
  Container,
  Graphics,
  NineSliceSprite,
  Particle,
  ParticleContainer,
  RenderTexture,
  Sprite,
  Text,
  Texture,
  TilingSprite,
  type Renderer,
  type TextureSource,
} from 'pixi.js';
import { perfMark, perfNow } from '../debug/perfOverlay';
import { loadedTextures } from './assets';

export interface GpuWarmOptions {
  /** 에셋 말고 함께 올릴 텍스처 (예: 미리 구운 전투 아틀라스) */
  extra?: readonly Texture[];
  /** 진행 (올린 개수, 전체) */
  onProgress?: (done: number, total: number) => void;
  /** 이 시간(ms)마다 다음 프레임으로 넘겨 로딩 표시가 멈추지 않게 */
  budgetMs?: number;
}

/** 텍스처를 GPU에 올린다 (이미 올라가 있으면 아무것도 안 함). WebGL/WebGPU 공통 API */
function upload(renderer: Renderer, source: TextureSource): void {
  const sys = (renderer as unknown as { texture?: { initSource?: (s: TextureSource) => void } }).texture;
  sys?.initSource?.(source);
}

export async function prewarmGpu(renderer: Renderer, opts: GpuWarmOptions = {}): Promise<void> {
  const t0 = perfNow();
  const sources = new Set<TextureSource>();
  for (const t of loadedTextures()) sources.add(t.source);
  for (const t of opts.extra ?? []) sources.add(t.source);
  const list = [...sources];
  const total = list.length + 1;
  const budget = opts.budgetMs ?? 12;
  let slice = performance.now();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    // 에셋은 항상 쓰므로 GPU에 상주 (렌더러 GC가 내렸다가 다시 올리며 끊기지 않게)
    s.autoGarbageCollect = false;
    upload(renderer, s);
    opts.onProgress?.(i + 1, total);
    if (performance.now() - slice > budget) {
      await nextFrame();
      slice = performance.now();
    }
  }
  warmPipes(renderer);
  opts.onProgress?.(total, total);
  perfMark('gpuWarm', t0);
}

/**
 * 쓰는 렌더 파이프를 화면 밖 작은 텍스처에 한 번씩 그려 셰이더·버퍼를 미리 만든다
 * (스프라이트 배치, 그래픽, 글자, 나인슬라이스, 파티클 컨테이너, 타일링 스프라이트, 색 행렬 필터).
 */
function warmPipes(renderer: Renderer): void {
  const target = RenderTexture.create({ width: 8, height: 8 });
  const root = new Container();
  const tex = Texture.WHITE;
  root.addChild(new Sprite(tex));
  root.addChild(new Graphics().rect(0, 0, 4, 4).fill(0xffffff).circle(4, 4, 2).stroke({ width: 1, color: 0 }));
  root.addChild(new Text({ text: '0', style: { fontSize: 8, fill: 0xffffff } }));
  root.addChild(new NineSliceSprite({ texture: tex, leftWidth: 1, rightWidth: 1, topHeight: 1, bottomHeight: 1, width: 4, height: 4 }));
  const pc = new ParticleContainer({ dynamicProperties: { position: true, rotation: true, color: true, vertex: true } });
  pc.addParticle(new Particle({ texture: tex, x: 1, y: 1 }));
  root.addChild(pc);
  root.addChild(new TilingSprite({ texture: tex, width: 4, height: 4 }));
  // 피격 번쩍임(ActorSprite)·필드 채도 낮추기가 쓰는 색 행렬 필터
  const filtered = new Sprite(tex);
  filtered.setSize(4, 4);
  const filter = new ColorMatrixFilter();
  filtered.filters = [filter];
  root.addChild(filtered);
  try {
    renderer.render({ container: root, target, clear: true });
  } catch (err) {
    console.warn('[gpuWarm] 파이프 미리 그리기 실패 (무시)', err);
  }
  root.destroy({ children: true, context: true });
  filter.destroy();
  target.destroy(true);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(t);
      resolve();
    });
  });
}
