import type { Deck } from "./types.js";

/** One row of decks/index.json. Enough to draw a tile without fetching the deck. */
export interface DeckSummary {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  readonly category: string;
  readonly emoji: string;
  readonly count: number;
  readonly version: string;
}

export interface DeckIndex {
  readonly decks: readonly DeckSummary[];
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  sq: "Shqip",
};

export function languageName(lang: string): string {
  return LANGUAGE_NAMES[lang] ?? lang.toUpperCase();
}

export async function loadIndex(): Promise<DeckIndex> {
  const response = await fetch("./decks/index.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`deck index failed: ${response.status}`);
  const parsed = (await response.json()) as DeckIndex;
  if (!Array.isArray(parsed.decks) || parsed.decks.length === 0) {
    throw new Error("deck index is empty");
  }
  return parsed;
}

const cache = new Map<string, Deck>();

/** Decks are small and there are only a few dozen, so cache them for the session. */
export async function loadDeck(id: string): Promise<Deck> {
  const cached = cache.get(id);
  if (cached) return cached;
  const response = await fetch(`./decks/${id}.json`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`deck ${id} failed: ${response.status}`);
  const deck = (await response.json()) as Deck;
  cache.set(id, deck);
  return deck;
}

/** Group into language sections, each holding its categories in index order. */
export function groupDecks(
  decks: readonly DeckSummary[],
): Array<{ lang: string; categories: Array<{ category: string; decks: DeckSummary[] }> }> {
  const byLang = new Map<string, Map<string, DeckSummary[]>>();
  for (const deck of decks) {
    let categories = byLang.get(deck.lang);
    if (!categories) {
      categories = new Map();
      byLang.set(deck.lang, categories);
    }
    const bucket = categories.get(deck.category);
    if (bucket) bucket.push(deck);
    else categories.set(deck.category, [deck]);
  }
  return [...byLang].map(([lang, categories]) => ({
    lang,
    categories: [...categories].map(([category, list]) => ({ category, decks: list })),
  }));
}
