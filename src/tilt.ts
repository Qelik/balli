import { read, write } from "./storage.js";

export type TiltAction = "CORRECT" | "PASS";

export type MotionPermission = "granted" | "denied" | "unsupported";

/** Persisted per device/holder so the game works for people who hold it at an angle. */
export interface Calibration {
  /** Pitch, in degrees, of the phone at rest against the forehead. */
  restDeg: number;
  /**
   * +1 or -1. Maps "tilt down" onto positive relative pitch.
   *
   * Not a constant: iOS Safari reports `accelerationIncludingGravity` with the
   * opposite sign to Chrome/Android, and the phone can be held landscape-left
   * or landscape-right. Learning it once beats hardcoding a guess.
   */
  sign: 1 | -1;
}

export interface TiltConfig {
  /** Half-width of the neutral band, degrees from rest. */
  neutralDeg: number;
  /** Deviation from rest that arms an action, degrees. */
  fireDeg: number;
  /** Time the phone must stay past the threshold before firing, ms. */
  dwellMs: number;
}

export const DEFAULT_TILT_CONFIG: TiltConfig = {
  neutralDeg: 25,
  fireDeg: 45,
  dwellMs: 120,
};

const CALIB_KEY = "tilt:calib";
/** Gravity magnitude, m/s^2. Samples far from this are hand-shake, not orientation. */
const G = 9.80665;
const MIN_MAG = G * 0.65;
const MAX_MAG = G * 1.35;
/** Exponential moving average weight for the new sample. Low = smooth, laggy. */
const EMA_ALPHA = 0.25;

type PermissionRequester = {
  requestPermission?: () => Promise<"granted" | "denied" | "prompt" | "default">;
};

export function motionApiAvailable(): boolean {
  return typeof globalThis.DeviceMotionEvent !== "undefined";
}

/**
 * Must be called from a genuine user gesture, over HTTPS, or iOS rejects it.
 * Wire it to the Start button, not to page load.
 */
