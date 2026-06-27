// 웹 로직(docs/logic.js) 검증 — 브라우저/카메라 없이 Node 단독 실행.
// 파이썬 src 테스트와 동일한 시나리오 7개를 확인한다.
//   node tests/web_logic.test.mjs
//
// 의존성 없음(순수 Node + assert). 종료 코드 0 = 전부 통과.

import assert from "node:assert/strict";
import {
  noteToFreq,
  buildChords,
  countBent,
  dist,
  FingerStabilizer,
  WristVelocity,
  StrumDetector,
  WRIST,
} from "../docs/logic.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

// 손 랜드마크(21개) 만들기 헬퍼. 각 (mcp,tip)을 손목 기준 거리로 배치한다.
// fingers: [{ bent: bool }, ...] 검지/중지/약지/새끼 순.
function makeHand(fingers, wristY = 0.5) {
  const lm = new Array(21).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  lm[WRIST] = { x: 0.5, y: wristY };
  const groups = [
    [5, 6, 8],    // MCP, PIP, TIP
    [9, 10, 12],
    [13, 14, 16],
    [17, 18, 20],
  ];
  groups.forEach(([mcp, pip, tip], i) => {
    const bent = fingers[i]?.bent;
    // PIP는 손목에서 중간 거리에 고정. 폄: tip이 PIP보다 멀다.
    // 굽힘: tip이 손목 가까이 접혀 PIP보다 가까워진다.
    lm[mcp] = { x: 0.5, y: wristY - 0.15 };
    lm[pip] = { x: 0.5, y: wristY - 0.25 };
    lm[tip] = { x: 0.5, y: bent ? wristY - 0.10 : wristY - 0.40 };
  });
  return lm;
}

// 1) 음이름 → 주파수: A4 = 440Hz, 한 옥타브 위는 2배.
test("noteToFreq: A4=440, 옥타브=2배", () => {
  assert.ok(Math.abs(noteToFreq("A4") - 440) < 1e-6);
  assert.ok(Math.abs(noteToFreq("A5") - 880) < 1e-6);
  assert.ok(Math.abs(noteToFreq("C4") - 261.6256) < 1e-3);
});

// 2) 코드 프리셋: 0=C(5음), 4=MUTE(0음), freqs 채워짐.
test("buildChords: C는 5음, MUTE는 0음, freqs 생성", () => {
  const chords = buildChords();
  assert.equal(chords[0].name, "C");
  assert.equal(chords[0].notes.length, 5);
  assert.equal(chords[0].freqs.length, 5);
  assert.equal(chords[4].name, "MUTE");
  assert.equal(chords[4].freqs.length, 0);
});

// 3) dist & countBent: 다 펴면 0, 다 굽히면 4.
test("countBent: 편 손=0, 다 굽힌 손=4", () => {
  assert.ok(Math.abs(dist({ x: 0, y: 0 }, { x: 3, y: 4 }) - 5) < 1e-9);
  const open = makeHand([{ bent: false }, { bent: false }, { bent: false }, { bent: false }]);
  const fist = makeHand([{ bent: true }, { bent: true }, { bent: true }, { bent: true }]);
  assert.equal(countBent(open), 0);
  assert.equal(countBent(fist), 4);
});

// 4) FingerStabilizer: 다수결로 흔들림을 흡수.
test("FingerStabilizer: 다수결 안정화", () => {
  const s = new FingerStabilizer(5);
  s.update(2);
  s.update(2);
  const stable = s.update(2);
  assert.equal(stable, 2);
  // 한 프레임 튀어도 다수결(2)은 유지된다.
  assert.equal(s.update(0), 2);
  s.reset();
  assert.equal(s.stable, null);
});

// 5) WristVelocity: 손목이 아래로 가면 v_y > 0(이미지 y는 아래로 증가).
test("WristVelocity: 부호와 EMA", () => {
  const v = new WristVelocity(0.5);
  v.update(makeHand([], 0.40), 0); // 첫 프레임은 0
  const down = v.update(makeHand([], 0.60), 0.1); // y 증가 → 양수
  assert.ok(down > 0);
  v.reset();
  assert.equal(v.vY, 0);
});

// 6) StrumDetector: 임계 넘고 confirmFrames 채우면 방향 반환, 쿨다운 동작.
test("StrumDetector: 확정 프레임 후 감지 + 쿨다운", () => {
  const d = new StrumDetector(1.2, 2, 0.5);
  assert.equal(d.update(2.0, 0.05), null); // 1프레임: 아직
  assert.equal(d.update(2.0, 0.05), "down"); // 2프레임: 확정
  // 쿨다운 중에는 즉시 재발화 안 함.
  assert.equal(d.update(2.0, 0.05), null);
  assert.equal(d.update(2.0, 0.05), null);
});

// 7) 통합 파이프라인: 굽힘→코드, 손목 스윙→스트럼이 한 번 발생.
test("통합: 코드 선택 + 다운 스트럼 1회", () => {
  const chords = buildChords();
  const stab = new FingerStabilizer(3);
  const vel = new WristVelocity(0.6);
  const strum = new StrumDetector(1.2, 2, 0.2);

  // 손가락 1개 굽힘 → G 코드.
  const hand = (y) => {
    const h = makeHand([{ bent: true }, { bent: false }, { bent: false }, { bent: false }], y);
    return h;
  };
  let count = null;
  for (let i = 0; i < 3; i++) count = stab.update(countBent(hand(0.5)));
  assert.equal(count, 1);
  assert.equal(chords[count].name, "G");

  // 손목을 빠르게 아래로 → 다운 스트럼 확정.
  vel.update(hand(0.30), 0);
  let fired = null;
  const ys = [0.45, 0.60, 0.75];
  for (const y of ys) {
    const vy = vel.update(hand(y), 0.05);
    const dir = strum.update(vy, 0.05);
    if (dir) fired = dir;
  }
  assert.equal(fired, "down");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
