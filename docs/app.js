// 에어 기타 (오른손) — 웹 버전
// MediaPipe Tasks Vision(HandLandmarker) + Web Audio.
// 순수 로직은 logic.js, 여기서는 카메라/추론/오디오/렌더만 담당한다.

import {
  buildChordsFromMapping,
  CHORD_LIBRARY,
  DEFAULT_MAPPING,
  countBent,
  FingerStabilizer,
  WristVelocity,
  StrumDetector,
} from "./logic.js";

// MediaPipe Tasks Vision은 init()에서 동적 import 한다.
// 최상위 static import로 두면 CDN이 잠깐 안 될 때 모듈 전체가 죽어
// 버튼이 먹통이 되고 에러도 안 보이기 때문(에러를 화면에 표시하기 위함).
const VISION =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// 손가락→코드 매핑은 localStorage에 저장해 다음 방문에도 유지한다.
const MAP_KEY = "airguitar.chordMapping";
function loadMapping() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_KEY));
    if (saved && typeof saved === "object") return { ...DEFAULT_MAPPING, ...saved };
  } catch {}
  return { ...DEFAULT_MAPPING };
}
let mapping = loadMapping();
let CHORDS = buildChordsFromMapping(mapping);

// --- 오디오: Karplus-Strong 플럭 + 바디 공명/리버브 체인 -------------------
// 더 사실적인 어쿠스틱 기타 톤을 위해:
//  · 픽을 부드럽게(저역통과 여기) + DC 제거
//  · 주파수별 감쇠(저음 길게, 고음 짧게)
//  · 기타 바디 공명 EQ + 고역 롤오프(따뜻함)
//  · 절차적 임펄스 컨볼루션 리버브 + 컴프레서
//  · 현마다 미세한 디튠/세기/스테레오 퍼짐
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.busInput = null;  // 모든 현이 모이는 입력 버스
    this.duration = 2.2;
    this.spread = 0.022;   // 스트럼 음 간격(초)
    this.bufferCache = new Map();
  }

  resume() {
    if (!this.ctx) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;

      this.busInput = ctx.createGain();
      this.busInput.gain.value = 0.9;

      // 기타 바디 공명 + 따뜻함
      const body1 = ctx.createBiquadFilter();
      body1.type = "peaking"; body1.frequency.value = 100; body1.Q.value = 1.0; body1.gain.value = 4;
      const body2 = ctx.createBiquadFilter();
      body2.type = "peaking"; body2.frequency.value = 240; body2.Q.value = 1.2; body2.gain.value = 3;
      const warmth = ctx.createBiquadFilter();
      warmth.type = "highshelf"; warmth.frequency.value = 3800; warmth.gain.value = -5;
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass"; tone.frequency.value = 7000; tone.Q.value = 0.7;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 3;
      comp.attack.value = 0.003; comp.release.value = 0.25;

      // 절차적 리버브(공간감)
      const conv = ctx.createConvolver();
      conv.buffer = this._makeImpulse(1.8, 3.0);
      const wet = ctx.createGain(); wet.gain.value = 0.18;
      const dry = ctx.createGain(); dry.gain.value = 1.0;

      const master = ctx.createGain();
      master.gain.value = 0.3;

      this.busInput.connect(body1);
      body1.connect(body2); body2.connect(warmth); warmth.connect(tone); tone.connect(comp);
      comp.connect(dry); dry.connect(master);
      comp.connect(conv); conv.connect(wet); wet.connect(master);
      master.connect(ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  // 간단한 감쇠 노이즈로 작은 룸 임펄스 응답을 만든다.
  _makeImpulse(seconds = 1.8, decay = 3.0) {
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(seconds * sr));
    const imp = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = imp.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return imp;
  }

  _karplusBuffer(freq) {
    const key = Math.round(freq);
    if (this.bufferCache.has(key)) return this.bufferCache.get(key);
    const sr = this.ctx.sampleRate;
    const total = Math.floor(this.duration * sr);
    const buf = this.ctx.createBuffer(1, total, sr);
    const data = buf.getChannelData(0);
    const n = Math.max(2, Math.round(sr / freq));

    // 픽 부드러움: 화이트노이즈를 1극 저역통과로 완화한 여기.
    const ks = new Float32Array(n);
    let lp = 0;
    const soft = 0.45; // 0=거침, 1=매우 부드러움
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      lp = soft * lp + (1 - soft) * white;
      ks[i] = lp;
    }
    // DC 제거(평균 0)로 둔탁한 저역 처짐 방지.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += ks[i];
    mean /= n;
    for (let i = 0; i < n; i++) ks[i] -= mean;

    // 주파수별 감쇠: 저음은 길게, 고음은 짧게 울린다.
    const decay = Math.max(0.992, 0.9975 - freq * 5e-6);

    let idx = 0;
    for (let i = 0; i < total; i++) {
      const cur = ks[idx];
      const nxt = ks[(idx + 1) % n];
      ks[idx] = decay * 0.5 * (cur + nxt);
      data[i] = cur;
      idx = (idx + 1) % n;
    }
    this.bufferCache.set(key, buf);
    return buf;
  }

  strum(chord, direction) {
    if (!chord || chord.freqs.length === 0) return;
    let freqs = [...chord.freqs].sort((a, b) => a - b); // 저→고
    if (direction === "up") freqs.reverse();
    const now = this.ctx.currentTime;
    const n = freqs.length;
    freqs.forEach((f, i) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this._karplusBuffer(f);
      src.detune.value = (Math.random() * 2 - 1) * 6; // ±6센트 미세 디튠

      const g = this.ctx.createGain();
      g.gain.value = 0.85 + Math.random() * 0.3;       // 피킹 세기 변화

      src.connect(g);
      if (this.ctx.createStereoPanner) {
        const pan = this.ctx.createStereoPanner();
        pan.pan.value = (i / Math.max(1, n - 1) - 0.5) * 0.5; // 현마다 좌우 퍼짐
        g.connect(pan); pan.connect(this.busInput);
      } else {
        g.connect(this.busInput);
      }
      src.start(now + i * this.spread);
    });
  }
}

