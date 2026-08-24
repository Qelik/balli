const LANGUAGE_NAMES = {
    en: "English",
    sq: "Shqip",
};
export function languageName(lang) {
    return LANGUAGE_NAMES[lang] ?? lang.toUpperCase();
}
export async function loadIndex() {
    const response = await fetch("./decks/index.json", { cache: "no-cache" });
    if (!response.ok)
        throw new Error(`deck index failed: ${response.status}`);
    const parsed = (await response.json());
    if (!Array.isArray(parsed.decks) || parsed.decks.length === 0) {
        throw new Error("deck index is empty");
    }
    return parsed;
}
const cache = new Map();
/** Decks are small and there are only a few dozen, so cache them for the session. */
export async function loadDeck(id) {
    const cached = cache.get(id);
    if (cached)
        return cached;
    const response = await fetch(`./decks/${id}.json`, { cache: "no-cache" });
    if (!response.ok)
        throw new Error(`deck ${id} failed: ${response.status}`);
    const deck = (await response.json());
    cache.set(id, deck);
    return deck;
}
/** Group into language sections, each holding its categories in index order. */
export function groupDecks(decks) {
    const byLang = new Map();
    for (const deck of decks) {
        let categories = byLang.get(deck.lang);
        if (!categories) {
            categories = new Map();
            byLang.set(deck.lang, categories);
        }
        const bucket = categories.get(deck.category);
        if (bucket)
            bucket.push(deck);
        else
            categories.set(deck.category, [deck]);
    }
    return [...byLang].map(([lang, categories]) => ({
        lang,
        categories: [...categories].map(([category, list]) => ({ category, decks: list })),
    }));
}
//# sourceMappingURL=decks.js.map