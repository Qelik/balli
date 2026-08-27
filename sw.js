/*
 * Precaches the shell and the decks. The game has to work with the party wifi
 * switched off, so a deck miss is a bug, not a degraded experience.
 */
const CACHE = "balli-v3";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/main.js",
  "./js/bag.js",
  "./js/calibrate.js",
  "./js/decks.js",
  "./js/feedback.js",
  "./js/fit.js",
  "./js/storage.js",
  "./js/tilt.js",
  "./js/timer.js",
  "./js/types.js",
  "./js/wake.js",
  "./decks/index.json",
];

/*
 * The deck list comes from decks/index.json rather than a hand-kept array here:
 * decks are added and regenerated often, and a stale array would silently ship
 * a deck that 404s the moment the party wifi drops.
 */
async function precacheUrls() {
  const response = await fetch("./decks/index.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`deck index ${response.status}`);
  const index = await response.json();
  return SHELL.concat(index.decks.map((d) => `./decks/${d.id}.json`));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is atomic: one 404 and nothing is cached, which is louder and
      // easier to debug than a half-populated cache.
      .then(async (cache) => cache.addAll(await precacheUrls()))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  // Stale-while-revalidate: instant offline, and a refresh picks up new decks.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
