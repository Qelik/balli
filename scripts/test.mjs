/*
 * Tests for the two things the game actually stands on: the bag never repeats,
 * and one tilt fires exactly one action. Everything else is a timer and a font.
 * Run with `npm test` (node --test, no framework).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Environment stubs, installed before importing the compiled modules ──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
};

let fakeNow = 0;
Object.defineProperty(globalThis, "performance", {
  configurable: true,
  value: { now: () => fakeNow },
});

// A hand-pumped requestAnimationFrame so the round clock runs on controlled time.
let pendingFrames = [];
let rafId = 0;
globalThis.requestAnimationFrame = (fn) => {
  pendingFrames.push(fn);
  return ++rafId;
};
globalThis.cancelAnimationFrame = () => {
  pendingFrames = [];
};
function pump(ms, stepMs = 16) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    fakeNow += stepMs;
    const due = pendingFrames;
    pendingFrames = [];
    for (const fn of due) fn();
  }
}

const listeners = new Map();
globalThis.window = {
  addEventListener: (type, fn) => void listeners.set(type, fn),
  removeEventListener: (type) => void listeners.delete(type),
  setTimeout: () => 0,
  clearTimeout: () => {},
};
globalThis.DeviceMotionEvent = class {};

const root = resolve(import.meta.dirname, "..");
const { draw, loadBag, saveBag, seenCount } = await import(`${root}/js/bag.js`);
const { TiltReader, DEFAULT_TILT_CONFIG } = await import(`${root}/js/tilt.js`);

const realDeck = JSON.parse(readFileSync(`${root}/decks/films-2000s.json`, "utf8"));

function deckOf(n, version = "v1") {
  return {
    id: "test",
    name: "Test",
    lang: "en",
    source: "test",
    version,
    cards: Array.from({ length: n }, (_, i) => ({ t: `card-${i}` })),
  };
}

// ── Bag ────────────────────────────────────────────────────────────

test("deals every card exactly once before repeating any", () => {
  store.clear();
  const deck = deckOf(40);
  const bag = loadBag(deck);
  const dealt = [];
  for (let i = 0; i < deck.cards.length; i++) dealt.push(draw(bag, deck).t);
  assert.equal(new Set(dealt).size, 40, "a card repeated inside one pass");
  assert.equal(seenCount(bag), 40);
});

test("reshuffles only on exhaustion, and the new pass is a new order", () => {
  store.clear();
  const deck = deckOf(40);
  const bag = loadBag(deck);
  const first = [];
  for (let i = 0; i < 40; i++) first.push(draw(bag, deck).t);
  const second = [];
  for (let i = 0; i < 40; i++) second.push(draw(bag, deck).t);
  assert.equal(new Set(second).size, 40);
  assert.notDeepEqual(first, second, "second pass came out in the same order");
});

test("the cursor survives a reload mid-pass", () => {
  store.clear();
  const deck = deckOf(40);
  const bag = loadBag(deck);
  const dealt = [];
  for (let i = 0; i < 12; i++) dealt.push(draw(bag, deck).t);
  saveBag(bag);

  const reloaded = loadBag(deck);
  assert.equal(seenCount(reloaded), 12);
  const rest = [];
  for (let i = 0; i < 28; i++) rest.push(draw(reloaded, deck).t);
  assert.equal(new Set([...dealt, ...rest]).size, 40, "a reload reintroduced a seen card");
});

test("a new deck version keeps the seen set and only deals unseen cards", () => {
  store.clear();
  const v1 = deckOf(40, "v1");
  const bag = loadBag(v1);
  const seenTexts = [];
  for (let i = 0; i < 30; i++) seenTexts.push(draw(bag, v1).t);
  saveBag(bag);

  const v2 = { ...deckOf(50, "v2"), version: "2026-09-01" };
  const migrated = loadBag(v2);
  assert.equal(seenCount(migrated), 30, "the seen set was reset by the update");

  const next = [];
  for (let i = 0; i < 20; i++) next.push(draw(migrated, v2).t);
  for (const text of next) {
    assert.ok(!seenTexts.includes(text), `${text} came back after an update`);
  }
  assert.equal(new Set(next).size, 20);
});

test("a shrinking deck can still reach exhaustion", () => {
  store.clear();
  const v1 = deckOf(40, "v1");
  const bag = loadBag(v1);
  for (let i = 0; i < 40; i++) draw(bag, v1);
  saveBag(bag);

  // v2 drops half the catalogue; the stale seen entries must not block a reshuffle.
  const v2 = deckOf(20, "v2");
  const migrated = loadBag(v2);
  const dealt = [];
  for (let i = 0; i < 20; i++) dealt.push(draw(migrated, v2).t);
  assert.equal(new Set(dealt).size, 20);
});

test("the shipped deck deals its full length without a repeat", () => {
  store.clear();
  const bag = loadBag(realDeck);
  const dealt = [];
  for (let i = 0; i < realDeck.cards.length; i++) dealt.push(draw(bag, realDeck).t);
  assert.equal(new Set(dealt).size, realDeck.cards.length);
});

// ── Tilt state machine ─────────────────────────────────────────────

function harness() {
  const fired = [];
  const reader = new TiltReader({
    config: DEFAULT_TILT_CONFIG,
    onAction: (action) => fired.push(action),
  });
  reader.setCalibration({ restDeg: 0, sign: 1 });
  reader.start();
  reader.resume();
  const handler = listeners.get("devicemotion");

  /** Hold the phone at `deg` for `ms`, sampling at 60Hz. */
  const hold = (deg, ms) => {
    const g = 9.80665;
    const rad = (deg * Math.PI) / 180;
    for (let elapsed = 0; elapsed < ms; elapsed += 16) {
      fakeNow += 16;
      handler({ accelerationIncludingGravity: { x: 0, y: g * Math.cos(rad), z: g * Math.sin(rad) } });
    }
  };
  return { fired, hold, reader };
}