// --- DOM --------------------------------------------------------------------
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx2d = canvas.getContext("2d");
const elChord = document.getElementById("chord");
const elCount = document.getElementById("count");
const elVy = document.getElementById("vy");
const elStrum = document.getElementById("strum");
const elEngine = document.getElementById("engine");
const startScreen = document.getElementById("start-screen");
const startBtn = document.getElementById("start-btn");
const statusEl = document.getElementById("status");
const legendEl = document.getElementById("legend");
const settingsBtn = document.getElementById("settings-btn");
const configBtn = document.getElementById("config-btn");
const settingsPanel = document.getElementById("settings");
const settingsRows = document.getElementById("settings-rows");
const settingsSave = document.getElementById("settings-save");
const settingsReset = document.getElementById("settings-reset");
const sensRange = document.getElementById("sens-range");
const sensVal = document.getElementById("sens-val");

// --- 코드 설정 UI (손가락별 코드 선택) -------------------------------------
const CHORD_NAMES = Object.keys(CHORD_LIBRARY); // MUTE 포함

// 시작 화면 범례를 현재 매핑으로 다시 그린다.
function renderLegend() {
  if (!legendEl) return;
  const labels = ["0개(손 펴기)", "1개", "2개", "3개"];
  legendEl.innerHTML = "";
  for (let i = 0; i <= 3; i++) {
    const li = document.createElement("li");
    li.innerHTML = `<b>${labels[i]}</b> → ${mapping[i]}`;
    legendEl.appendChild(li);
  }
}

// 설정 패널의 드롭다운들을 현재 매핑으로 채운다.
function buildSettingsUI() {
  settingsRows.innerHTML = "";
  for (let i = 0; i <= 3; i++) {
    const row = document.createElement("label");
    row.className = "settings-row";
    const span = document.createElement("span");
    span.textContent = `${i}개`;
    const sel = document.createElement("select");
    sel.dataset.count = String(i);
    for (const name of CHORD_NAMES) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === mapping[i]) opt.selected = true;
      sel.appendChild(opt);
    }
    row.append(span, sel);
    settingsRows.appendChild(row);
  }
}

// 감도 슬라이더를 현재 임계값으로 맞춘다.
function syncSensUI() {
  if (!sensRange) return;
  sensRange.value = String(strumThreshold);
  sensVal.textContent = `임계값 ${strumThreshold.toFixed(2)}`;
}

function openSettings() {
  buildSettingsUI();
  syncSensUI();
  settingsPanel.classList.remove("hidden");
}
function closeSettings() {
  settingsPanel.classList.add("hidden");
}

settingsBtn?.addEventListener("click", openSettings);
configBtn?.addEventListener("click", openSettings);

