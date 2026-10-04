// Höj VERSION (v1 -> v2 osv.) varje gång du laddar upp nya filer,
// så hämtas och cachas den nya versionen säkert.
const VERSION = 'v18';
const CACHE = 'farga-' + VERSION;

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './bilder/traktor.svg',
  './bilder/gravmaskin.svg',
  './bilder/flygplan.svg',
  './bilder/traktor-verklig.svg',
  './bilder/flygplan-litet.svg',
  './bilder/helikopter-stig.svg',
  './bilder/helikopter-luft.svg',
  './bilder/flygplan-falt.svg'
];

// Installera: cacha allt och ta över direkt
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

// Aktivera: radera gamla cache-versioner och ta kontroll över sidan
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (k) { return k !== CACHE; })
              .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Hämta: cachen först (för blixtsnabb start), hämta sedan tyst i bakgrunden.
// Endast egna GET-anrop hanteras.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (cachedResponse) {
      if (cachedResponse) {
        e.waitUntil(
          fetch(req).then(function (res) {
            if (res && res.ok) {
              var copy = res.clone();
              caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
            }
          }).catch(function () {})
        );
        return cachedResponse;
      }

      return fetch(req)
        .then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
          }
          return res;
        })
        .catch(function () {
          return caches.match('./index.html');
        });
    })
  );
});