test("one tilt down fires CORRECT exactly once, however long it is held", () => {
  fakeNow = 0;
  const { fired, hold } = harness();
  hold(0, 500); // settle at rest
  hold(70, 1500); // tilt down and hold there
  assert.deepEqual(fired, ["CORRECT"]);
});

test("overshooting on the way back does not fire the opposite action", () => {
  fakeNow = 0;
  const { fired, hold } = harness();
  hold(0, 500);
  hold(70, 400); // score
  hold(-70, 48); // the arm whips back past the forehead and overshoots
  hold(0, 400); // and settles at the forehead
  // This is the bug the lockout plus dwell exists to kill: one gesture, one action.
  assert.deepEqual(fired, ["CORRECT"]);
});

test("a deliberate hold past the up threshold still fires PASS", () => {
  fakeNow = 0;
  const { fired, hold } = harness();
  hold(0, 500);
  hold(70, 400);
  hold(-70, 400); // held there on purpose, not an overshoot
  assert.deepEqual(fired, ["CORRECT", "PASS"]);
});

test("returning through neutral re-arms, so the next tilt fires", () => {
  fakeNow = 0;
  const { fired, hold } = harness();
  hold(0, 500);
  hold(70, 400);
  hold(0, 400); // back to the forehead
  hold(-70, 400); // pass
  hold(0, 400);
  hold(70, 400); // another hit
  assert.deepEqual(fired, ["CORRECT", "PASS", "CORRECT"]);
});

test("a flick past the threshold shorter than the dwell does not fire", () => {
  fakeNow = 0;
  const { fired, hold } = harness();
  hold(0, 500);
  hold(70, 48); // ~3 samples: past the line, nowhere near 120ms of dwell
  hold(0, 400);
  assert.deepEqual(fired, []);
});

test("hand shake is rejected: samples far off 1g are ignored", () => {
  fakeNow = 0;
  const { fired, reader } = harness();
  const handler = listeners.get("devicemotion");
  for (let i = 0; i < 120; i++) {
    fakeNow += 16;
    // 3g straight down the screen normal — a shove, not an orientation.
    handler({ accelerationIncludingGravity: { x: 0, y: 0, z: 29.4 } });
  }
  assert.deepEqual(fired, []);
  assert.equal(reader.pitch(), null, "a rejected sample still updated the filter");
});