// 슬라이더는 즉시 반영(저장)되어 연주 중에도 바로 체감된다.
sensRange?.addEventListener("input", () => {
  strumThreshold = parseFloat(sensRange.value);
  strummer.threshold = strumThreshold;
  try { localStorage.setItem(SENS_KEY, String(strumThreshold)); } catch {}
  sensVal.textContent = `임계값 ${strumThreshold.toFixed(2)}`;
});

settingsSave?.addEventListener("click", () => {
  for (const sel of settingsRows.querySelectorAll("select")) {
    mapping[sel.dataset.count] = sel.value;
  }
  try { localStorage.setItem(MAP_KEY, JSON.stringify(mapping)); } catch {}
  CHORDS = buildChordsFromMapping(mapping);
  renderLegend();
  closeSettings();
});

settingsReset?.addEventListener("click", () => {
  mapping = { ...DEFAULT_MAPPING };
  strumThreshold = DEFAULT_THRESHOLD;
  strummer.threshold = strumThreshold;
  try { localStorage.setItem(SENS_KEY, String(strumThreshold)); } catch {}
  buildSettingsUI();
  syncSensUI();
});

renderLegend();

// 스트럼 감도(임계값)도 저장한다. 값이 작을수록 더 민감(쉽게 발동).
const SENS_KEY = "airguitar.strumThreshold";
const DEFAULT_THRESHOLD = 0.7;
function loadThreshold() {
  const v = parseFloat(localStorage.getItem(SENS_KEY));
  return Number.isFinite(v) ? v : DEFAULT_THRESHOLD;
}
let strumThreshold = loadThreshold();

const stabilizer = new FingerStabilizer(5);
const wristV = new WristVelocity(0.6); // 평활 완화 → 빠른 동작 피크 보존
// 임계값 낮춤 + 1프레임 확정 → 한 번 휘둘러도 잘 잡힘.
// 에지 트리거라 한 스트로크당 한 번만 발사(속도가 임계 아래로 떨어져야 재무장).
const strummer = new StrumDetector(strumThreshold, 1, 0.12);
const audio = new AudioEngine();

let handLandmarker = null;
let lastTime = null;
let lastStrum = "-";

// 짧은 인식 공백(모션 블러 등)을 메우는 유예. 이 시간 안에 손이 다시
// 잡히면 직전 코드/속도 상태를 이어가 깜빡임·끊김을 줄인다.
const HOLD_S = 0.2;
let lastHandT = null; // 마지막으로 손을 본 시각(초)
let lastCount = null; // 직전 안정화된 손가락 수
let lastChord = null; // 직전 코드

// 손 추적 엔진 상태(진단/자동 폴백용).
let HandLandmarkerClass = null; // 동적 import 한 클래스 보관
let vision = null;             // FilesetResolver 결과 보관
let delegateInUse = "-";       // "GPU" | "CPU"
let everDetected = false;      // 손이 한 번이라도 잡혔는지
let detectStart = null;        // 첫 추론 시각(초)
let cpuFallbackTried = false;  // GPU→CPU 자동 전환 1회 제한

// HandLandmarker 생성. 임계값을 낮춰 더 너그럽게 잡는다.
async function makeLandmarker(delegate) {
  return HandLandmarkerClass.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
}

// GPU에서 손이 영영 안 잡히는 기기를 위해 CPU로 한 번 갈아끼운다.
async function swapToCpu() {
  cpuFallbackTried = true;
  try {
    const cpu = await makeLandmarker("CPU");
    handLandmarker?.close?.();
    handLandmarker = cpu;
    delegateInUse = "CPU";
    everDetected = false;
    detectStart = null;
    console.info("GPU에서 손 미검출 → CPU 델리게이트로 전환");
  } catch (e) {
    console.error("CPU 폴백 실패:", e);
  }
}

async function init() {
  statusEl.textContent = "라이브러리 로딩 중…";
  const { HandLandmarker, FilesetResolver } = await import(VISION);
  HandLandmarkerClass = HandLandmarker;

  statusEl.textContent = "모델 로딩 중…";
  vision = await FilesetResolver.forVisionTasks(WASM);
  // GPU 우선, 생성 실패 시 CPU로.
  try {
    handLandmarker = await makeLandmarker("GPU");
    delegateInUse = "GPU";
  } catch (e) {
    console.warn("GPU 델리게이트 생성 실패 → CPU:", e);
    handLandmarker = await makeLandmarker("CPU");
    delegateInUse = "CPU";
    cpuFallbackTried = true;
  }

  statusEl.textContent = "카메라 여는 중…";
  // 높은 프레임레이트 요청 → 노출이 짧아져 모션 블러가 줄고,
  // 프레임 간 손 이동량이 작아져 추적 손실이 덜하다.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 60 },
    },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  // 일부 기기에서 play 직후 videoWidth가 0일 수 있어 메타데이터를 기다린다.
  if (!video.videoWidth) {
    await new Promise((res) => {
      video.addEventListener("loadeddata", res, { once: true });
    });
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", resizeCanvas);

  audio.resume();
  startScreen.classList.add("hidden");
  requestAnimationFrame(loop);
}

