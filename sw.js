/* miDash service worker — makes the app installable + offline-capable.
   Strategy:
   - Same-origin HTML  → network-first (a fresh GitHub Pages build always wins;
     the cached copy is only the offline fallback). This is deliberate so the
     CONFIG.version stamp never gets stuck on a stale build.
   - Same-origin assets (icons/manifest) → cache-first, refreshed in background.
   - Cross-origin (Google APIs, the chat/notes Worker, GitHub API) → NOT
     intercepted; always hits the network so live data is never cached. */
const CACHE = "midash-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest",
               "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // live data: leave to the network

  const isHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; })
        .catch(() => caches.match(req).then((m) => m || caches.match("./index.html")))
    );
  } else {
    e.respondWith(
      caches.match(req).then((m) => m ||
        fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }))
    );
  }
});
