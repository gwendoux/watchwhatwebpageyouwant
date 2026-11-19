// Service worker : réseau d'abord, cache en secours (hors ligne), notifications Web Push.
const CACHE = "veille-v3";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icons/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const key = url.origin + url.pathname; // ignore les paramètres anti-cache
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(() => caches.match(key).then((r) => r || caches.match("index.html")))
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "Veille", {
    body: data.body || "",
    tag: data.tag,
    renotify: !!data.tag,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: new URL(data.url || "./", self.registration.scope).href },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope) && "focus" in w) {
        await w.focus();
        return w.navigate ? w.navigate(url) : undefined;
      }
    }
    return self.clients.openWindow(url);
  })());
});
