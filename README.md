# 🌿 Edge-AI Crop Disease Detector (100% Offline PWA)

A fully autonomous, offline-capable Progressive Web App (PWA) designed to detect crop diseases directly in the browser using on-device machine learning (TensorFlow.js + Teachable Machine).

## Key Architecture & Features

- **100% Offline & Serverless**: Zero external CDN calls or remote APIs. Once loaded or installed as a PWA, it operates completely disconnected from the internet.
- **Local Libraries (`/libs`)**: Contains all runtime dependencies locally (`tf.min.js`, `tf-backend-wasm.min.js`, `teachablemachine-image.min.js`, and WASM binaries).
- **Flexible Hardware Acceleration**:
  - Primary: **WebGL** (GPU-accelerated)
  - Secondary fallback: **WASM** with SIMD support (high performance on older mobile chipsets)
  - Ultimate fallback: **CPU**
- **Autonomous Service Worker (`sw.js`)**: Employs an aggressive Cache-First strategy that pre-caches the application shell, libraries, and model weights during installation.
- **Relative Path Resolution (`./`)**: Portable across root domains and subdirectory hosting (e.g. GitHub Pages `https://username.github.io/repository/`).
- **Camera & Photo Fallback**: Live environment camera stream with automated fallback to file/photo upload on unsupported hardware or restricted permission environments.

---

## Directory Structure

```
crop-disease-edge-ai/
├── index.html                   # Autonomous PWA Shell
├── app.js                       # Hardware fallback, camera & inference logic
├── manifest.json                # PWA installation manifest (relative paths)
├── sw.js                        # Cache-first Service Worker
├── icon.svg                     # Scalable application icon
├── icon-192.png                 # Standard PWA launcher icon
├── icon-512.png                 # High-resolution splash icon
├── libs/                        # 100% Local runtime dependencies
│   ├── tf.min.js
│   ├── tf-backend-wasm.min.js
│   ├── teachablemachine-image.min.js
│   ├── tfjs-backend-wasm.wasm
│   ├── tfjs-backend-wasm-simd.wasm
│   └── tfjs-backend-wasm-threaded-simd.wasm
└── quantized_model/             # Pre-trained edge model assets
    ├── metadata.json
    ├── model.json
    └── weights.bin
```

---

## Deploying to GitHub Pages (HTTPS)

Because modern browsers require a secure context (HTTPS) for Service Workers and Camera APIs, GitHub Pages is the simplest hosting target:

1. **Create Repository**: Create a public GitHub repository (e.g. `crop-disease-edge-ai`).
2. **Push Code**: Commit and push all files in this directory to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Deploy 100% offline crop disease PWA"
   git branch -M main
   git remote add origin https://github.com/<your-username>/crop-disease-edge-ai.git
   git push -u origin main
   ```
3. **Enable GitHub Pages**:
   - Go to your repository **Settings** → **Pages**.
   - Under **Build and deployment**, set Source to **Deploy from a branch**.
   - Select Branch: `main` and folder: `/ (root)`.
   - Click **Save**.
4. **Access the Application**:
   - Open `https://<your-username>.github.io/crop-disease-edge-ai/` on your mobile phone or tablet.
   - Once the page loads, the Service Worker pre-caches all libraries and model files into browser storage.
   - You can test offline mode by switching your phone to **Airplane Mode** and refreshing the page or launching it from your home screen.

---

## Installing as a PWA

- **Android (Chrome / Edge / Samsung Internet)**: Tap the three dots menu → **Add to Home screen** (or tap the **Install App** prompt).
- **iOS (Safari)**: Tap the Share button → **Add to Home Screen**.
