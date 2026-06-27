// 순수 로직(브라우저 의존성 없음) — 파이썬 src/features,chords,strum 포팅.
// 브라우저(app.js)와 Node 테스트(tests/web_logic.test.mjs) 양쪽에서 import 한다.

// --- 랜드마크 인덱스 (검지~새끼: MCP, PIP, TIP) ----------------------------
export const WRIST = 0;
export const FINGERS = [
  [5, 6, 8],    // index:  MCP, PIP, TIP
  [9, 10, 12],  // middle
  [13, 14, 16], // ring
  [17, 18, 20], // pinky
];

// --- 음이름 → 주파수 --------------------------------------------------------
const NOTE_SEMITONES = { C:0,"C#":1,DB:1,D:2,"D#":3,EB:3,E:4,F:5,"F#":6,GB:6,G:7,"G#":8,AB:8,A:9,"A#":10,BB:10,B:11 };
export function noteToFreq(note) {
  const m = note.toUpperCase().match(/^([A-G][#B]?)(-?\d+)$/);
  if (!m) throw new Error("잘못된 음이름: " + note);
  const semis = NOTE_SEMITONES[m[1]];
  const midi = (parseInt(m[2], 10) + 1) * 12 + semis;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// --- 코드 프리셋 (presets.json과 동일) -------------------------------------
export function buildChords() {
  const raw = {
    0: { name: "C",  notes: ["C3","E3","G3","C4","E4"] },
    1: { name: "G",  notes: ["G2","B2","D3","G3","B3"] },
    2: { name: "Am", notes: ["A2","E3","A3","C4","E4"] },
    3: { name: "F",  notes: ["F2","A2","C3","F3","A3"] },
    4: { name: "MUTE", notes: [] },
  };
  for (const c of Object.values(raw)) c.freqs = c.notes.map(noteToFreq);
  return raw;
}

// --- 특징: 손가락 굽힘 ------------------------------------------------------
export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
export function countBent(lm) {
  const wrist = lm[WRIST];
  let n = 0;
  // 폄: 손끝(TIP)이 가운데 관절(PIP)보다 손목에서 더 멀다.
  // 굽힘: 손끝이 손바닥 쪽으로 접혀 PIP보다 손목에 가까워진다.
  // (MCP가 아니라 PIP 기준이라 손 기울기에 덜 민감하다.)
  for (const [, pip, tip] of FINGERS) {
    if (dist(lm[tip], wrist) < dist(lm[pip], wrist)) n++;
  }
  return n;
}

// --- 히스테리시스(다수결 N프레임) ------------------------------------------
export class FingerStabilizer {
  constructor(window = 5, minAgree = null) {
    this.window = window;
    this.minAgree = minAgree ?? Math.floor(window / 2) + 1;
    this.history = [];
    this.stable = null;
  }
  update(count) {
    this.history.push(count);
    if (this.history.length > this.window) this.history.shift();
    const tally = new Map();
    for (const v of this.history) tally.set(v, (tally.get(v) || 0) + 1);
    let best = null, bestN = 0;
    for (const [v, n] of tally) if (n > bestN) { best = v; bestN = n; }
    if (bestN >= this.minAgree) this.stable = best;
    return this.stable;
  }
  reset() { this.history = []; this.stable = null; }
}

// --- 손목 수직 속도(EMA) ----------------------------------------------------
export class WristVelocity {
  constructor(alpha = 0.5) { this.alpha = alpha; this.prevY = null; this.vY = 0; }
  update(lm, dt) {
    const y = lm[WRIST].y;
    if (this.prevY === null || dt <= 0) { this.prevY = y; return this.vY; }
    const raw = (y - this.prevY) / dt;
    this.vY = this.alpha * raw + (1 - this.alpha) * this.vY;
    this.prevY = y;
    return this.vY;
  }
  reset() { this.prevY = null; this.vY = 0; }
}

// --- 스트럼 감지 상태머신 ---------------------------------------------------
export class StrumDetector {
  constructor(threshold = 1.2, confirmFrames = 2, cooldownS = 0.08) {
    this.threshold = threshold;
    this.confirmFrames = confirmFrames;
    this.cooldownS = cooldownS;
    this.streakDir = null;
    this.streakN = 0;
    this.cooldownLeft = 0;
  }
  update(vY, dt) {
    if (this.cooldownLeft > 0) this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    let cur = null;
    if (vY > this.threshold) cur = "down";
    else if (vY < -this.threshold) cur = "up";
    if (cur === null) { this.streakDir = null; this.streakN = 0; return null; }
    if (cur === this.streakDir) this.streakN++;
    else { this.streakDir = cur; this.streakN = 1; }
    if (this.cooldownLeft > 0) return null;
    if (this.streakN >= this.confirmFrames) {
      this.cooldownLeft = this.cooldownS;
      this.streakN = 0;
      return cur;
    }
    return null;
  }
  reset() { this.streakDir = null; this.streakN = 0; this.cooldownLeft = 0; }
}
