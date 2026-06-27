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

// --- 코드 라이브러리 (이름 → 음이름) ---------------------------------------
// 손가락별로 자유롭게 고를 수 있도록 흔한 코드를 모아둔다.
export const CHORD_LIBRARY = {
  C:  ["C3","E3","G3","C4","E4"],
  D:  ["D3","A3","D4","F#4","A4"],
  E:  ["E2","B2","E3","G#3","B3"],
  F:  ["F2","A2","C3","F3","A3"],
  G:  ["G2","B2","D3","G3","B3"],
  A:  ["A2","E3","A3","C#4","E4"],
  B:  ["B2","F#3","B3","D#4","F#4"],
  Am: ["A2","E3","A3","C4","E4"],
  Bm: ["B2","F#3","B3","D4","F#4"],
  Cm: ["C3","G3","C4","D#4","G4"],
  Dm: ["D3","A3","D4","F4","A4"],
  Em: ["E2","B2","E3","G3","B3"],
  Fm: ["F2","C3","F3","G#3","C4"],
  Gm: ["G2","D3","G3","A#3","D4"],
  MUTE: [],
};

// 코드 이름 하나로 { name, notes, freqs } 객체를 만든다.
export function chordFromName(name) {
  const notes = CHORD_LIBRARY[name] ?? [];
  return { name, notes, freqs: notes.map(noteToFreq) };
}

// 손가락 개수(0~3) → 코드 이름 기본 매핑.
export const DEFAULT_MAPPING = { 0: "C", 1: "G", 2: "Am", 3: "F" };

// 매핑 { 0:"C", 1:"G", ... }으로 count→코드 객체를 만든다. 4개는 항상 MUTE.
export function buildChordsFromMapping(mapping = DEFAULT_MAPPING) {
  const out = {};
  for (let i = 0; i <= 3; i++) {
    out[i] = chordFromName(mapping?.[i] ?? DEFAULT_MAPPING[i]);
  }
  out[4] = chordFromName("MUTE");
  return out;
}

// --- 코드 프리셋 (기본 매핑) -----------------------------------------------
export function buildChords() {
  return buildChordsFromMapping(DEFAULT_MAPPING);
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

// --- 스트럼 감지 상태머신 (에지/슈미트 트리거) -----------------------------
// 한 스트로크 = 소리 한 번. 임계값을 넘으면 1회 발사한 뒤 "무장 해제"되고,
// 속도가 릴리스 임계값(= threshold*releaseFactor) 아래로 다시 떨어져야
// 재무장한다. 방향을 바꿀 때는 속도가 0을 지나며 자연히 재무장된다.
export class StrumDetector {
  constructor(threshold = 0.7, confirmFrames = 1, cooldownS = 0.12, releaseFactor = 0.6) {
    this.threshold = threshold;
    this.confirmFrames = confirmFrames;
    this.cooldownS = cooldownS;
    this.releaseFactor = releaseFactor;
    this.streakDir = null;
    this.streakN = 0;
    this.cooldownLeft = 0;
    this.armed = true; // 발사 가능 상태
  }
  update(vY, dt) {
    if (this.cooldownLeft > 0) this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    const speed = Math.abs(vY);
    const release = this.threshold * this.releaseFactor;

    // 속도가 릴리스 아래로 떨어지면 다음 스트로크를 위해 재무장.
    if (speed < release) {
      this.armed = true;
      this.streakDir = null;
      this.streakN = 0;
      return null;
    }
    // 릴리스~임계 사이: 상태 유지만(발사·재무장 없음).
    if (speed < this.threshold) return null;

    const cur = vY > 0 ? "down" : "up";
    if (cur === this.streakDir) this.streakN++;
    else { this.streakDir = cur; this.streakN = 1; }

    if (!this.armed || this.cooldownLeft > 0) return null;
    if (this.streakN >= this.confirmFrames) {
      this.armed = false;          // 이 스트로크에서는 더 안 울림
      this.cooldownLeft = this.cooldownS;
      return cur;
    }
    return null;
  }
  reset() {
    this.streakDir = null;
    this.streakN = 0;
    this.cooldownLeft = 0;
    this.armed = true;
  }
}
