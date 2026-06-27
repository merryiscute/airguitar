# 웹 버전 — 안드로이드 폰에서 테스트하기

`docs/` 의 `index.html` / `app.js` / `logic.js` / `style.css` 는 설치 없이 폰
브라우저에서 도는 에어 기타 웹 앱입니다. MediaPipe Tasks Vision(손 추적) +
Web Audio(소리)를 쓰며, 카메라·스피커는 폰 것을 그대로 사용합니다.

## 왜 GitHub Pages인가
브라우저는 **HTTPS(또는 localhost)** 에서만 카메라(`getUserMedia`)를 허용합니다.
폰에서 파일을 직접 열면(`file://`) 카메라 권한이 막히므로, HTTPS로 서빙해야 합니다.
이 저장소는 이미 GitHub에 있으니 **GitHub Pages**로 올리면 폰에서 URL만 열면 됩니다.

## 배포 방법 (1회 설정)
1. GitHub 저장소 → **Settings → Pages**
2. **Build and deployment → Source**: *Deploy from a branch*
3. **Branch**: `claude/session-start-mlockp` (또는 머지 후 `main`),
   **Folder**: `/docs` 선택 → **Save**
4. 1~2분 뒤 페이지 URL이 표시됩니다:
   `https://merryiscute.github.io/airguitar/`

## 폰에서 테스트
1. 안드로이드 **Chrome**에서 위 URL 접속
2. **시작 (카메라 허용)** 버튼 → 카메라 권한 **허용**
3. 폰을 세워 두고(전면 카메라가 나를 향하게) **오른손**을 카메라에 비춤
4. 손가락 굽힌 개수로 코드 선택: 0개=C / 1개=G / 2개=Am / 3개=F
5. 손목을 빠르게 **아래로**(다운) / **위로**(업) 휘둘러 스트럼 → 소리

> 소리가 안 나면: 폰 무음 모드 해제, 화면을 한 번 터치(오디오 활성화),
> 버튼 아래 빨간 글씨로 오류가 뜨면 그 내용을 알려주세요.

## 로컬에서 미리 보기 (PC)
```bash
python3 -m http.server 8000 --directory docs
# 브라우저에서 http://localhost:8000  (localhost는 카메라 허용됨)
```

## 로직 검증 (브라우저/카메라 없이)
```bash
node tests/web_logic.test.mjs   # 순수 로직 검증, 8개 통과
```

## 튜닝 포인트 (`app.js` / `logic.js`)
- 스트럼이 너무 민감/둔감 → 앱 안 **⚙ 코드 설정 → "스트럼 감도"** 슬라이더로 조절(저장됨).
  기본 임계값 0.7, 작을수록 민감. 코드 기본값은 `app.js`의 `DEFAULT_THRESHOLD`.
- 코드가 자주 깜빡 → `new FingerStabilizer(window)` 의 `window`(기본 5) 늘리기
- 인식이 중간에 끊김(모션 블러) → `app.js`의 `HOLD_S`(기본 0.2초) 유예 시간 늘리기,
  카메라 `frameRate: { ideal: 60 }` 요청으로 블러 완화
- 코드 매핑 변경 → 앱 안 **⚙ 코드 설정**, 또는 `logic.js`의 `CHORD_LIBRARY` / `DEFAULT_MAPPING`
