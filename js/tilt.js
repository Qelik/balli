import { read, write } from "./storage.js";
export const DEFAULT_TILT_CONFIG = {
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
export function motionApiAvailable() {
    return typeof globalThis.DeviceMotionEvent !== "undefined";
}
/**
 * Must be called from a genuine user gesture, over HTTPS, or iOS rejects it.
 * Wire it to the Start button, not to page load.
 */
export async function requestMotionPermission() {
    if (!motionApiAvailable())
        return "unsupported";
    const ctor = DeviceMotionEvent;
    if (typeof ctor.requestPermission !== "function")
        return "granted"; // non-iOS: no gate
    try {
        const result = await ctor.requestPermission();
        return result === "granted" ? "granted" : "denied";
    }
    catch {
        return "denied";
    }
}
export function loadCalibration() {
    const stored = read(CALIB_KEY);
    if (!stored)
        return null;
    if (typeof stored.restDeg !== "number" || !Number.isFinite(stored.restDeg))
        return null;
    if (stored.sign !== 1 && stored.sign !== -1)
        return null;
    return { restDeg: stored.restDeg, sign: stored.sign };
}
export function saveCalibration(c) {
    write(CALIB_KEY, c);
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
    config;
    onAction;
    onSample;
    onUnavailable;
    smoothed = null;
    state = "NEUTRAL";
    armedAction = null;
    armedAt = 0;
    calibration = { restDeg: 0, sign: 1 };
    paused = true;
    listening = false;
    samples = 0;
    probeTimer = null;
    handler = (event) => this.onMotion(event);
    constructor(options = {}) {
        this.config = options.config ?? DEFAULT_TILT_CONFIG;
        this.onAction = options.onAction;
        this.onSample = options.onSample;
        this.onUnavailable = options.onUnavailable;
    }
    setCalibration(c) {
        this.calibration = c;
    }
    getCalibration() {
        return this.calibration;
    }
    /** Attach the sensor listener. Actions stay suppressed until resume(). */
    start() {
        if (this.listening || !motionApiAvailable()) {
            if (!motionApiAvailable())
                this.onUnavailable?.();
            return;
        }
        this.listening = true;
        this.samples = 0;
        window.addEventListener("devicemotion", this.handler);
        // Desktop browsers and permission-less contexts fire nothing, or fire events
        // whose accelerationIncludingGravity is null. Either way: no sensor.
        this.probeTimer = window.setTimeout(() => {
            if (this.samples === 0)
                this.onUnavailable?.();
        }, 1200);
    }
    stop() {
        if (!this.listening)
            return;
        this.listening = false;
        window.removeEventListener("devicemotion", this.handler);
        if (this.probeTimer !== null) {
            clearTimeout(this.probeTimer);
            this.probeTimer = null;
        }
    }
    /** Suppress actions but keep sampling — used during the countdown. */
    pause() {
        this.paused = true;
    }
    /** Arm actions. Starts locked out so a tilt held from before cannot fire. */
    resume() {
        this.paused = false;
        this.state = "FIRED";
        this.armedAction = null;
    }
    /** Current smoothed pitch in degrees, or null before the first sample. */
    pitch() {
        if (!this.smoothed)
            return null;
        return pitchOf(this.smoothed);
    }
    relative(pitchDeg) {
        return (pitchDeg - this.calibration.restDeg) * this.calibration.sign;
    }
    onMotion(event) {
        const raw = event.accelerationIncludingGravity;
        if (!raw)
            return;
        const x = raw.x ?? 0;
        const y = raw.y ?? 0;
        const z = raw.z ?? 0;
        const mag = Math.hypot(x, y, z);
        // Reject shake and free-fall: those samples describe the hand, not the tilt.
        if (mag < MIN_MAG || mag > MAX_MAG)
            return;
        this.samples += 1;
        const nx = x / mag;
        const ny = y / mag;
        const nz = z / mag;
        if (!this.smoothed) {
            this.smoothed = { x: nx, y: ny, z: nz };
        }
        else {
            const s = this.smoothed;
            s.x += (nx - s.x) * EMA_ALPHA;
            s.y += (ny - s.y) * EMA_ALPHA;
            s.z += (nz - s.z) * EMA_ALPHA;
        }
        const pitchDeg = pitchOf(this.smoothed);
        const rel = this.relative(pitchDeg);
        this.onSample?.(pitchDeg, rel);
        if (this.paused)
            return;
        this.step(rel, performance.now());
    }
    step(rel, now) {
        const { neutralDeg, fireDeg, dwellMs } = this.config;
        if (this.state === "FIRED") {
            if (Math.abs(rel) <= neutralDeg)
                this.state = "NEUTRAL";
            return;
        }
        const direction = rel >= fireDeg ? "CORRECT" : rel <= -fireDeg ? "PASS" : null;
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
function pitchOf(v) {
    const clamped = Math.min(1, Math.max(-1, v.z));
    return (Math.asin(clamped) * 180) / Math.PI;
}
//# sourceMappingURL=tilt.js.map