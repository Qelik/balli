import {
  clearBag,
  draw,
  loadBag,
  peekSeenCount,
  resetBag,
  saveBag,
  type BagState,
} from "./bag.js";
import { Calibrator, type CalibPhase } from "./calibrate.js";
import {
  groupDecks,
  languageName,
  loadDeck,
  loadIndex,
  type DeckIndex,
  type DeckSummary,
} from "./decks.js";
import {
  cueCorrect,
  cueCountdown,
  cuePass,
  cueStart,
  cueTick,
  cueTimeUp,
  hapticsAvailable,
  setSoundEnabled,
  unlockAudio,
} from "./feedback.js";
import { fitText } from "./fit.js";
import { read, write } from "./storage.js";
import { RoundTimer } from "./timer.js";
import {
  DEFAULT_TILT_CONFIG,
  TiltReader,
  loadCalibration,
  requestMotionPermission,
  saveCalibration,
  type Calibration,
  type TiltAction,
} from "./tilt.js";
import type { Card, Deck, Outcome, RoundEntry } from "./types.js";
import { acquireWakeLock, releaseWakeLock } from "./wake.js";

const SETTINGS_KEY = "settings";
const RECENT_KEY = "recent";
const FLASH_MS = 420;
const COUNTDOWN_FROM = 3;
/** Time put back on the clock for every card the room gets. */
const BONUS_MS = 1000;
const RECENT_MAX = 6;

interface Settings {
  seconds: number;
  sound: boolean;
  deckId: string;
}

const DEFAULT_SETTINGS: Settings = { seconds: 60, sound: true, deckId: "" };

type ScreenName = "home" | "preround" | "round" | "recap";

// ── DOM helpers ─────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

const screens: Record<ScreenName, HTMLElement> = {
  home: el("screen-home"),
  preround: el("screen-preround"),
  round: el("screen-round"),
  recap: el("screen-recap"),
};

const dom = {
  deckCount: el("deck-count"),
  deckGrid: el("deck-grid"),
  resetDeck: el<HTMLButtonElement>("reset-deck"),
  lengthGroup: el("length-group"),
  soundToggle: el<HTMLInputElement>("sound-toggle"),
  startButton: el<HTMLButtonElement>("start-button"),
  homeHint: el("home-hint"),
  prerondTitle: el("preround-title"),
  prerondBody: el("preround-body"),
  calibMeter: el("calib-meter"),
  countdown: el("countdown"),
  prerondCancel: el<HTMLButtonElement>("preround-cancel"),
  timerFill: el("timer-fill"),
  roundClock: el("round-clock"),
  roundScore: el("round-score"),
  cardStage: el("card-stage"),
  cardWord: el("card-word"),
  cardHint: el("card-hint"),
  tapZones: el("tap-zones"),
  tapPass: el<HTMLButtonElement>("tap-pass"),
  tapCorrect: el<HTMLButtonElement>("tap-correct"),
  flash: el("flash"),
  flashIcon: el("flash-icon"),
  flashLabel: el("flash-label"),
  recapScore: el("recap-score"),
  recapSub: el("recap-sub"),
  recapList: el("recap-list"),
  againButton: el<HTMLButtonElement>("again-button"),
  homeButton: el<HTMLButtonElement>("home-button"),
  rotateOverlay: el("rotate-overlay"),
};

// ── App state ───────────────────────────────────────────────────────

let index: DeckIndex | null = null;
let deck: Deck | null = null;
let bag: BagState | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS, ...(read<Partial<Settings>>(SETTINGS_KEY) ?? {}) };
let recent: string[] = read<string[]>(RECENT_KEY) ?? [];
let screen: ScreenName = "home";

let entries: RoundEntry[] = [];
let currentCard: Card | null = null;
let cardShownAt = 0;
let score = 0;
let bonusMs = 0;
let roundActive = false;
let tapFallback = false;
let fallbackMessage = "";
let flashTimer = 0;
let countdownTimer = 0;
let countdownRunning = false;
let countdownPending = false;
let prerollWatchdog = 0;

const timer = new RoundTimer();
let calibrator: Calibrator | null = null;

const tilt = new TiltReader({
  config: DEFAULT_TILT_CONFIG,
  onAction: (action) => handleAction(action),
  onSample: (pitchDeg) => calibrator?.feed(pitchDeg),
  onUnavailable: () => enableTapFallback("No motion sensor here — use the buttons."),
});

// ── Screens ─────────────────────────────────────────────────────────

