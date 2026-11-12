const CACHE_NAME = "crop-ai-offline-v1";

// All critical assets to pre-cache on install for 100% offline functionality.
// Relative paths ('./') ensure clean deployment across root and subpath domains (e.g. GitHub Pages).
const PRECACHE_ASSETS = [
    "./",
    "./index.html",
    "./app.js",
    "./manifest.json",
    "./icon.svg",
    "./icon-192.png",
    "./icon-512.png",
    "./libs/tf.min.js",
    "./libs/tf-backend-wasm.min.js",
    "./libs/teachablemachine-image.min.js",
    "./libs/tfjs-backend-wasm.wasm",
    "./libs/tfjs-backend-wasm-simd.wasm",
    "./libs/tfjs-backend-wasm-threaded-simd.wasm",
    "./quantized_model/model.json",
    "./quantized_model/weights.bin",
    "./quantized_model/metadata.json"
];

// ── 1. Install Event: Cache all essential assets immediately ──
self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            console.log("[ServiceWorker] Pre-caching offline assets...");
            // Pre-cache assets using Promise.allSettled to ensure individual failures don't halt installation
            const cachePromises = PRECACHE_ASSETS.map((url) =>
                cache.add(new Request(url, { cache: "reload" })).catch((err) => {
                    console.warn(`[ServiceWorker] Failed to cache: ${url}`, err);
                })
            );
            await Promise.all(cachePromises);
            console.log("[ServiceWorker] Pre-caching completed.");
        })
    );
});

// ── 2. Activate Event: Purge old cache versions & claim clients ──
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log("[ServiceWorker] Removing obsolete cache:", cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// ── 3. Fetch Event: Cache-first strategy for complete offline autonomy ──
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    event.respondWith(
        caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            // If not found in cache, fetch from network and dynamically cache
            return fetch(event.request).then((networkResponse) => {
                if (
                    !networkResponse ||
                    networkResponse.status !== 200 ||
                    networkResponse.type === "opaque"
                ) {
                    return networkResponse;
                }

                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });

                return networkResponse;
            }).catch(() => {
                // If offline and requesting navigation, fallback to index.html
                if (event.request.mode === "navigate") {
                    return caches.match("./index.html");
                }
            });
        })
    );
});
