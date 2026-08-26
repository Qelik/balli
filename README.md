# Balli

Forehead party game. One phone, screen out, the room shouts clues. Tilt down to
score, tilt up to pass, until the clock runs out.

**Working title.** `balli` is Albanian for "the forehead". Placeholder until the
naming question in the spec is settled — it appears in `index.html`,
`manifest.webmanifest`, `package.json` and the `CACHE` name in `sw.js`.

**Status: phase 1, plus the deck picker.** 22 decks, the timer, the tilt state
machine, the bag shuffle, a deck grid grouped by language and category, and a
second added to the clock for every card the room gets. Still missing from
phases 2–5: team scoring, the TMDB/Wikidata generator and its cron, custom
decks over the URL fragment, and card-quality demotion.

## Run it

```bash
npm install
npm run build
npm run serve      # http://localhost:8080
```

Desktop has no motion sensor, so the round falls back to buttons; `ArrowDown` /
`Space` scores and `ArrowUp` passes, which is how you play-test the flow without
a phone.

**Motion needs HTTPS on a real device.** `DeviceMotionEvent.requestPermission()`
refuses on plain http from anything except localhost, so `http://<your-lan-ip>`
will silently drop to the button fallback. Tunnel it, or push to Pages.

## Layout

```
index.html              shell; loads js/main.js as a module
styles.css
decks/source/*.txt      deck sources — the only files you edit by hand
decks/*.json            compiled decks + index.json, committed
src/*.ts                strict TypeScript, ES modules, no bundler
js/*.js                 compiled output — committed, it is what Pages serves
sw.js                   precaches the shell and every deck in index.json
scripts/build-decks.mjs  decks/source/*.txt -> decks/*.json + index.json
scripts/serve.js        zero-dependency static server
scripts/test.mjs        node --test, no framework
```

`tsc` emits straight to `js/`. Imports carry the `.js` extension in the
TypeScript source because the browser resolves them literally.

## Decks

22 decks, 2,449 cards, English and Albanian. Nothing here is fetched at play
time — decks are compiled and committed, so the game works with the wifi off.

Add one by dropping a file into `decks/source/` and running `npm run decks`:

```
name: Animals
lang: en
category: Nature
emoji: 🐘
---
Elephant
Penguin | bird
# lines starting with a hash are ignored
```

The build fails loudly on a duplicate card, because a duplicate breaks the
bag's promise that one pass deals every card exactly once.

`version` is a **content hash, not a build date**. The version only has to
change when the cards change; a date would migrate every bag on every
regeneration and reshuffle players who had not seen anything new.

The Albanian decks are the differentiator — nothing else in this genre serves
Albanian at all. They are handwritten for now; phase 3 replaces the English
ones with Wikidata `sq` sitelink queries.

## The clock

Every correct card puts **one second back on the clock** (`BONUS_MS` in
`src/main.ts`). The progress bar divides by the largest total the round has
reached rather than the starting length, so a good run grows the bar's
denominator instead of overflowing its track. The urgent colour under five
seconds is a toggle, not a one-way switch, because a bonus can lift the clock
back out of that band.

## The two things worth reading

**`src/bag.ts`** — deal without replacement, persist the cursor, reshuffle only
on exhaustion. `seen` stores card *text*, not deck indices: a regenerated deck
throws the old index space away, so indices cannot say what the player has
already had. On a version bump the seen set survives and the remaining order is
rebuilt from everything unseen, which is "keep the unseen tail, append the new
cards, reshuffle the remainder" expressed in one operation.

**`src/tilt.ts`** — the state machine.

```
NEUTRAL --(past threshold)--> ARMED --(held 120ms)--> FIRED
FIRED --(back inside the neutral band)--> NEUTRAL
```

The `FIRED` lockout is the whole trick. Without it one tilt fires repeatedly on
the way out and the swing back fires the opposite action.

Pitch comes from the screen-normal component of gravity alone, so
landscape-left and landscape-right read identically. The sign is **learned, not
assumed**: iOS Safari reports `accelerationIncludingGravity` inverted relative
to Chrome, and the holder may be left- or right-handed about it. `src/calibrate.ts`
takes a rest reading, asks for one "tilt down", and remembers the answer; later
rounds re-take the rest reading only.

## Tests

```bash
npm test
```

24 tests, all with controlled time — a stubbed `performance.now()` and a
hand-pumped `requestAnimationFrame` — so the sensor and clock logic is checked
properly rather than slept through.

- **Bag** — no repeat inside a pass, the cursor survives a reload, a version
  bump does not reintroduce seen cards, a shrinking deck still reaches
  exhaustion, and the shipped deck deals its full 100 without a collision.
- **Tilt** — one gesture fires one action however long it is held, an overshoot
  on the way back fires nothing, a sub-dwell flick fires nothing, shake is
  rejected, an inverted sign flips the mapping, and a holder who rests the phone
  30° off vertical still gets a neutral band.
- **Calibration** — driven through the real reader: it learns an inverted sign
  and the same physical gesture then scores rather than passes; it completes on
  a 12Hz sensor without falling through to the rest timeout; and a holder who
  cannot keep still still gets released by that timeout.

- **Bag edge cases** — a bag whose order has outrun its deck still deals rather
  than giving up, and an empty deck returns null instead of spinning.
- **Clock** — a correct answer really adds a second, the progress bar never
  overflows its track however much time is added, bonus time genuinely
  lengthens the round, time added after the clock runs out is ignored, and each
  whole second is announced exactly once.

Steadiness during calibration is judged on the time the sample window covers,
not on a sample count — a count-based rule quietly degrades into "wait for the
6s timeout" on a slow or throttled sensor.

## Deploy

GitHub Pages, served from the repo root. `js/` and `decks/*.json` must both be
committed — there is no build step on Pages. Bump `CACHE` in `sw.js` on every
deploy or returning players keep the old shell. The service worker reads its
deck list from `decks/index.json` at install, so adding a deck needs no change
to `sw.js`.

## Known limits

- **No haptics on iOS Safari.** `navigator.vibrate` does not exist there, so the
  spec's "sound-off mode that still works via haptics only" is Android-only on
  the web. The UI says so when sound is switched off and vibration is missing.
- **No orientation lock on iPhone.** `screen.orientation.lock()` and fullscreen
  are both unavailable, so portrait shows a rotate nag instead.
- **Wake Lock is best-effort.** Requested at round start, re-taken on
  `visibilitychange`. The silent-looping-video fallback is not implemented.
- **Backgrounding ends the round.** The clock would otherwise keep running while
  nobody is looking at the phone.