function show(name: ScreenName): void {
  screen = name;
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle("is-active", key === name);
  }
  updateRotateOverlay();
}

function isPortrait(): boolean {
  return window.matchMedia("(orientation: portrait)").matches;
}

function updateRotateOverlay(): void {
  const needsLandscape = screen === "round" || screen === "preround";
  const portrait = isPortrait();
  dom.rotateOverlay.hidden = !(needsLandscape && portrait);
  if (!portrait && countdownPending) {
    countdownPending = false;
    startCountdown();
  }
}

// ── Home: the deck grid ─────────────────────────────────────────────

function summaryOf(id: string): DeckSummary | null {
  return index?.decks.find((d) => d.id === id) ?? null;
}

function selectedSummary(): DeckSummary | null {
  return summaryOf(settings.deckId);
}

function saveSettings(): void {
  write(SETTINGS_KEY, settings);
}

function tile(summary: DeckSummary): HTMLElement {
  const seen = peekSeenCount(summary.id);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "deck-tile";
  button.dataset["deckId"] = summary.id;
  button.setAttribute("aria-pressed", String(summary.id === settings.deckId));

  const emoji = document.createElement("span");
  emoji.className = "deck-tile-emoji";
  emoji.textContent = summary.emoji;
  emoji.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "deck-tile-name";
  name.textContent = summary.name;

  const meta = document.createElement("span");
  meta.className = "deck-tile-meta";
  meta.textContent = `${seen} / ${summary.count} seen`;

  const track = document.createElement("span");
  track.className = "deck-progress";
  const fill = document.createElement("span");
  fill.className = "deck-progress-fill";
  fill.style.width = `${summary.count === 0 ? 0 : (seen / summary.count) * 100}%`;
  track.append(fill);

  if (summary.emoji) button.append(emoji);
  button.append(name, meta, track);
  return button;
}

function row(decks: readonly DeckSummary[]): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "deck-row";
  for (const summary of decks) grid.append(tile(summary));
  return grid;
}

function heading(text: string, className: string): HTMLElement {
  const node = document.createElement("h2");
  node.className = className;
  node.textContent = text;
  return node;
}

function renderDeckGrid(): void {
  if (!index) return;
  dom.deckGrid.replaceChildren();

  const recentDecks = recent
    .map((id) => summaryOf(id))
    .filter((d): d is DeckSummary => d !== null);
  if (recentDecks.length > 0) {
    dom.deckGrid.append(heading("Recently played", "lang-heading"), row(recentDecks));
  }

  for (const group of groupDecks(index.decks)) {
    dom.deckGrid.append(heading(languageName(group.lang), "lang-heading"));
    for (const { category, decks } of group.categories) {
      dom.deckGrid.append(heading(category, "category-heading"), row(decks));
    }
  }

  // Chrome keeps the old scroll offset across a re-render, so coming back from
  // a round can land the player halfway down a list of twenty decks with no
  // sight of the one that is actually armed.
  dom.deckGrid
    .querySelector<HTMLElement>('.deck-tile[aria-pressed="true"]')
    ?.scrollIntoView({ block: "nearest" });
}

function renderHome(): void {
  if (!index) return;
  const totalCards = index.decks.reduce((sum, d) => sum + d.count, 0);
  dom.deckCount.textContent = `${index.decks.length} decks · ${totalCards.toLocaleString()} cards`;

  renderDeckGrid();

  const summary = selectedSummary();
  dom.startButton.textContent = summary ? `Start · ${summary.name}` : "Pick a deck";
  dom.startButton.disabled = summary === null;
  dom.resetDeck.disabled = summary === null;
  dom.resetDeck.textContent = summary ? `Reset ${summary.name}` : "Reset deck";

  for (const button of dom.lengthGroup.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-checked", String(Number(button.dataset["seconds"]) === settings.seconds));
  }
  dom.soundToggle.checked = settings.sound;
}

function selectDeck(id: string): void {
  if (settings.deckId === id) return;
  settings = { ...settings, deckId: id };
  saveSettings();
  renderHome();
  // Warm the cache so Start does not stall on a fetch.
  void ensureDeck(id).catch(() => {
    /* reported when Start is pressed */
  });
}

async function ensureDeck(id: string): Promise<void> {
  if (deck?.id === id && bag) return;
  deck = await loadDeck(id);
  bag = loadBag(deck);
  saveBag(bag);
}

function noteRecent(id: string): void {
  recent = [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
  write(RECENT_KEY, recent);
}

dom.deckGrid.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".deck-tile");
  const id = button?.dataset["deckId"];
  if (id) selectDeck(id);
});

