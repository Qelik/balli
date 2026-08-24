/**
 * Audio and haptics. The player holding the phone cannot see the screen, so
 * these are not decoration — they are the only channel that reaches them.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let soundEnabled = true;

type AudioContextCtor = typeof AudioContext;

function audioCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Must run inside the same user gesture that starts the round. iOS creates the
 * context suspended, and a suspended context makes the entire round silent with
 * no error anywhere.
 */
export async function unlockAudio(): Promise<boolean> {
  const Ctor = audioCtor();
  if (!Ctor) return false;
  try {
    if (!ctx) {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") await ctx.resume();
    // A zero-length silent buffer is what actually flips older WebKit awake.
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    return ctx.state === "running";
  } catch {
    return false;
  }
}

export function setSoundEnabled(on: boolean): void {
  soundEnabled = on;
}

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

/** navigator.vibrate is absent on iOS Safari — there is no web haptic there. */
export function hapticsAvailable(): boolean {
  return typeof navigator.vibrate === "function";
}

function vibrate(pattern: number | number[]): void {
  if (!hapticsAvailable()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* some browsers throw when the page is not visible */
  }
}

interface ToneSpec {
  freq: number;
  /** Seconds from the start of the cue. */
  at: number;
  /** Seconds. */
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

function play(tones: readonly ToneSpec[]): void {
  if (!soundEnabled || !ctx || !master || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = tone.type ?? "sine";
    osc.frequency.setValueAtTime(tone.freq, now + tone.at);
    // Ramped envelope: a raw start/stop on a gain node clicks audibly.
    const peak = tone.gain ?? 1;
    env.gain.setValueAtTime(0.0001, now + tone.at);
    env.gain.exponentialRampToValueAtTime(peak, now + tone.at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.dur);
    osc.connect(env);
    env.connect(master);
    osc.start(now + tone.at);
    osc.stop(now + tone.at + tone.dur + 0.02);
  }
}

export function cueCorrect(): void {
  play([
    { freq: 659.25, at: 0, dur: 0.09 },
    { freq: 987.77, at: 0.075, dur: 0.16 },
  ]);
  vibrate([28, 40, 28]);
}

export function cuePass(): void {
  play([{ freq: 392, at: 0, dur: 0.07, type: "triangle" }, { freq: 233.08, at: 0.06, dur: 0.16, type: "triangle" }]);
  vibrate(90);
}

/** One per second over the final five. */
export function cueTick(): void {
  play([{ freq: 880, at: 0, dur: 0.05, type: "square", gain: 0.5 }]);
  vibrate(18);
}

export function cueStart(): void {
  play([{ freq: 523.25, at: 0, dur: 0.12 }, { freq: 1046.5, at: 0.1, dur: 0.22 }]);
  vibrate([20, 60, 20]);
}

export function cueCountdown(): void {
  play([{ freq: 587.33, at: 0, dur: 0.08, gain: 0.6 }]);
  vibrate(15);
}

export function cueTimeUp(): void {
  play([
    { freq: 440, at: 0, dur: 0.2, type: "sawtooth", gain: 0.7 },
    { freq: 349.23, at: 0.18, dur: 0.2, type: "sawtooth", gain: 0.7 },
    { freq: 261.63, at: 0.36, dur: 0.45, type: "sawtooth", gain: 0.7 },
  ]);
  vibrate([200, 90, 200, 90, 380]);
}
