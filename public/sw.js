const CACHE = "telsiz-shell-v8";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("telsiz-shell-") && key !== CACHE).map(key => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch {
    payload = { body: event.data?.text() || "TELSİZ ekibinden yeni bildirim." };
  }
  const title = typeof payload.title === "string" ? payload.title : "TELSİZ";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "TELSİZ ekibinden yeni bildirim.",
    icon: "/icons/apple-touch-icon.png",
    badge: "/icons/apple-touch-icon.png",
    tag: typeof payload.tag === "string" ? payload.tag : "telsiz-push",
    renotify: true,
    data: { url: typeof payload.url === "string" ? payload.url : "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => "focus" in client);
    const url = new URL(event.notification.data?.url || "/", self.location.origin);
    const safeUrl = url.origin === self.location.origin ? url.href : self.location.origin;
    return existing ? existing.focus() : self.clients.openWindow(safeUrl);
  }));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put("/", copy));
      return response;
    }).catch(() => caches.match("/")));
    return;
  }

  if (url.pathname.includes("/assets/")) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    })));
  }
});
