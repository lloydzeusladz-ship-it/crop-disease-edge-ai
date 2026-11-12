# 🌿 Edge-AI Crop Disease Detector

A **100% offline** Progressive Web App that detects crop diseases using on-device AI. After the first load, **zero network requests** are needed — every dependency is bundled locally.

## Architecture

```
crop-disease-edge-ai/
├── index.html                    ← App shell (zero CDN links)
├── app.js                        ← Inference engine + WebGL/WASM/CPU fallback
├── sw.js                         ← Service Worker (pre-caches everything)
├── manifest.json                 ← PWA install manifest
├── icon.svg                      ← App icon
├── libs/
│   ├── tf.min.js                 ← TensorFlow.js 4.22.0
│   ├── teachablemachine-image.min.js  ← Teachable Machine 0.8.5
│   └── wasm/
│       ├── tf-backend-wasm.min.js
│       ├── tfjs-backend-wasm.wasm
│       ├── tfjs-backend-wasm-simd.wasm
│       └── tfjs-backend-wasm-threaded-simd.wasm
├── quantized_model/
│   ├── model.json
│   ├── metadata.json
│   └── weights.bin
└── generate_assets.py            ← PNG icons + QR code generator
```

**Zero external CDN links.** Every script and binary is in `/libs`.

## Deploy to GitHub Pages

1. Push this repo to a **public** GitHub repository.
2. Go to **Settings → Pages → Deploy from branch → `main`** → Save.
3. Open `https://<you>.github.io/crop-disease-edge-ai/` on any device.
4. After the first visit, the app works **fully offline** — airplane mode, no Wi-Fi, anywhere.

## How It Works

1. **First visit** — the Service Worker caches `index.html`, all scripts in `/libs`, and all model files.
2. **Every subsequent visit** — everything is served from cache. Zero network needed.
3. **Inference** — runs on WebGL (GPU) by default, falls back to WASM then CPU on older devices.
4. **Camera** — uses rear camera for live scanning; falls back to file upload if camera is blocked.

## Generate Icons & QR Code

```bash
pip install Pillow qrcode[pil]
python generate_assets.py --url https://<you>.github.io/crop-disease-edge-ai/
```

## License

MIT
