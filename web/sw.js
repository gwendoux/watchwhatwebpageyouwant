// Service worker : coque de l'app servie depuis le cache (mise à jour en arrière-plan),
// données réseau d'abord avec repli hors ligne, notifications Web Push.
const BUILD = "__BUILD__"; // remplacé à chaque déploiement par le workflow
const CACHE = `veille-${BUILD}`;
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png"];
const DATA = /\/(data\/.+|urls|vapid)\.json$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("veille-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.registration.navigationPreload?.enable();
    await self.clients.claim();
  })());
});

async function networkFirst(event, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(event.request);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(event, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  const update = (async () => {
    const res = (await event.preloadResponse) ?? await fetch(event.request);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  })();
  event.waitUntil(update.catch(() => {}));
  return hit ?? update.catch(async () => (await cache.match("index.html")) ?? Response.error());
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return; // API GitHub : jamais en cache
  const key = url.origin + url.pathname; // ignore les paramètres anti-cache
  event.respondWith(DATA.test(url.pathname)
    ? networkFirst(event, key)
    : staleWhileRevalidate(event, event.request.mode === "navigate" ? new URL("index.html", self.registration.scope).href : key));
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { body: event.data?.text() }; }
  const target = new URL(data.url || "./", self.registration.scope);
  event.waitUntil(self.registration.showNotification(String(data.title || "Veille").slice(0, 120), {
    body: String(data.body ?? "").slice(0, 300),
    tag: data.tag,
    renotify: Boolean(data.tag),
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    // N'ouvre que des adresses de l'app elle-même.
    data: { url: target.origin === self.location.origin ? target.href : self.registration.scope },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? self.registration.scope;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) {
      await win.focus();
      return win.navigate?.(url);
    }
    return self.clients.openWindow(url);
  })());
});
