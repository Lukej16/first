/* =========================================================================
   Commander Notes — service worker
   A small helper the browser runs in the background. It keeps a copy of
   the app's files on the phone so the app still opens with no signal
   (say, in the basement of a game store).

     - App files (HTML, CSS, JS, icons): use the internet when it's there,
       so you always get the newest version; fall back to the saved copy.
     - Card pictures and fonts: use the saved copy if there is one,
       otherwise download it once and save it.
     - Scryfall searches and prices: always live, never saved here.

   If you change the list of app files, bump the version number so phones
   throw away the old copy.
   ========================================================================= */
const VERSION = "v1";
const APP_CACHE = "commander-notes-app-" + VERSION;
const PICTURE_CACHE = "commander-notes-pictures";

const APP_FILES = [
  "./",
  "index.html",
  "style.css",
  "script.js",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-512.png",
];

// Hosts whose files never change, so a saved copy is always fine.
const PICTURE_HOSTS = ["cards.scryfall.io", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

// Delete app copies from older versions.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name.startsWith("commander-notes-app-") && name !== APP_CACHE)
        .map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(internetFirst(request));
  } else if (PICTURE_HOSTS.includes(url.hostname)) {
    event.respondWith(savedCopyFirst(request));
  }
  // Anything else (like api.scryfall.com) goes straight to the internet.
});

async function internetFirst(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(request, { ignoreSearch: true })) || cache.match("index.html");
  }
}

async function savedCopyFirst(request) {
  const cache = await caches.open(PICTURE_CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  // Pictures from other sites come back "opaque" (status 0), which is still fine to save.
  if (response.ok || response.type === "opaque") cache.put(request, response.clone());
  return response;
}