test("a negative calibration sign flips which way scores", () => {
  fakeNow = 0;
  const fired = [];
  const reader = new TiltReader({ config: DEFAULT_TILT_CONFIG, onAction: (a) => fired.push(a) });
  reader.setCalibration({ restDeg: 0, sign: -1 });
  reader.start();
  reader.resume();
  const handler = listeners.get("devicemotion");
  const hold = (deg, ms) => {
    const g = 9.80665;
    const rad = (deg * Math.PI) / 180;
    for (let e = 0; e < ms; e += 16) {
      fakeNow += 16;
      handler({ accelerationIncludingGravity: { x: 0, y: g * Math.cos(rad), z: g * Math.sin(rad) } });
    }
  };
  hold(0, 500);
  hold(70, 600);
  assert.deepEqual(fired, ["PASS"]);
});

test("a holder who rests the phone at an angle still gets a neutral band", () => {
  fakeNow = 0;
  const fired = [];
  const reader = new TiltReader({ config: DEFAULT_TILT_CONFIG, onAction: (a) => fired.push(a) });
  reader.setCalibration({ restDeg: 30, sign: 1 }); // held 30 degrees forward at rest
  reader.start();
  reader.resume();
  const handler = listeners.get("devicemotion");
  const hold = (deg, ms) => {
    const g = 9.80665;
    const rad = (deg * Math.PI) / 180;
    for (let e = 0; e < ms; e += 16) {
      fakeNow += 16;
      handler({ accelerationIncludingGravity: { x: 0, y: g * Math.cos(rad), z: g * Math.sin(rad) } });
    }
  };
  hold(30, 800); // their rest position must not fire
  assert.deepEqual(fired, []);
  hold(80, 600); // 50 degrees past their rest: fires
  assert.deepEqual(fired, ["CORRECT"]);
});

// ── Calibration driven through the reader ──────────────────────────

const { Calibrator } = await import(`${root}/js/calibrate.js`);

/**
 * Drives the real TiltReader and the real Calibrator together at a given sample
 * rate, on a device whose gravity sign is inverted the way iOS Safari's is.
 */
function calibrationRun(hz) {
  const stepMs = 1000 / hz;
  const phases = [];
  let learned = null;
  const reader = new TiltReader({
    config: DEFAULT_TILT_CONFIG,
    onSample: (pitchDeg) => calibrator.feed(pitchDeg),
    onAction: (a) => fired.push(a),
  });
  const fired = [];
  const calibrator = new Calibrator({
    config: DEFAULT_TILT_CONFIG,
    onPhase: (phase) => {
      if (phases[phases.length - 1] !== phase) phases.push(phase);
    },
    onDone: (c) => {
      learned = c;
    },
  });
  reader.start();
  calibrator.begin();

  const hold = (deg, ms) => {
    const g = 9.80665;
    const rad = (deg * Math.PI) / 180;
    const handler = listeners.get("devicemotion");
    for (let e = 0; e < ms; e += stepMs) {
      fakeNow += stepMs;
      handler({ accelerationIncludingGravity: { x: 0, y: g * Math.cos(rad), z: g * Math.sin(rad) } });
    }
  };
  return { phases, hold, fired, reader, done: () => learned };
}

test("calibration learns an inverted sign and the round then scores the right way", () => {
  fakeNow = 0;
  const run = calibrationRun(60);
  run.hold(0, 900); // held against the forehead
  assert.equal(run.done(), null, "rest alone should not finish calibration");
  run.hold(-70, 400); // the tilt-down demo, on an inverted-sign device
  run.hold(0, 500); // back up
  const calibration = run.done();
  assert.ok(calibration, "calibration never completed");
  assert.equal(calibration.sign, -1, "the inverted sign was not learned");
  assert.ok(Math.abs(calibration.restDeg) < 2);
  assert.deepEqual(run.phases, ["rest", "learn", "recenter", "done"]);

  // Same physical gesture, now inside a live round: it has to score, not pass.
  run.reader.setCalibration(calibration);
  run.reader.resume();
  run.hold(0, 300);
  run.hold(-70, 400);
  assert.deepEqual(run.fired, ["CORRECT"]);
});

test("calibration completes on a slow sensor without falling back to the timeout", () => {
  fakeNow = 0;
  const run = calibrationRun(12); // a lethargic 12Hz sensor
  const before = fakeNow;
  run.hold(0, 900);
  run.hold(-70, 900); // a real person's tilt-down demo takes about a second
  run.hold(0, 700);
  assert.ok(run.done(), "calibration did not complete at 12Hz");
  // The 6s rest timeout is the safety net, not the happy path.
  assert.ok(fakeNow - before < 3000, `took ${fakeNow - before}ms, so it timed out`);
});

