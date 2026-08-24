import type { Card, Deck } from "./types.js";
import { read, remove, write } from "./storage.js";

/**
 * Bag shuffle: deal without replacement, persist the cursor. The whole point of
 * the project — no card repeats until the bag is exhausted.
 *
 * `order` holds indices into `deck.cards` that have NOT been dealt yet this
 * cycle, in deal order. `seen` holds the *text* of every card dealt since the
 * last full reshuffle.
 *
 * `seen` is text-keyed rather than index-keyed on purpose: when a regenerated
 * deck arrives, the old index space is gone, so indices cannot tell us what the
 * player has already had. Text can.
 */
export interface BagState {
  deckId: string;
  deckVersion: string;
  /** Indices into deck.cards, still to be dealt. */
  order: number[];
  /** Position within `order`. */
  cursor: number;
  /** Card texts already dealt this cycle. */
  seen: string[];
}

const key = (deckId: string): string => `bag:${deckId}`;

function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    // Rejection sampling so the modulo does not skew the distribution.
    const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    for (;;) {
      c.getRandomValues(buf);
      const v = buf[0] ?? 0;
      if (v < limit) return v % maxExclusive;
    }
  }
  return Math.floor(Math.random() * maxExclusive);
}

/** In-place Fisher-Yates. */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

function freshOrder(deck: Deck, excludeTexts: ReadonlySet<string>): number[] {
  const indices: number[] = [];
  for (let i = 0; i < deck.cards.length; i++) {
    const card = deck.cards[i];
    if (card && !excludeTexts.has(card.t)) indices.push(i);
  }
  return shuffle(indices);
}

export function createBag(deck: Deck): BagState {
  return {
    deckId: deck.id,
    deckVersion: deck.version,
    order: freshOrder(deck, new Set()),
    cursor: 0,
    seen: [],
  };
}

function isBagState(v: unknown): v is BagState {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Partial<BagState>;
  return (
    typeof b.deckId === "string" &&
    typeof b.deckVersion === "string" &&
    Array.isArray(b.order) &&
    typeof b.cursor === "number" &&
    Array.isArray(b.seen)
  );
}

/**
 * Migrate a persisted bag onto a newer deck version.
 *
 * Keeps the seen-set, rebuilds the remaining order from every card the player
 * has not had yet — which is exactly "unseen tail + new cards, reshuffled".
 * Never resets `seen`; doing so on every regeneration would reintroduce the
 * repeats the bag exists to prevent.
 */
function migrate(previous: BagState, deck: Deck): BagState {
  const deckTexts = new Set(deck.cards.map((c) => c.t));
  // Drop seen entries for cards the regenerated deck no longer contains, so a
  // shrinking deck can still reach exhaustion.
  const seen = previous.seen.filter((t) => deckTexts.has(t));
  const order = freshOrder(deck, new Set(seen));
  return { deckId: deck.id, deckVersion: deck.version, order, cursor: 0, seen };
}

export function loadBag(deck: Deck): BagState {
  const stored = read<unknown>(key(deck.id));
  if (!isBagState(stored) || stored.deckId !== deck.id) return createBag(deck);
  if (stored.deckVersion !== deck.version) return migrate(stored, deck);
  // Guard against a hand-edited or truncated deck file shrinking under us.
  const order = stored.order.filter(
    (i) => Number.isInteger(i) && i >= 0 && i < deck.cards.length,
  );
  const cursor = Math.min(Math.max(stored.cursor, 0), order.length);
  return { ...stored, order, cursor };
}

export function saveBag(bag: BagState): void {
  write(key(bag.deckId), bag);
}

export function resetBag(deck: Deck): BagState {
  remove(key(deck.id));
  const bag = createBag(deck);
  saveBag(bag);
  return bag;
}

/** Clear a deck's bag without loading the deck — the key format stays in here. */
export function clearBag(deckId: string): void {
  remove(key(deckId));
}

/** How many of the deck's cards have been dealt this cycle. */
export function seenCount(bag: BagState): number {
  return bag.seen.length;
}

/**
 * Seen count for a deck that has not been fetched. The home grid draws twenty
 * tiles and has no reason to pull twenty deck files to do it — and because
 * `seen` is text-keyed it stays meaningful across a version bump.
 */
export function peekSeenCount(deckId: string): number {
  const stored = read<unknown>(key(deckId));
  if (!isBagState(stored)) return 0;
  return stored.seen.length;
}

/**
 * Deal the next card, reshuffling only on exhaustion. Mutates `bag`.
 * Returns null only for an empty deck.
 */
export function draw(bag: BagState, deck: Deck): Card | null {
  if (deck.cards.length === 0) return null;

  if (bag.cursor >= bag.order.length) {
    // Bag exhausted: every card has been seen. Start a new cycle.
    bag.seen = [];
    bag.order = freshOrder(deck, new Set());
    bag.cursor = 0;
    if (bag.order.length === 0) return null;
  }

  const index = bag.order[bag.cursor] as number;
  const card = deck.cards[index];
  bag.cursor += 1;
  if (!card) return draw(bag, deck);
  bag.seen.push(card.t);
  return card;
}
