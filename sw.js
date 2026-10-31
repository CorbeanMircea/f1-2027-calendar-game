// Lights Out service worker.
// Network first: while you are online every page and script is checked against the server, so a
// new version of the site is used straight away. If you are offline, the last copy is shown.
// Supabase and other websites are never touched or stored.
var CACHE = "lights-out-v1";

self.addEventListener("install", function () { self.skipWaiting(); });

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") { return; }
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }

  event.respondWith(
    fetch(req, { cache: "no-cache" }).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) { return hit; }
        if (req.mode === "navigate") { return caches.match("index.html"); }
        return Response.error();
      });
    })
  );
});