export async function requestMotionPermission(): Promise<MotionPermission> {
  if (!motionApiAvailable()) return "unsupported";
  const ctor = DeviceMotionEvent as unknown as PermissionRequester;
  if (typeof ctor.requestPermission !== "function") return "granted"; // non-iOS: no gate
  try {
    const result = await ctor.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export function loadCalibration(): Calibration | null {
  const stored = read<Partial<Calibration>>(CALIB_KEY);
  if (!stored) return null;
  if (typeof stored.restDeg !== "number" || !Number.isFinite(stored.restDeg)) return null;
  if (stored.sign !== 1 && stored.sign !== -1) return null;
  return { restDeg: stored.restDeg, sign: stored.sign };
}

export function saveCalibration(c: Calibration): void {
  write(CALIB_KEY, c);
}

type State = "NEUTRAL" | "ARMED" | "FIRED";

export interface TiltReaderOptions {
  config?: TiltConfig;
  /** Fired when the state machine commits to an action. */
  onAction?: (action: TiltAction) => void;
  /** Every accepted sample. Drives the calibration meter. */
  onSample?: (pitchDeg: number, relativeDeg: number) => void;
  /** No usable sensor data arrived. Caller should fall back to tap controls. */
  onUnavailable?: () => void;
}

/**
 * Reads the gravity vector and turns it into CORRECT / PASS.
 *
 * The state machine is the whole reason this file exists:
 *
 *   NEUTRAL --(past threshold)--> ARMED --(held dwellMs)--> FIRED
 *   FIRED --(back inside the neutral band)--> NEUTRAL
 *
 * Without the FIRED lockout, one tilt fires repeatedly on the way out and the
 * swing back through the opposite threshold fires the opposite action.
 */
export class TiltReader {
  private readonly config: TiltConfig;
  private readonly onAction: ((action: TiltAction) => void) | undefined;
  private readonly onSample: ((pitchDeg: number, relativeDeg: number) => void) | undefined;
  private readonly onUnavailable: (() => void) | undefined;

  private smoothed: { x: number; y: number; z: number } | null = null;
  private state: State = "NEUTRAL";
  private armedAction: TiltAction | null = null;
  private armedAt = 0;

  private calibration: Calibration = { restDeg: 0, sign: 1 };
  private paused = true;
  private listening = false;
  private samples = 0;
  private probeTimer: number | null = null;

  private readonly handler = (event: DeviceMotionEvent): void => this.onMotion(event);

  constructor(options: TiltReaderOptions = {}) {
    this.config = options.config ?? DEFAULT_TILT_CONFIG;
    this.onAction = options.onAction;
    this.onSample = options.onSample;
    this.onUnavailable = options.onUnavailable;
  }

  setCalibration(c: Calibration): void {
    this.calibration = c;
  }

  getCalibration(): Calibration {
    return this.calibration;
  }

  /** Attach the sensor listener. Actions stay suppressed until resume(). */
  start(): void {
    if (this.listening || !motionApiAvailable()) {
      if (!motionApiAvailable()) this.onUnavailable?.();
      return;
    }
    this.listening = true;
    this.samples = 0;
    window.addEventListener("devicemotion", this.handler);
    // Desktop browsers and permission-less contexts fire nothing, or fire events
    // whose accelerationIncludingGravity is null. Either way: no sensor.
    this.probeTimer = window.setTimeout(() => {
      if (this.samples === 0) this.onUnavailable?.();
    }, 1200);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("devicemotion", this.handler);
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /** Suppress actions but keep sampling — used during the countdown. */
  pause(): void {
    this.paused = true;
  }

  /** Arm actions. Starts locked out so a tilt held from before cannot fire. */
  resume(): void {
    this.paused = false;
    this.state = "FIRED";
    this.armedAction = null;
  }

  /** Current smoothed pitch in degrees, or null before the first sample. */
  pitch(): number | null {
    if (!this.smoothed) return null;
    return pitchOf(this.smoothed);
  }

  private relative(pitchDeg: number): number {
    return (pitchDeg - this.calibration.restDeg) * this.calibration.sign;
  }

  private onMotion(event: DeviceMotionEvent): void {
    const raw = event.accelerationIncludingGravity;
    if (!raw) return;
    const x = raw.x ?? 0;
    const y = raw.y ?? 0;
    const z = raw.z ?? 0;
    const mag = Math.hypot(x, y, z);
    // Reject shake and free-fall: those samples describe the hand, not the tilt.
    if (mag < MIN_MAG || mag > MAX_MAG) return;

    this.samples += 1;
    const nx = x / mag;
    const ny = y / mag;
    const nz = z / mag;

    if (!this.smoothed) {
      this.smoothed = { x: nx, y: ny, z: nz };
    } else {
      const s = this.smoothed;
      s.x += (nx - s.x) * EMA_ALPHA;
      s.y += (ny - s.y) * EMA_ALPHA;
      s.z += (nz - s.z) * EMA_ALPHA;
    }

    const pitchDeg = pitchOf(this.smoothed);
    const rel = this.relative(pitchDeg);
    this.onSample?.(pitchDeg, rel);
    if (this.paused) return;
    this.step(rel, performance.now());
  }

  private step(rel: number, now: number): void {
    const { neutralDeg, fireDeg, dwellMs } = this.config;

    if (this.state === "FIRED") {
      if (Math.abs(rel) <= neutralDeg) this.state = "NEUTRAL";
      return;
    }

    const direction: TiltAction | null =
      rel >= fireDeg ? "CORRECT" : rel <= -fireDeg ? "PASS" : null;

    if (direction === null) {
      this.state = "NEUTRAL";
      this.armedAction = null;
      return;
    }

    if (this.state !== "ARMED" || this.armedAction !== direction) {
      this.state = "ARMED";
      this.armedAction = direction;
      this.armedAt = now;
      return;
    }

    if (now - this.armedAt >= dwellMs) {
      this.state = "FIRED";
      this.armedAction = null;
      this.onAction?.(direction);
    }
  }
}

/**
 * Pitch from the gravity vector, using only the screen-normal component.
 *
 * z is the device axis pointing out of the screen. Held vertically against a
 * forehead the screen faces the room, so gravity has no z component and pitch
 * is ~0. Tip the screen towards the floor and |z| grows. Using z alone makes
 * the reading identical in landscape-left and landscape-right, which matters
 * because nobody checks which way up they grab the phone.
 */
function pitchOf(v: { x: number; y: number; z: number }): number {
  const clamped = Math.min(1, Math.max(-1, v.z));
  return (Math.asin(clamped) * 180) / Math.PI;
}
