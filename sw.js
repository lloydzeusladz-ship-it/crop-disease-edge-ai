// ── sw.js — Service Worker for 100% offline operation ────────
// Pre-caches every asset on install. No network requests needed after first load.

const CACHE_NAME = "crop-ai-offline-v2";

// Every file the app needs — all local, zero CDN
const PRECACHE_ASSETS = [
    "./",
    "./index.html",
    "./app.js",
    "./manifest.json",
    "./icon.svg",

    // TensorFlow.js core
    "./libs/tf.min.js",

    // Teachable Machine image library
    "./libs/teachablemachine-image.min.js",

    // WASM backend (fallback for devices without WebGL)
    "./libs/wasm/tf-backend-wasm.min.js",
    "./libs/wasm/tfjs-backend-wasm.wasm",
    "./libs/wasm/tfjs-backend-wasm-simd.wasm",
    "./libs/wasm/tfjs-backend-wasm-threaded-simd.wasm",

    // Trained model
    "./quantized_model/model.json",
    "./quantized_model/metadata.json",
    "./quantized_model/weights.bin",
];

// ── Install: pre-cache everything ───────────────────────────
self.addEventListener("install", (event) => {
    console.log("[SW] Installing — caching all assets for offline use");
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
    );
});

// ── Activate: delete old caches, take control immediately ───
self.addEventListener("activate", (event) => {
    console.log("[SW] Activated");
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => {
                        console.log("[SW] Deleting old cache:", name);
                        return caches.delete(name);
                    })
            )
        )
    );
    self.clients.claim();
});

// ── Fetch: cache-first, network fallback ────────────────────
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;

            // Not pre-cached — try network (handles icon-192.png, etc.)
            return fetch(event.request)
                .then((response) => {
                    if (!response || response.status !== 200) return response;
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => {
                    // Fully offline and asset not cached — return index for navigation
                    if (event.request.mode === "navigate") {
                        return caches.match("./index.html");
                    }
                    return new Response("Offline", { status: 503 });
                });
        })
    );
});
