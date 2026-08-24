import type { Calibration, TiltConfig } from "./tilt.js";

export type CalibPhase = "rest" | "learn" | "recenter" | "done";

export interface CalibratorOptions {
  config: TiltConfig;
  /** A previously learned sign. Supplied means the "tilt down" demo is skipped. */
  knownSign?: 1 | -1;
  onPhase: (phase: CalibPhase, progress: number) => void;
  onDone: (calibration: Calibration) => void;
}

const REST_WINDOW_MS = 700;
const REST_SPREAD_DEG = 8;
/*
 * Steadiness is judged on the time the window covers, not on a sample count:
 * devicemotion runs at 60Hz on a current handset but far slower on older or
 * throttled ones, and a count-based rule silently degrades into "wait for the
 * timeout" there.
 */
const REST_MIN_SPAN_MS = 500;
const REST_MIN_SAMPLES = 5;
/** Give up on holding still after this long and take what we have. */
const REST_TIMEOUT_MS = 6000;
const LEARN_DEG = 35;
const LEARN_DWELL_MS = 120;

/**
 * Works out where "rest" is for this holder, and which way the gravity vector
 * moves when they tilt down.
 *
 * The sign has to be learned rather than assumed: iOS Safari reports
 * accelerationIncludingGravity inverted relative to Chrome, and no amount of
 * reasoning about the spec survives contact with a real handset. One "tilt
 * down" demo settles it, and it is remembered afterwards.
 */
export class Calibrator {
  private readonly options: CalibratorOptions;
  private phase: CalibPhase = "rest";
  private startedAt = 0;
  private window: Array<{ t: number; pitch: number }> = [];
  private restDeg = 0;
  private sign: 1 | -1 = 1;
  private learnArmedAt: number | null = null;
  private learnDirection = 0;

  constructor(options: CalibratorOptions) {
    this.options = options;
  }

  begin(): void {
    this.phase = "rest";
    this.startedAt = performance.now();
    this.window = [];
    this.learnArmedAt = null;
    this.learnDirection = 0;
    this.options.onPhase("rest", 0);
  }

  get currentPhase(): CalibPhase {
    return this.phase;
  }

  /** Feed every accepted sensor sample. */
  feed(pitchDeg: number): void {
    const now = performance.now();
    switch (this.phase) {
      case "rest":
        this.feedRest(pitchDeg, now);
        return;
      case "learn":
        this.feedLearn(pitchDeg, now);
        return;
      case "recenter":
        this.feedRecenter(pitchDeg);
        return;
      case "done":
        return;
    }
  }

  private feedRest(pitchDeg: number, now: number): void {
    this.window.push({ t: now, pitch: pitchDeg });
    const cutoff = now - REST_WINDOW_MS;
    while (this.window.length > 0 && (this.window[0] as { t: number }).t < cutoff) {
      this.window.shift();
    }

    const pitches = this.window.map((s) => s.pitch);
    const spread = pitches.length > 0 ? Math.max(...pitches) - Math.min(...pitches) : Infinity;
    const span = now - (this.window[0]?.t ?? now);
    const held = Math.min(1, span / REST_MIN_SPAN_MS);
    this.options.onPhase("rest", spread <= REST_SPREAD_DEG ? held : 0);

    const steady =
      pitches.length >= REST_MIN_SAMPLES &&
      span >= REST_MIN_SPAN_MS &&
      spread <= REST_SPREAD_DEG;
    const timedOut = now - this.startedAt > REST_TIMEOUT_MS && pitches.length > 0;
    if (!steady && !timedOut) return;

    this.restDeg = pitches.reduce((a, b) => a + b, 0) / pitches.length;

    const known = this.options.knownSign;
    if (known) {
      this.sign = known;
      this.finish();
      return;
    }
    this.phase = "learn";
    this.options.onPhase("learn", 0);
  }

  private feedLearn(pitchDeg: number, now: number): void {
    const delta = pitchDeg - this.restDeg;
    const magnitude = Math.abs(delta);
    this.options.onPhase("learn", Math.min(1, magnitude / LEARN_DEG));

    if (magnitude < LEARN_DEG) {
      this.learnArmedAt = null;
      this.learnDirection = 0;
      return;
    }
    const direction = delta > 0 ? 1 : -1;
    if (this.learnArmedAt === null || this.learnDirection !== direction) {
      this.learnArmedAt = now;
      this.learnDirection = direction;
      return;
    }
    if (now - this.learnArmedAt < LEARN_DWELL_MS) return;

    // The demonstrated direction is "down", and down must read as CORRECT.
    this.sign = direction === 1 ? 1 : -1;
    this.phase = "recenter";
    this.options.onPhase("recenter", 0);
  }

  private feedRecenter(pitchDeg: number): void {
    const relative = (pitchDeg - this.restDeg) * this.sign;
    const magnitude = Math.abs(relative);
    this.options.onPhase("recenter", Math.max(0, 1 - magnitude / 90));
    if (magnitude <= this.options.config.neutralDeg) this.finish();
  }

  private finish(): void {
    this.phase = "done";
    this.options.onPhase("done", 1);
    this.options.onDone({ restDeg: this.restDeg, sign: this.sign });
  }
}