dom.lengthGroup.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-seconds]");
  if (!button) return;
  const seconds = Number(button.dataset["seconds"]);
  if (!Number.isFinite(seconds)) return;
  settings = { ...settings, seconds };
  saveSettings();
  renderHome();
});

dom.soundToggle.addEventListener("change", () => {
  settings = { ...settings, sound: dom.soundToggle.checked };
  setSoundEnabled(settings.sound);
  saveSettings();
  dom.homeHint.textContent =
    !settings.sound && !hapticsAvailable()
      ? "This browser has no vibration API, so sound off means no cue at all."
      : "";
});

dom.resetDeck.addEventListener("click", () => {
  const summary = selectedSummary();
  if (!summary) return;
  if (deck?.id === summary.id) bag = resetBag(deck);
  else clearBag(summary.id);
  renderHome();
});

// ── Starting a round ────────────────────────────────────────────────

dom.startButton.addEventListener("click", () => void beginPreRound());

/**
 * Everything needing a real user gesture is *invoked* synchronously here: the
 * iOS motion prompt, the AudioContext unlock, fullscreen and orientation.
 * Awaiting one before calling the next would spend the gesture on the first.
 */
async function beginPreRound(): Promise<void> {
  const summary = selectedSummary();
  if (!summary) return;
  setSoundEnabled(settings.sound);

  const audioPromise = unlockAudio();
  const permissionPromise = requestMotionPermission();
  void requestLandscape();
  void acquireWakeLock();
  const [audioOk, permission] = await Promise.all([audioPromise, permissionPromise]);

  tapFallback = false;
  fallbackMessage = "";
  countdownRunning = false;
  countdownPending = false;
  dom.tapZones.hidden = true;
  show("preround");
  dom.countdown.textContent = "";
  dom.calibMeter.style.width = "0%";
  dom.homeHint.textContent =
    settings.sound && !audioOk ? "Audio did not unlock last round — check the silent switch." : "";

  dom.prerondTitle.textContent = "Loading deck…";
  dom.prerondBody.textContent = summary.name;
  try {
    await ensureDeck(summary.id);
  } catch (error) {
    dom.prerondTitle.textContent = "Deck failed to load";
    dom.prerondBody.textContent = String(error);
    return;
  }
  noteRecent(summary.id);

  // Nothing on the pre-round screen is allowed to hang: a sensor that never
  // delivers, or a player who never performs the tilt demo, both end up here.
  if (prerollWatchdog) window.clearTimeout(prerollWatchdog);
  prerollWatchdog = window.setTimeout(
    () => enableTapFallback("Calibration timed out — use the buttons."),
    20000,
  );

  if (permission !== "granted") {
    enableTapFallback(
      permission === "denied"
        ? "Motion access denied — use the buttons, or allow it in Settings."
        : "No motion sensor here — use the buttons.",
    );
    startCountdown();
    return;
  }

  tilt.start();
  tilt.pause();
  startCalibration();
}

async function requestLandscape(): Promise<void> {
  // Both are unsupported on iPhone Safari; the CSS rotate nag is the real
  // fallback. Best effort, never fatal.
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
  } catch {
    /* ignore */
  }
  try {
    const orientation = screenOrientation();
    await orientation?.lock?.("landscape");
  } catch {
    /* ignore */
  }
}

function screenOrientation(): { lock?: (o: string) => Promise<void> } | null {
  const s = window.screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } };
  return s.orientation ?? null;
}

function enableTapFallback(message: string): void {
  if (tapFallback) return;
  tapFallback = true;
  fallbackMessage = message;
  dom.tapZones.hidden = false;
  if (screen === "preround") {
    // Calibration is meaningless without a sensor, and leaving it running would
    // park the player on a screen that never advances.
    calibrator = null;
    tilt.stop();
    startCountdown();
  }
}

// ── Calibration ─────────────────────────────────────────────────────

const CALIB_COPY: Record<CalibPhase, { title: string; body: string }> = {
  rest: {
    title: "Hold it to your forehead",
    body: "Screen facing the room. Keep it still for a second.",
  },
  learn: {
    title: "Now tilt it down",
    body: "Once, all the way down, so the game learns which way is which.",
  },
  recenter: { title: "Bring it back up", body: "Back to your forehead." },
  done: { title: "Ready", body: "" },
};

