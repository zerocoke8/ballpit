# 프로젝트: 동물 볼슈터 (ballshooter)

> 상위 폴더 `Desktop/CLAUDE.md`는 다른 프로젝트(LLM 텍스트 머드)의 규칙이다. 이 폴더에는 적용하지 않는다.

Ball Pit 류 슈터 + 백팩 히어로 류 가방 로그라이크. 웹(PixiJS v8) / 폰 세로모드 기준.
게임 설계는 [docs/DESIGN.md](docs/DESIGN.md), 모듈 구조와 공개 API는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 절대 규칙

1. **로직과 렌더링 분리.** `src/logic/`, `src/data/`는 PixiJS·DOM을 import 하지 않는다.
   순수 TypeScript로 남겨서 vitest(node 환경)로 테스트할 수 있어야 한다.
2. **전투 시뮬레이션은 고정 스텝·시드 RNG.** `Math.random()` 금지 — `src/logic/rng.ts` 사용.
   같은 시드 + 같은 입력이면 같은 결과.
3. **타입 계약은 `src/types.ts` 한 곳.** 모듈 간 주고받는 데이터 모양을 바꿀 땐 여기부터 고치고
   영향받는 모듈을 함께 고친다.
4. **게임 데이터는 `src/data/`에만.** 아이템·적·스테이지 수치를 씬/로직 코드에 하드코딩하지 않는다.
5. **UI 문자열은 `src/i18n/ko/`에.** 씬 코드에 한국어 문자열을 직접 쓰지 않는다
   (아이템·적 이름처럼 데이터에 속한 텍스트는 `src/data/`).
6. **에셋은 키로만 참조.** 모든 에셋 키는 `src/data/assets.json`에 등록. 생성된 PNG가 없으면
   플레이스홀더(이모지+도형)로 자동 대체되므로 게임은 아트 없이도 항상 돌아가야 한다.

## 명령어

- `npm run dev` — 개발 서버 (폰에서 접속하려면 같은 와이파이에서 표시되는 Network 주소)
- `npm test` — vitest (로직 단위 테스트)
- `npm run typecheck` / `npm run build`
- `npm run smoke` — Playwright(시스템 Edge/Chrome)로 폰 뷰포트에서 화면 흐름 스모크 테스트 + 스크린샷
- `npm run gen:assets` — Codex CLI 이미지 생성 → `public/assets/` (`--only key1,key2`, `--force`)
- `npm run gen:sfx` — ElevenLabs 효과음 생성 → `public/sfx/` (**크레딧 소모**. 먼저 `-- --dry-run`, 실패한 것만 `-- --only id1,id2`,
  `--force`는 이미 있는 클립도 다시 만들어 크레딧을 또 쓴다. 예산 걸기 `-- --budget 100`. 크레딧 없이 시험: `-- --mock`(자리표시 WAV),
  실패 경로 시험: `-- --no-env-file`(.env 안 읽음) / `-- --env-file <파일>` / `-- --api-base <가짜 서버>`.
  키는 `.env`의 `ELEVENLABS_API_KEY`(`.env.example` 복사) — 절대 출력·커밋하지 않는다. 만들 클립이 있는데 키가 없으면 API 호출 없이 종료 코드 1.
  첫 생성: 64클립 504 + 다시 만든 1클립 5 = 509 크레딧)
- `node tools/interaction-check.mjs` / `node tools/gap-playtest.mjs` / `node tools/juice-sheet.mjs` — 실제 터치 입력 검사 / st1 틈 쏘기 플레이 / 연출 시트
  (각자 `--port`로 자기 개발 서버를 띄우고 끈다 — 동시에 돌릴 땐 포트를 다르게)

## 폰에서 성능 보기 (`?perf`)

- PC에서 `npm run dev` → 터미널의 `Network: http://192.168.x.x:5173/` 주소 뒤에 `?perf`를 붙여 같은 와이파이의 폰으로 연다
  (예: `http://192.168.0.12:5173/?perf`). 이미 켜 둔 게임에서는 **세 손가락 탭** 또는 **왼쪽 위 구석 5번 탭**으로 켜고 끈다.
- 왼쪽 위 오버레이: FPS, `u`/`r` = 직전 프레임 update/render ms, 최근 3초 프레임 시간 그래프(초록 선 16.7 ms = 60fps, 노란 선 33.3 ms),
  아래 목록 = 25 ms 넘게 끊긴 프레임 최근 8개와 그 사이에 있었던 일(태그). 예: `12.3s 48ms u39 r8 toast text 12 upload×4 11`
  → 알림 글자 래스터화 12 ms + 업로드. 무슨 일이었나(`toast`, `goto` …)가 먼저, 그다음 시간 있는 태그가 오래 걸린 순서라
  줄 끝이 `…`로 잘려도 앞쪽이 주범이다. 태그 뜻은 docs/ARCHITECTURE.md 'debug/'(예: `sfxDecode` = 효과음 클립 다듬기, 타이틀 뒤 몇 초 동안만).
  태그 없는 `?`는 대개 JS GC·브라우저.
