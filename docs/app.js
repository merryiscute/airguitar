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

// --- 오디오: Karplus-Strong 플럭 ------------------------------------------
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.duration = 1.6;
    this.decay = 0.9965;
    this.spread = 0.025; // 스트럼 음 간격(초)
    this.bufferCache = new Map();
  }
  resume() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.25;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  _karplusBuffer(freq) {
    const key = Math.round(freq);
    if (this.bufferCache.has(key)) return this.bufferCache.get(key);
    const sr = this.ctx.sampleRate;
    const total = Math.floor(this.duration * sr);
    const buf = this.ctx.createBuffer(1, total, sr);
    const data = buf.getChannelData(0);
    const n = Math.max(2, Math.round(sr / freq));
    const ks = new Float32Array(n);
    for (let i = 0; i < n; i++) ks[i] = Math.random() * 2 - 1;
    let idx = 0;
    for (let i = 0; i < total; i++) {
      const cur = ks[idx];
      const nxt = ks[(idx + 1) % n];
      ks[idx] = this.decay * 0.5 * (cur + nxt);
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
    freqs.forEach((f, i) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this._karplusBuffer(f);
      src.connect(this.master);
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
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: 640, height: 480 },
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
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  audio.resume();
  startScreen.classList.add("hidden");
  requestAnimationFrame(loop);
}

function loop(tMs) {
  const t = tMs / 1000;
  const dt = lastTime === null ? 0 : t - lastTime;
  lastTime = t;

  // 거울 모드로 비디오 그리기
  ctx2d.save();
  ctx2d.scale(-1, 1);
  ctx2d.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
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
      vY = wristV.update(lm, dt);
      const dir = strummer.update(vY, dt);
      if (dir && chord) { audio.strum(chord, dir); lastStrum = dir; }
      drawHand(lm, chord);
    } else {
      stabilizer.reset(); wristV.reset(); strummer.reset();
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
function drawHand(lm, chord) {
  const W = canvas.width, H = canvas.height;

  // 손 전체를 감싸는 박스 좌표(정규화) 계산.
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const pad = 0.04;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(1, maxX + pad); maxY = Math.min(1, maxY + pad);

  // 거울 좌표계(화면에 보이는 위치)로 그린다.
  ctx2d.save();
  ctx2d.scale(-1, 1);
  ctx2d.translate(-W, 0);

  // 뼈대 선
  ctx2d.strokeStyle = "rgba(74, 222, 128, 0.9)";
  ctx2d.lineWidth = 3;
  ctx2d.lineCap = "round";
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx2d.beginPath();
    ctx2d.moveTo(lm[a].x * W, lm[a].y * H);
    ctx2d.lineTo(lm[b].x * W, lm[b].y * H);
    ctx2d.stroke();
  }

  // 관절 점
  ctx2d.fillStyle = "#4ade80";
  for (const p of lm) {
    ctx2d.beginPath();
    ctx2d.arc(p.x * W, p.y * H, 5, 0, Math.PI * 2);
    ctx2d.fill();
  }

  // 인식 박스(프레임)
  ctx2d.strokeStyle = "#22d3ee";
  ctx2d.lineWidth = 3;
  ctx2d.strokeRect(minX * W, minY * H, (maxX - minX) * W, (maxY - minY) * H);
  ctx2d.restore();

  // 코드 라벨은 거울 좌표라 글자가 뒤집히므로, 정상 좌표계에서 다시 그린다.
  // 거울 화면에서 정규화 x는 (1 - x) 위치에 보인다.
  const boxLeftOnScreen = (1 - maxX) * W;
  const boxTopOnScreen = minY * H;
  const label = chord ? chord.name : "?";
  ctx2d.save();
  ctx2d.font = "bold 28px -apple-system, system-ui, sans-serif";
  const tw = ctx2d.measureText(label).width;
  ctx2d.fillStyle = "#22d3ee";
  ctx2d.fillRect(boxLeftOnScreen, Math.max(0, boxTopOnScreen - 34), tw + 16, 34);
  ctx2d.fillStyle = "#06222b";
  ctx2d.textBaseline = "middle";
  ctx2d.fillText(label, boxLeftOnScreen + 8, Math.max(17, boxTopOnScreen - 17));
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
