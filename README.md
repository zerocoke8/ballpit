# 동물 볼슈터 (ballpit)

동물 친구들이 우스꽝스러운 물건을 던져 장난감 군단을 막는 세로형 볼슈터 + 가방 로그라이크 프로토타입.
PixiJS v8 + TypeScript, 폰 세로 화면 기준.

**▶ 플레이: https://zerocoke8.github.io/ballpit/**

## 조작

- **드래그**: 이동 (캐릭터가 손가락 쪽으로 걸어감, 필드 어디든)
- **탭 / 클릭**: 그 방향으로 조준 — 이동해도 각도 유지, 무기가 쿨타임마다 자동 발사
- **가방 버튼 / B 키**: 일시정지 + 가방 (아이템 배치·회전·합성)
- PC: 방향키·WASD 이동, Q/E 조준 미세 조정
- 적과 닿거나 적이 맨 아래 선에 닿으면 패배

## 로컬 실행

```bash
npm install
npm run dev     # 같은 와이파이의 폰에서는 터미널의 Network 주소로 접속
npm test        # 로직 단위 테스트
npm run build   # dist/ 정적 빌드
```

`main`에 푸시하면 GitHub Actions가 빌드해서 GitHub Pages로 자동 배포한다(`.github/workflows/deploy-pages.yml`).
주소 뒤에 `?perf`를 붙이면 성능 오버레이가 뜬다.

설계·구조 문서: [docs/DESIGN.md](docs/DESIGN.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), 작업 규칙: [CLAUDE.md](CLAUDE.md)

아트는 Codex(gpt-image) 이미지 생성, 효과음은 ElevenLabs 효과음 생성으로 만들었다.
