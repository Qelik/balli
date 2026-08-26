/*
 * Compiles decks/source/<id>.txt into decks/<id>.json plus decks/index.json.
 *
 * Same output shape the phase-3 generator will emit, so the runtime never has
 * to care whether a deck was typed by hand or pulled from TMDB.
 *
 * Source format — a small header, a `---` line, then one card per line:
 *
 *   name: Animals
 *   lang: en
 *   category: Nature
 *   emoji: 🐘
 *   ---
 *   Elephant
 *   Penguin | bird
 *   # lines starting with a hash are ignored
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceDir = join(root, "decks", "source");
const outDir = join(root, "decks");

/** Display order on the home grid. Anything not listed is appended, sorted. */
const ORDER = [
  "films-2000s",
  "tv-shows",
  "cartoons",
  "video-games",
  "superheroes",
  "marvel-characters",
  "marvel-films",
  "animals",
  "food-drink",
  "around-the-house",
  "jobs",
  "act-it-out",
  "countries",
  "landmarks",
  "famous-people",
  "music-acts",
  "sports",
  "sq-kafshe",
  "sq-ushqime",
  "sq-profesione",
  "sq-vende",
  "sq-figura",
];

function parse(id, text) {
  const [header, body] = splitOnce(text, "\n---\n");
  if (body === null) throw new Error(`${id}: no "---" separator`);

  const meta = {};
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [key, value] = splitOnce(trimmed, ":");
    if (value === null) throw new Error(`${id}: bad header line "${trimmed}"`);
    meta[key.trim()] = value.trim();
  }
  for (const key of ["name", "lang", "category"]) {
    if (!meta[key]) throw new Error(`${id}: header is missing "${key}"`);
  }

  const cards = [];
  const seen = new Set();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [rawText, rawHint] = splitOnce(trimmed, "|");
    const t = rawText.trim();
    if (t === "") continue;
    // A duplicate would break the bag's promise that a pass deals every card once.
    if (seen.has(t)) throw new Error(`${id}: duplicate card "${t}"`);
    seen.add(t);
    const hint = rawHint === null ? "" : rawHint.trim();
    cards.push(hint === "" ? { t } : { t, hint });
  }
  if (cards.length === 0) throw new Error(`${id}: no cards`);

  return {
    id,
    name: meta.name,
    lang: meta.lang,
    category: meta.category,
    emoji: meta.emoji ?? "",
    source: meta.source ?? "handwritten",
    // Content hash, not a build date: the version only has to change when the
    // cards change. A date would migrate every bag on every regeneration and
    // reshuffle players who had not seen anything new.
    version: createHash("sha256").update(JSON.stringify(cards)).digest("hex").slice(0, 8),
    cards,
  };
}

function splitOnce(text, separator) {
  const at = text.indexOf(separator);
  if (at === -1) return [text, null];
  return [text.slice(0, at), text.slice(at + separator.length)];
}

const files = (await readdir(sourceDir)).filter((f) => f.endsWith(".txt")).sort();
const decks = [];
for (const file of files) {
  const id = basename(file, ".txt");
  decks.push(parse(id, await readFile(join(sourceDir, file), "utf8")));
}

decks.sort((a, b) => {
  const ai = ORDER.indexOf(a.id);
  const bi = ORDER.indexOf(b.id);
  if (ai !== bi) return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi);
  return a.id.localeCompare(b.id);
});

for (const deck of decks) {
  const { category: _category, emoji: _emoji, ...deckFile } = deck;
  await writeFile(join(outDir, `${deck.id}.json`), `${JSON.stringify(deckFile, null, 2)}\n`);
}

const index = {
  decks: decks.map((d) => ({
    id: d.id,
    name: d.name,
    lang: d.lang,
    category: d.category,
    emoji: d.emoji,
    count: d.cards.length,
    version: d.version,
  })),
};
await writeFile(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

const total = decks.reduce((sum, d) => sum + d.cards.length, 0);
console.log(`${decks.length} decks, ${total} cards`);
for (const d of decks) console.log(`  ${d.id.padEnd(18)} ${String(d.cards.length).padStart(4)}  ${d.name}`);