test("a holder who cannot keep still still gets through calibration", () => {
  fakeNow = 0;
  const run = calibrationRun(60);
  // Wobbling well past the steadiness threshold for longer than the timeout.
  for (let i = 0; i < 40; i++) run.hold(i % 2 === 0 ? -20 : 20, 200);
  run.hold(70, 400);
  run.hold(0, 500);
  const calibration = run.done();
  assert.ok(calibration, "the rest timeout did not release the holder");
  assert.equal(calibration.sign, 1);
});

// ── Round clock and the per-correct bonus ──────────────────────────

const { RoundTimer } = await import(`${root}/js/timer.js`);

function clock(seconds) {
  const timer = new RoundTimer();
  const ticks = [];
  let ended = 0;
  timer.start(
    seconds,
    (remainingMs, whole) => ticks.push({ remainingMs, whole, fraction: remainingMs / timer.spanMs }),
    () => ended++,
  );
  return { timer, ticks, ended: () => ended, last: () => ticks[ticks.length - 1] };
}

test("a correct answer puts a second back on the clock", () => {
  fakeNow = 0;
  const c = clock(30);
  pump(3000);
  const before = c.last().remainingMs;
  c.timer.addTime(1000);
  pump(16);
  const after = c.last().remainingMs;
  assert.ok(after - before > 900, `expected about +1s, got ${Math.round(after - before)}ms`);
});

test("the progress bar never overflows its track, however much time is added", () => {
  fakeNow = 0;
  const c = clock(30);
  // A very good round: twenty cards, each adding a second.
  for (let i = 0; i < 20; i++) {
    pump(500);
    c.timer.addTime(1000);
  }
  pump(2000);
  for (const tick of c.ticks) {
    assert.ok(tick.fraction <= 1.0001, `bar hit ${tick.fraction.toFixed(3)} of its track`);
    assert.ok(tick.fraction >= 0);
  }
});

test("bonus time genuinely lengthens the round", () => {
  fakeNow = 0;
  const plain = clock(10);
  pump(11000);
  const plainEnd = fakeNow;

  fakeNow = 0;
  const extended = clock(10);
  for (let i = 0; i < 5; i++) {
    pump(1000);
    extended.timer.addTime(1000);
  }
  pump(11000);
  assert.equal(extended.ended(), 1);
  assert.ok(fakeNow > plainEnd, "the extended round did not outlast the plain one");
});

test("time added after the clock runs out is ignored", () => {
  fakeNow = 0;
  const c = clock(5);
  pump(6000);
  assert.equal(c.ended(), 1);
  c.timer.addTime(5000);
  pump(2000);
  assert.equal(c.ended(), 1, "a late bonus resurrected a finished round");
  assert.equal(c.last().remainingMs, 0);
});

test("the clock crosses each whole second exactly once", () => {
  fakeNow = 0;
  const c = clock(5);
  pump(5200);
  const crossings = new Map();
  let previous = null;
  for (const tick of c.ticks) {
    if (tick.whole !== previous) crossings.set(tick.whole, (crossings.get(tick.whole) ?? 0) + 1);
    previous = tick.whole;
  }
  for (const [whole, count] of crossings) {
    assert.equal(count, 1, `second ${whole} was announced ${count} times`);
  }
});

test("a bag whose order has outrun the deck still deals", () => {
  store.clear();
  const deck = deckOf(20);
  const bag = loadBag(deck);
  // Every remaining entry points past the end of the deck — what a truncated
  // or mismatched deck would leave behind.
  bag.order = [99, 98, 97];
  bag.cursor = 0;
  bag.seen = [];
  const card = draw(bag, deck);
  assert.ok(card, "draw gave up instead of reshuffling past the stale entries");
  assert.ok(deck.cards.some((c) => c.t === card.t));
});

test("draw returns null for an empty deck instead of spinning", () => {
  store.clear();
  const empty = deckOf(0);
  const bag = loadBag(empty);
  assert.equal(draw(bag, empty), null);
});