function startCalibration(): void {
  const stored = loadCalibration();
  const options: ConstructorParameters<typeof Calibrator>[0] = {
    config: DEFAULT_TILT_CONFIG,
    onPhase: (phase, progress) => {
      const copy = CALIB_COPY[phase];
      dom.prerondTitle.textContent = copy.title;
      dom.prerondBody.textContent = copy.body;
      dom.calibMeter.style.width = `${Math.round(progress * 100)}%`;
    },
    onDone: (calibration: Calibration) => {
      calibrator = null;
      tilt.setCalibration(calibration);
      saveCalibration(calibration);
      startCountdown();
    },
  };
  if (stored) options.knownSign = stored.sign;

  calibrator = new Calibrator(options);
  calibrator.begin();
}

// ── Countdown ───────────────────────────────────────────────────────

function startCountdown(): void {
  if (countdownRunning) return;
  // Do not burn the countdown behind the rotate nag — the player cannot see it.
  if (isPortrait()) {
    countdownPending = true;
    return;
  }
  countdownRunning = true;
  countdownPending = false;
  if (prerollWatchdog) window.clearTimeout(prerollWatchdog);
  prerollWatchdog = 0;

  let remaining = COUNTDOWN_FROM;
  dom.prerondTitle.textContent = "Ready";
  dom.prerondBody.textContent = tapFallback
    ? `${fallbackMessage} Left button passes, right one scores.`
    : "Tilt down for a hit, up to pass. Every hit adds a second.";
  dom.calibMeter.style.width = "100%";
  dom.countdown.textContent = String(remaining);
  cueCountdown();

  countdownTimer = window.setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      dom.countdown.textContent = String(remaining);
      cueCountdown();
      return;
    }
    window.clearInterval(countdownTimer);
    countdownTimer = 0;
    startRound();
  }, 1000);
}

function cancelPreRound(): void {
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = 0;
  countdownRunning = false;
  countdownPending = false;
  if (prerollWatchdog) window.clearTimeout(prerollWatchdog);
  prerollWatchdog = 0;
  calibrator = null;
  tilt.stop();
  void releaseWakeLock();
  show("home");
  renderHome();
}

dom.prerondCancel.addEventListener("click", cancelPreRound);

// ── Round ───────────────────────────────────────────────────────────

function startRound(): void {
  if (!deck || !bag) return;
  countdownRunning = false;
  entries = [];
  score = 0;
  bonusMs = 0;
  roundActive = true;
  dom.roundScore.textContent = "0";
  dom.timerFill.classList.remove("is-urgent");
  show("round");
  cueStart();
  tilt.resume();
  nextCard();

  timer.start(
    settings.seconds,
    (remainingMs, wholeSecondsLeft, crossedSecond) => {
      dom.timerFill.style.width = `${(remainingMs / timer.spanMs) * 100}%`;
      dom.roundClock.textContent = String(wholeSecondsLeft);
      // A bonus second can lift the clock back out of the urgent band, so this
      // has to be a toggle rather than a one-way switch.
      dom.timerFill.classList.toggle("is-urgent", wholeSecondsLeft <= 5);
      if (crossedSecond && wholeSecondsLeft <= 5 && wholeSecondsLeft > 0) cueTick();
    },
    endRound,
  );
}

function nextCard(): void {
  if (!deck || !bag) return;
  const card = draw(bag, deck);
  saveBag(bag);
  currentCard = card;
  cardShownAt = performance.now();

  dom.cardWord.textContent = card ? card.t : "Deck is empty";
  dom.cardHint.textContent = card?.hint ?? "";
  // Fit after paint so the stage has its final size.
  requestAnimationFrame(() => {
    fitText(dom.cardWord, Math.max(28, dom.cardStage.clientHeight), 20);
  });
}

function handleAction(action: TiltAction): void {
  if (!roundActive || !currentCard) return;
  const outcome: Outcome = action === "CORRECT" ? "got" : "missed";
  entries.push({ card: currentCard, outcome, ms: performance.now() - cardShownAt });
  if (outcome === "got") {
    score += 1;
    bonusMs += BONUS_MS;
    timer.addTime(BONUS_MS);
    dom.roundScore.textContent = String(score);
    cueCorrect();
  } else {
    cuePass();
  }
  flash(outcome);
  nextCard();
}

function flash(outcome: Outcome): void {
  const correct = outcome === "got";
  dom.flashIcon.textContent = correct ? "✓" : "↑";
  dom.flashLabel.textContent = correct ? `Got it  +${BONUS_MS / 1000}s` : "Pass";
  dom.flash.classList.remove("is-correct", "is-pass");
  dom.flash.classList.add("is-visible", correct ? "is-correct" : "is-pass");
  if (flashTimer) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    dom.flash.classList.remove("is-visible", "is-correct", "is-pass");
    flashTimer = 0;
  }, FLASH_MS);
}

