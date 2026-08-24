export interface Card {
  /** The word shown on screen. Also the stable identity of the card across deck versions. */
  readonly t: string;
  /** Optional disambiguator, shown small under the word. */
  readonly hint?: string;
}

export interface Deck {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  readonly source: string;
  /** Bumped when the deck is regenerated. Drives bag migration. */
  readonly version: string;
  readonly cards: readonly Card[];
}

export type Outcome = "got" | "missed";

export interface RoundEntry {
  card: Card;
  outcome: Outcome;
  /** Milliseconds the card was on screen. Feeds the phase-5 demotion logic. */
  ms: number;
}
