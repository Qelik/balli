import { read, remove, write } from "./storage.js";
const key = (deckId) => `bag:${deckId}`;
function randomInt(maxExclusive) {
    if (maxExclusive <= 1)
        return 0;
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === "function") {
        // Rejection sampling so the modulo does not skew the distribution.
        const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
        const buf = new Uint32Array(1);
        for (;;) {
            c.getRandomValues(buf);
            const v = buf[0] ?? 0;
            if (v < limit)
                return v % maxExclusive;
        }
    }
    return Math.floor(Math.random() * maxExclusive);
}
/** In-place Fisher-Yates. */
export function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        const a = items[i];
        const b = items[j];
        items[i] = b;
        items[j] = a;
    }
    return items;
}
function freshOrder(deck, excludeTexts) {
    const indices = [];
    for (let i = 0; i < deck.cards.length; i++) {
        const card = deck.cards[i];
        if (card && !excludeTexts.has(card.t))
            indices.push(i);
    }
    return shuffle(indices);
}
export function createBag(deck) {
    return {
        deckId: deck.id,
        deckVersion: deck.version,
        order: freshOrder(deck, new Set()),
        cursor: 0,
        seen: [],
    };
}
function isBagState(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const b = v;
    return (typeof b.deckId === "string" &&
        typeof b.deckVersion === "string" &&
        Array.isArray(b.order) &&
        typeof b.cursor === "number" &&
        Array.isArray(b.seen));
}
/**
 * Migrate a persisted bag onto a newer deck version.
 *
 * Keeps the seen-set, rebuilds the remaining order from every card the player
 * has not had yet — which is exactly "unseen tail + new cards, reshuffled".
 * Never resets `seen`; doing so on every regeneration would reintroduce the
 * repeats the bag exists to prevent.
 */
function migrate(previous, deck) {
    const deckTexts = new Set(deck.cards.map((c) => c.t));
    // Drop seen entries for cards the regenerated deck no longer contains, so a
    // shrinking deck can still reach exhaustion.
    const seen = previous.seen.filter((t) => deckTexts.has(t));
    const order = freshOrder(deck, new Set(seen));
    return { deckId: deck.id, deckVersion: deck.version, order, cursor: 0, seen };
}
export function loadBag(deck) {
    const stored = read(key(deck.id));
    if (!isBagState(stored) || stored.deckId !== deck.id)
        return createBag(deck);
    if (stored.deckVersion !== deck.version)
        return migrate(stored, deck);
    // Guard against a hand-edited or truncated deck file shrinking under us.
    const order = stored.order.filter((i) => Number.isInteger(i) && i >= 0 && i < deck.cards.length);
    const cursor = Math.min(Math.max(stored.cursor, 0), order.length);
    return { ...stored, order, cursor };
}
export function saveBag(bag) {
    write(key(bag.deckId), bag);
}
export function resetBag(deck) {
    remove(key(deck.id));
    const bag = createBag(deck);
    saveBag(bag);
    return bag;
}
/** Clear a deck's bag without loading the deck — the key format stays in here. */
export function clearBag(deckId) {
    remove(key(deckId));
}
/** How many of the deck's cards have been dealt this cycle. */
export function seenCount(bag) {
    return bag.seen.length;
}
/**
 * Seen count for a deck that has not been fetched. The home grid draws twenty
 * tiles and has no reason to pull twenty deck files to do it — and because
 * `seen` is text-keyed it stays meaningful across a version bump.
 */
export function peekSeenCount(deckId) {
    const stored = read(key(deckId));
    if (!isBagState(stored))
        return 0;
    return stored.seen.length;
}
/**
 * Deal the next card, reshuffling only on exhaustion. Mutates `bag`.
 * Returns null only for an empty deck.
 */
export function draw(bag, deck) {
    if (deck.cards.length === 0)
        return null;
    // Two attempts: walk what is left of the current order, then — if the bag ran
    // out, or every entry left in it was stale — one reshuffled pass. Bounded on
    // purpose; this cannot be allowed to fail in the middle of a round.
    for (let attempt = 0; attempt < 2; attempt++) {
        if (bag.cursor >= bag.order.length) {
            // Bag exhausted: every card has been seen. Start a new cycle.
            bag.seen = [];
            bag.order = freshOrder(deck, new Set());
            bag.cursor = 0;
            if (bag.order.length === 0)
                return null;
        }
        while (bag.cursor < bag.order.length) {
            const index = bag.order[bag.cursor];
            const card = deck.cards[index];
            bag.cursor += 1;
            if (card) {
                bag.seen.push(card.t);
                return card;
            }
        }
    }
    return null;
}
//# sourceMappingURL=bag.js.map