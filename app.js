// 에어 기타 (오른손) — 웹 버전
// MediaPipe Tasks Vision(HandLandmarker) + Web Audio.
// 순수 로직은 logic.js, 여기서는 카메라/추론/오디오/렌더만 담당한다.

import {
  buildChords,
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

const CHORDS = buildChords();

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
const startScreen = document.getElementById("start-screen");
const startBtn = document.getElementById("start-btn");
const statusEl = document.getElementById("status");

const stabilizer = new FingerStabilizer(5);
const wristV = new WristVelocity(0.5);
const strummer = new StrumDetector(1.2, 2, 0.08);
const audio = new AudioEngine();

let handLandmarker = null;
let lastTime = null;
let lastStrum = "-";

async function init() {
  statusEl.textContent = "라이브러리 로딩 중…";
  const { HandLandmarker, FilesetResolver } = await import(VISION);

  statusEl.textContent = "모델 로딩 중…";
  const vision = await FilesetResolver.forVisionTasks(WASM);
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 1,
  });

  statusEl.textContent = "카메라 여는 중…";
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: 640, height: 480 },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

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

  let chord = null, count = null, vY = 0;

  if (handLandmarker) {
    const res = handLandmarker.detectForVideo(video, tMs);
    if (res.landmarks && res.landmarks.length > 0) {
      const lm = res.landmarks[0];
      count = stabilizer.update(countBent(lm));
      chord = CHORDS[count] ?? null;
      vY = wristV.update(lm, dt);
      const dir = strummer.update(vY, dt);
      if (dir && chord) { audio.strum(chord, dir); lastStrum = dir; }
      drawHand(lm);
    } else {
      stabilizer.reset(); wristV.reset(); strummer.reset();
    }
  }

  elChord.textContent = chord ? chord.name : "-";
  elCount.textContent = `손가락: ${count ?? "-"}`;
  elVy.textContent = `v_y: ${vY.toFixed(2)}`;
  elStrum.textContent = `스트럼: ${lastStrum}`;

  requestAnimationFrame(loop);
}

function drawHand(lm) {
  ctx2d.save();
  ctx2d.scale(-1, 1);
  ctx2d.translate(-canvas.width, 0);
  ctx2d.fillStyle = "#4ade80";
  for (const p of lm) {
    ctx2d.beginPath();
    ctx2d.arc(p.x * canvas.width, p.y * canvas.height, 5, 0, Math.PI * 2);
    ctx2d.fill();
  }
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