// 캔버스 비트맵을 화면에 보이는 크기(× DPR)로 맞춘다.
// 이렇게 하면 비디오/오버레이를 같은 좌표계에 직접 그릴 수 있어
// object-fit 같은 표시 스케일에 의존하지 않아 항상 정렬이 맞는다.
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
}

// 비디오 프레임 → 캔버스 'cover' 변환(가운데 정렬, 넘치는 부분 잘림).
let view = { ox: 0, oy: 0, dw: 1, dh: 1, cw: 1, ch: 1 };
function updateView() {
  const cw = canvas.width, ch = canvas.height;
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  view = { ox: (cw - dw) / 2, oy: (ch - dh) / 2, dw, dh, cw, ch };
}

function loop(tMs) {
  const t = tMs / 1000;
  const dt = lastTime === null ? 0 : t - lastTime;
  lastTime = t;

  // 비디오/오버레이가 공유할 cover 변환 갱신 후, 거울 모드로 비디오 그리기.
  updateView();
  ctx2d.clearRect(0, 0, view.cw, view.ch);
  ctx2d.save();
  ctx2d.translate(view.cw, 0);
  ctx2d.scale(-1, 1);
  ctx2d.drawImage(video, view.ox, view.oy, view.dw, view.dh);
  ctx2d.restore();

  let chord = null, count = null, vY = 0, handFound = false;

  if (handLandmarker) {
    if (detectStart === null) detectStart = t;
    const res = handLandmarker.detectForVideo(video, tMs);
    if (res.landmarks && res.landmarks.length > 0) {
      handFound = true;
      everDetected = true;
      const lm = res.landmarks[0];
      count = stabilizer.update(countBent(lm));
      chord = CHORDS[count] ?? null;
      // 공백을 건너뛴 경우, 마지막으로 본 시점부터의 실제 경과시간으로
      // 속도를 계산(블러 중 일어난 스트럼도 재포착 때 살아난다). HOLD_S로 상한.
      const vdt = lastHandT === null ? dt : Math.min(t - lastHandT, HOLD_S);
      vY = wristV.update(lm, vdt);
      const dir = strummer.update(vY, vdt);
      // 다운스트로크에서만 소리. 업은 인식만 하고 음 없음.
      if (dir && chord) {
        lastStrum = dir;
        if (dir === "down") audio.strum(chord, dir);
      }
      drawHand(lm, chord);
      lastHandT = t; lastCount = count; lastChord = chord;
    } else {
      const sinceHand = lastHandT === null ? Infinity : t - lastHandT;
      if (sinceHand < HOLD_S) {
        // 유예 중: 직전 코드 유지(깜빡임 방지). 속도/스트럼 상태는 보존만 한다.
        handFound = true;
        count = lastCount;
        chord = lastChord;
      } else {
        stabilizer.reset(); wristV.reset(); strummer.reset();
        lastHandT = null; lastCount = null; lastChord = null;
      }
    }

    // GPU로 ~2.5초간 손을 한 번도 못 잡으면 CPU로 자동 전환.
    if (!everDetected && !cpuFallbackTried && delegateInUse === "GPU" &&
        detectStart !== null && t - detectStart > 2.5) {
      swapToCpu();
    }
  }

  elChord.textContent = chord ? chord.name : "-";
  elCount.textContent = `손가락: ${count ?? "-"}`;

  // 팔(손목) 움직임: 방향 + 속도. v_y>0 = 아래로, v_y<0 = 위로(이미지 y는 아래로 증가).
  const speed = Math.abs(vY);
  const DEAD = 0.15; // 이 속도 미만은 정지로 본다
  let moveDir = "– 정지", moveColor = "#94a3b8";
  if (vY > DEAD) { moveDir = "↓ 아래"; moveColor = "#4ade80"; }
  else if (vY < -DEAD) { moveDir = "↑ 위"; moveColor = "#38bdf8"; }
  elVy.textContent = `움직임: ${moveDir} · 속도 ${speed.toFixed(2)}`;
  elVy.style.color = moveColor;

  const strumLabel =
    lastStrum === "down" ? "↓ 다운" : lastStrum === "up" ? "↑ 업" : "-";
  elStrum.textContent = `스트럼: ${strumLabel}`;
  // 진단: 엔진(GPU/CPU)과 손 인식 여부. 손이 안 잡히면 안내 문구.
  elEngine.textContent = handFound
    ? `엔진: ${delegateInUse} ✓`
    : `엔진: ${delegateInUse} · 손바닥을 화면 안에 펴서 보여주세요`;

  requestAnimationFrame(loop);
}