function endRound(): void {
  if (!roundActive) return;
  roundActive = false;
  timer.stop();
  tilt.pause();
  tilt.stop();
  if (flashTimer) window.clearTimeout(flashTimer);
  dom.flash.classList.remove("is-visible", "is-correct", "is-pass");
  // The card still on screen when the clock ran out counts as a miss; the recap
  // is where that gets argued about and corrected.
  if (currentCard) {
    entries.push({ card: currentCard, outcome: "missed", ms: performance.now() - cardShownAt });
    currentCard = null;
  }
  cueTimeUp();
  void releaseWakeLock();
  renderRecap();
  show("recap");
  renderHome();
}

// ── Recap ───────────────────────────────────────────────────────────

function renderRecap(): void {
  dom.recapList.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "recap-empty";
    empty.textContent = "No cards this round.";
    dom.recapList.append(empty);
  }
  entries.forEach((entry, i) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recap-item";
    button.dataset["index"] = String(i);
    button.dataset["outcome"] = entry.outcome;

    const mark = document.createElement("span");
    mark.className = "recap-mark";
    mark.textContent = entry.outcome === "got" ? "✓" : "↑";

    const text = document.createElement("span");
    text.className = "recap-text";
    text.textContent = entry.card.t;

    const time = document.createElement("span");
    time.className = "recap-time";
    time.textContent = `${(entry.ms / 1000).toFixed(1)}s`;

    button.append(mark, text, time);
    item.append(button);
    dom.recapList.append(item);
  });
  // The bonus is what the round actually earned, so it does not move when a
  // miscount is corrected afterwards.
  const earned = bonusMs / 1000;
  const deckName = selectedSummary()?.name ?? "";
  dom.recapSub.textContent = `${deckName} · +${earned}s earned · tap any card to fix a miscount`;
  updateRecapScore();
}

function updateRecapScore(): void {
  dom.recapScore.textContent = String(entries.filter((e) => e.outcome === "got").length);
}

dom.recapList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".recap-item");
  if (!button) return;
  const entry = entries[Number(button.dataset["index"])];
  if (!entry) return;
  entry.outcome = entry.outcome === "got" ? "missed" : "got";
  button.dataset["outcome"] = entry.outcome;
  const mark = button.querySelector(".recap-mark");
  if (mark) mark.textContent = entry.outcome === "got" ? "✓" : "↑";
  updateRecapScore();
});

dom.againButton.addEventListener("click", () => void beginPreRound());
dom.homeButton.addEventListener("click", () => {
  show("home");
  renderHome();
});

// ── Fallback input ──────────────────────────────────────────────────

dom.tapCorrect.addEventListener("click", () => handleAction("CORRECT"));
dom.tapPass.addEventListener("click", () => handleAction("PASS"));

// Keyboard works everywhere, which is the only way to play-test on a desktop.
window.addEventListener("keydown", (event) => {
  if (screen !== "round" || !roundActive) return;
  if (event.key === "ArrowDown" || event.key === " " || event.key === "Enter") {
    event.preventDefault();
    handleAction("CORRECT");
  } else if (event.key === "ArrowUp" || event.key === "Backspace") {
    event.preventDefault();
    handleAction("PASS");
  }
});

window.addEventListener("resize", () => {
  updateRotateOverlay();
  if (screen === "round") fitText(dom.cardWord, Math.max(28, dom.cardStage.clientHeight), 20);
});
window.addEventListener("orientationchange", updateRotateOverlay);

// A round cannot survive the tab going away — the clock would keep running
// while nobody is looking at the phone.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && roundActive) endRound();
});

// ── Boot ────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  setSoundEnabled(settings.sound);
  try {
    index = await loadIndex();
  } catch (error) {
    dom.deckCount.textContent = `Decks failed to load — ${String(error)}`;
    dom.startButton.disabled = true;
    return;
  }

  const known = new Set(index.decks.map((d) => d.id));
  recent = recent.filter((id) => known.has(id));
  if (!known.has(settings.deckId)) {
    settings = { ...settings, deckId: index.decks[0]?.id ?? "" };
    saveSettings();
  }
  renderHome();

  if (settings.deckId) {
    void ensureDeck(settings.deckId).catch(() => {
      /* reported when Start is pressed */
    });
  }

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* offline support is a nice-to-have, not a blocker */
    });
  }
}

void boot();
