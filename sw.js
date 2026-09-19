/**
 * SatTracker – Service Worker
 * Cache-first for app shell, network-first for TLE data.
 */

const CACHE_NAME    = 'sattracker-v4';
const TLE_CACHE     = 'sattracker-tle-v4';
const SHELL_ASSETS  = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './satellite.min.js',
  './manifest.json',
  './map.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Celestrak TLE endpoints
const TLE_ORIGIN = 'https://celestrak.org';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_ASSETS);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME && key !== TLE_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

/* ── Fetch ──────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // TLE endpoints: network-first, fall back to cache
  if (TLE_ORIGINS.some(origin => url.hostname.includes(origin))) {
    event.respondWith(networkFirst(event.request, TLE_CACHE, 5000));
    return;
  }

  // External CDN (satellite.js): stale-while-revalidate
  if (url.hostname.includes('cdnjs')) {
    event.respondWith(staleWhileRevalidate(event.request, CACHE_NAME));
    return;
  }

  // App shell: cache-first
  if (event.request.method === 'GET') {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
  }
});

/* ── Strategies ─────────────────────────────────────────────── */
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName, timeout = 4000) {
  const cache = await caches.open(cacheName);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || fetchPromise;
}