- 전후 비교: `?perf&noprewarm` (부팅 때 GPU 미리 올리기·알림 미리 굽기를 끔). 그래픽 품질 '낮음'(설정 창)은 렌더 해상도 1.25.
- 새 코드에서 의심 가는 구간은 `perfMark('태그')` / `perfMark('태그', perfNow() 값)`로 표시해 두면 오버레이에 같이 뜬다 (꺼져 있으면 비용 없음).

## 좌표계

- 논리 해상도 폭 720 고정. 높이는 화면비에 따라 1280~1560 (긴 폰은 HUD/하단 바 여백이 늘어남).
- 전투 필드는 고정 크기(`FIELD_W` × `FIELD_H`, `src/config.ts`) — 시뮬레이션은 화면 크기와 무관.

## 작업 방식

- 스키마(`src/types.ts`)나 세이브 포맷을 바꾸면 `SAVE_VERSION`을 올린다.
- 새 아이템/적/스테이지 추가 후 `npm test`의 데이터 검증 테스트가 통과해야 한다.
- 아트 프롬프트 스타일 가이드는 `tools/gen-assets.mjs`의 `STYLE` 상수. 에셋별 프롬프트는 `assets.json`.

## 아트 파이프라인

- **정적 이미지**: Codex CLI 내장 이미지 생성(gpt-image-2, ChatGPT 로그인) → `tools/.raw/` → sharp 트림/리사이즈 →
  `public/assets/<key>.png` + `manifest.json`의 `images`. 투명 배경 PNG가 바로 나온다.
- **그림체**: 단순한 플랫 만화풍(Capybara Go! 류) — 단색 채색, 균일한 갈색 외곽선, 점 눈, 볼터치, 2~3등신.
  레퍼런스 이미지 `tools/style/style_ref.png`를 매 생성마다 `codex exec -i`로 첨부한다. 이전(스티커풍) 버전은 `tools/.archive/v1/`.
  레퍼런스는 타 게임 스크린샷이라 git에 올리지 않는다(로컬 전용). 새로 클론했다면 같은 경로에 직접 넣는다 — 없으면 프롬프트만으로 생성된다.
- **캐릭터/몬스터 애니메이션 (예정)**: Seedance 2.5 API로 영상 생성 → 프레임 분리 → 스프라이트시트(PixiJS spritesheet JSON)
  → `public/assets/anim/` + `manifest.json`의 `anims[key][state]`. 상태는 `AnimState`(idle/move/attack/hit/die).
  렌더는 `ActorSprite`가 시트가 있으면 프레임 재생, 없으면 코드 애니메이션으로 대체하므로 게임 코드는 바꿀 필요 없다.

## 효과음 파이프라인

- **정의**: `src/data/sfx.json` — id·카테고리·ElevenLabs 프롬프트(영어)·길이·변형 수 + 재생 힌트(volume·maxVoices·minInterval·pitchVar).
  id 목록 `SFX_IDS`/타입 `SfxId`와 게임 데이터 → 소리 매핑(무기 계열, 적 탄, 속성, 우선순위)은 `src/data/sfxMap.ts`.
  새 효과음 = sfx.json 항목 + `SFX_IDS` + 부르는 코드 (`npm test`의 audio-data 테스트가 맞는지 검사).
- **생성**: `tools/gen-sfx.mjs` → `public/sfx/<id>_<n>.mp3` + `manifest.json`. 키는 `.env`의 `ELEVENLABS_API_KEY`(git 제외, 생성 도구만 읽음 —
  게임 코드에는 절대 넣지 않는다). 응답 헤더 `character-cost` 합을 마지막에 출력 (측정: 1초당 약 10 크레딧, 전체 64클립 약 500).
- **재생**: `src/audio/` (Web Audio). 씬에서는 `sfx.play(id)` / `sfx.playAt(id, pan, rate, volume)`만. 볼륨·빈도 조절은 sfx.json의
  volume/minInterval/maxVoices만 고치면 된다 (디코드 때 피크를 맞추므로 다시 생성할 필요 없음).
- `public/sfx/manifest.json`이 `{}`이거나 파일이 없어도 게임은 무음으로 그대로 돈다. 설정(효과음·볼륨·그래픽 품질)은 `core/settings.ts`.
