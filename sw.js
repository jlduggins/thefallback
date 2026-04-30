/**
 * The Fallback v2 - Service Worker
 * Handles caching for offline support
 */

const CACHE_NAME = 'fallback-v2-cache-v43';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './config.js',
  './css/tokens.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/responsive.css',
  './js/state.js',
  './js/firebase.js',
  './js/map.js',
  './js/ui.js',
  './js/entries.js',
  './js/trips.js',
  './js/discover.js',
  './js/app.js',
  './icons/logo.png',
  './icons/categories/top-picks.png',
  './icons/categories/camping.png',
  './icons/categories/hiking.png',
  './icons/categories/natural.png',
  './icons/categories/cultural.png',
  './icons/categories/quirky.png',
  './icons/categories/historical.png'
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js'
];

// Install event - cache static assets
// Uses per-asset adds (instead of cache.addAll) so a single missing optional
// asset (e.g. category icons that haven't been cropped from the design files
// yet) doesn't fail the entire install and leave the app uncached. Critical
// assets are still attempted and any failure logs to console for diagnosis.
self.addEventListener('install', event => {
  console.log('[SW] Installing...');

  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      console.log('[SW] Caching static assets');
      const all = [...STATIC_ASSETS, ...EXTERNAL_ASSETS];
      const results = await Promise.allSettled(
        all.map(url => cache.add(url).catch(err => {
          console.warn('[SW] Failed to cache:', url, err.message);
          throw err;
        }))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed) console.warn(`[SW] ${failed} asset(s) failed to cache (continuing)`);
    }).then(() => {
      console.log('[SW] Install complete');
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW] Activate complete');
      return self.clients.claim();
    })
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Skip non-GET requests
  if (request.method !== 'GET') return;
  
  // Skip Firebase/Firestore API calls (these need to be fresh)
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('firebase') ||
      url.hostname.includes('identitytoolkit')) {
    return;
  }
  
  // Skip external API calls (geocoding, routing)
  if (url.hostname.includes('geocod.io') ||
      url.hostname.includes('openrouteservice.org')) {
    return;
  }
  
  // Network-first for map tiles (they change frequently)
  if (url.hostname.includes('tile') ||
      url.hostname.includes('arcgis') ||
      url.hostname.includes('carto')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache successful responses
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache
          return caches.match(request);
        })
    );
    return;
  }
  
  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        // Return cached version, but also fetch update in background
        fetch(request).then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, response);
            });
          }
        }).catch(() => {});
        
        return cachedResponse;
      }
      
      // Not in cache, fetch from network
      return fetch(request).then(response => {
        // Cache successful responses
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
        }
        return response;
      });
    })
  );
});