// MediaPipe 손 21점 연결(뼈대). [시작, 끝] 인덱스 쌍.
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],        // 엄지
  [0, 5], [5, 6], [6, 7], [7, 8],        // 검지
  [5, 9], [9, 10], [10, 11], [11, 12],   // 중지
  [9, 13], [13, 14], [14, 15], [15, 16], // 약지
  [13, 17], [17, 18], [18, 19], [19, 20],// 새끼
  [0, 17],                               // 손바닥 아래
];

// 인식한 손을 카메라 위에 띄운다: 박스(프레임) + 뼈대 선 + 관절 점 + 코드 라벨.
// 비디오와 똑같은 cover 변환(view)을 써서 위치·크기가 항상 정확히 맞는다.
function drawHand(lm, chord) {
  // 정규화 좌표 → 캔버스 픽셀(비디오와 동일 변환).
  const X = (px) => view.ox + px * view.dw;
  const Y = (py) => view.oy + py * view.dh;

  // 화면 크기에 비례한 시각 두께.
  const r = Math.max(3, view.ch * 0.006);
  const lw = Math.max(2, view.ch * 0.004);

  // 손 전체를 감싸는 박스 좌표(정규화) 계산.
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const pad = 0.04;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(1, maxX + pad); maxY = Math.min(1, maxY + pad);

  // 비디오와 동일한 거울 변환으로 그린다.
  ctx2d.save();
  ctx2d.translate(view.cw, 0);
  ctx2d.scale(-1, 1);

  // 뼈대 선
  ctx2d.strokeStyle = "rgba(74, 222, 128, 0.9)";
  ctx2d.lineWidth = lw;
  ctx2d.lineCap = "round";
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx2d.beginPath();
    ctx2d.moveTo(X(lm[a].x), Y(lm[a].y));
    ctx2d.lineTo(X(lm[b].x), Y(lm[b].y));
    ctx2d.stroke();
  }

  // 관절 점
  ctx2d.fillStyle = "#4ade80";
  for (const p of lm) {
    ctx2d.beginPath();
    ctx2d.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2);
    ctx2d.fill();
  }

  // 인식 박스(프레임)
  ctx2d.strokeStyle = "#22d3ee";
  ctx2d.lineWidth = lw;
  ctx2d.strokeRect(X(minX), Y(minY), (maxX - minX) * view.dw, (maxY - minY) * view.dh);
  ctx2d.restore();

  // 코드 라벨은 거울 좌표라 글자가 뒤집히므로 정상 좌표계에서 다시 그린다.
  // 거울 화면에서 X(maxX)는 화면 왼쪽(cw - X) 위치에 보인다.
  const boxLeftOnScreen = view.cw - X(maxX);
  const boxTopOnScreen = Y(minY);
  const fs = Math.max(16, view.ch * 0.022);
  const label = chord ? chord.name : "?";
  ctx2d.save();
  ctx2d.font = `bold ${Math.round(fs)}px -apple-system, system-ui, sans-serif`;
  const tw = ctx2d.measureText(label).width;
  const bh = fs * 1.25;
  ctx2d.fillStyle = "#22d3ee";
  ctx2d.fillRect(boxLeftOnScreen, Math.max(0, boxTopOnScreen - bh), tw + 16, bh);
  ctx2d.fillStyle = "#06222b";
  ctx2d.textBaseline = "middle";
  ctx2d.fillText(label, boxLeftOnScreen + 8, Math.max(bh / 2, boxTopOnScreen - bh / 2));
  ctx2d.restore();
}

startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  init().catch((err) => {
    startBtn.disabled = false;
    statusEl.textContent = "오류: " + (err.message || err);
    console.error(err);
  });
});
