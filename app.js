// ═══════════════════════════════════════════════════════════════
//  Edge-AI Crop Diagnostics — app.js
//  v3: Proper MediaStream lifecycle, decoupled camera/upload,
//      clean destroy/recreate on every transition.
// ═══════════════════════════════════════════════════════════════

// ── Config ───────────────────────────────────────────────────
const MODEL_DIR   = "./quantized_model/";
const WASM_DIR    = "./libs/wasm/";
const MODEL_INPUT = 224;       // MobileNetV2 expects 224×224
const WEBCAM_SIZE = 300;       // Display size
const THROTTLE_MS = 150;

// ── Class Styling Map ────────────────────────────────────────
const CLASS_STYLES = {
    "Healthy": {
        cssClass: "healthy",
        icon: "✅",
        hint: "This leaf appears healthy. No signs of disease detected.",
    },
    "Leaf Miner Infestation": {
        cssClass: "leaf-miner",
        icon: "🟠",
        hint: "Signs of leaf miner damage detected. Inspect underside of leaves and consider targeted treatment.",
    },
    "Late Blight": {
        cssClass: "late-blight",
        icon: "🔴",
        hint: "Late blight indicators detected. Isolate affected plants and apply fungicide promptly.",
    },
};

const DEFAULT_STYLE = {
    cssClass: "unknown",
    icon: "❓",
    hint: "Classification uncertain. Try a clearer photo with good lighting.",
};

// ── State ────────────────────────────────────────────────────
let model = null;
let webcam = null;              // tmImage.Webcam instance (or null)
let activeStream = null;        // Raw MediaStream — we track this ourselves
let animFrameId = null;         // rAF handle so we can cancel cleanly
let isRunning = false;
let currentMode = "camera";     // "camera" | "upload"
let lastPredTime = 0;
let modelReady = false;

// Reusable offscreen canvas for preprocessing uploads
const inferCanvas = document.createElement("canvas");
inferCanvas.width = MODEL_INPUT;
inferCanvas.height = MODEL_INPUT;
const inferCtx = inferCanvas.getContext("2d");

// ── DOM References ───────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── UI Helpers ───────────────────────────────────────────────
function setStatus(text, state) {
    const pill = $("status-pill");
    pill.className = "status-pill " + state;
    $("status-text").textContent = text;
}

function showError(message) {
    setStatus("Error", "error");
    $("loading-overlay").classList.add("hidden");
    $("error-message").textContent = message;
    $("error-card").style.display = "block";
}

function hideError() {
    $("error-card").style.display = "none";
}

// ── Backend Init (WebGL → WASM → CPU) ───────────────────────
async function initBackend() {
    await tf.ready();

    try {
        await tf.setBackend("webgl");
        await tf.ready();
        $("backend-info").innerHTML = "Backend: <code>WebGL</code>";
        return;
    } catch (e) {
        console.warn("WebGL unavailable:", e.message);
    }

    try {
        if (tf.wasm && tf.wasm.setWasmPaths) tf.wasm.setWasmPaths(WASM_DIR);
        else if (tf.setWasmPaths) tf.setWasmPaths(WASM_DIR);
        await tf.setBackend("wasm");
        await tf.ready();
        $("backend-info").innerHTML = "Backend: <code>WASM</code>";
        return;
    } catch (e) {
        console.warn("WASM unavailable:", e.message);
    }

    await tf.setBackend("cpu");
    await tf.ready();
    $("backend-info").innerHTML = "Backend: <code>CPU</code>";
}

// ═══════════════════════════════════════════════════════════════
//  PREPROCESSING
// ═══════════════════════════════════════════════════════════════

function preprocessForModel(source) {
    const sw = source.naturalWidth  || source.width;
    const sh = source.naturalHeight || source.height;

    let sx, sy, cropSize;
    if (sw > sh) {
        cropSize = sh;
        sx = Math.floor((sw - sh) / 2);
        sy = 0;
    } else {
        cropSize = sw;
        sx = 0;
        sy = Math.floor((sh - sw) / 2);
    }

    inferCtx.clearRect(0, 0, MODEL_INPUT, MODEL_INPUT);
    inferCtx.drawImage(source, sx, sy, cropSize, cropSize, 0, 0, MODEL_INPUT, MODEL_INPUT);
    return inferCanvas;
}

// ═══════════════════════════════════════════════════════════════
//  DIAGNOSIS RENDERING
// ═══════════════════════════════════════════════════════════════

function renderDiagnosis(predictions) {
    let top = predictions[0];
    for (let i = 1; i < predictions.length; i++) {
        if (predictions[i].probability > top.probability) top = predictions[i];
    }

    const style = CLASS_STYLES[top.className] || DEFAULT_STYLE;
    const badge = $("diagnosis-badge");
    badge.className = "diagnosis-badge " + style.cssClass;
    badge.querySelector(".badge-icon").textContent = style.icon;
    badge.querySelector(".badge-text").textContent = top.className;
    $("diagnosis-hint").textContent = style.hint;
    $("result-card").classList.add("visible");
}

function hideDiagnosis() {
    $("result-card").classList.remove("visible");
}

// ═══════════════════════════════════════════════════════════════
//  CAMERA — Full destroy/recreate lifecycle
// ═══════════════════════════════════════════════════════════════

/**
 * Completely destroys the current webcam instance and releases
 * all hardware resources. After this call, webcam === null and
 * no MediaStream tracks are running.
 */
function destroyCamera() {
    // 1. Stop the inference loop
    isRunning = false;
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }

    // 2. Stop the tmImage.Webcam (calls its internal stream.stop)
    if (webcam) {
        try { webcam.stop(); } catch (e) { /* already stopped */ }
        webcam = null;
    }

    // 3. Explicitly kill every raw MediaStream track
    //    This is the critical fix — tmImage.Webcam.stop() does NOT
    //    always release tracks on all browsers (especially mobile).
    if (activeStream) {
        activeStream.getTracks().forEach((track) => {
            track.stop();
            console.log("[Camera] Track stopped:", track.kind, track.label);
        });
        activeStream = null;
    }

    // 4. Remove the canvas element from the DOM
    const vf = $("viewfinder");
    const canvas = vf.querySelector("canvas");
    if (canvas) {
        canvas.remove();
    }

    console.log("[Camera] Fully destroyed");
}

/**
 * Creates a brand-new webcam instance, requests getUserMedia,
 * and starts the inference loop. Always creates fresh — never
 * reuses a stale webcam object.
 */
async function createCamera() {
    // Always start clean
    destroyCamera();

    const flip = true;
    webcam = new tmImage.Webcam(WEBCAM_SIZE, WEBCAM_SIZE, flip);

    // Request camera stream (this triggers the permission prompt)
    try {
        await webcam.setup({ facingMode: "environment" });
    } catch (e) {
        console.warn("Rear camera failed, trying any camera:", e.message);
        await webcam.setup(); // Falls back to front camera
    }

    // Grab the raw MediaStream so we can manage tracks ourselves
    if (webcam.webcam && webcam.webcam.srcObject) {
        activeStream = webcam.webcam.srcObject;
    } else if (webcam.canvas) {
        // Some versions of tmImage store the stream differently
        const video = $("viewfinder").querySelector("video");
        if (video && video.srcObject) activeStream = video.srcObject;
    }

    await webcam.play();
    $("viewfinder").appendChild(webcam.canvas);

    // Hide placeholder if it exists
    const ph = $("viewfinder").querySelector(".camera-placeholder");
    if (ph) ph.style.display = "none";

    console.log("[Camera] Created and playing, tracks:",
        activeStream ? activeStream.getTracks().length : "unknown");

    // Start inference loop
    isRunning = true;
    lastPredTime = 0;
    animFrameId = requestAnimationFrame(cameraLoop);
}

async function cameraLoop(timestamp) {
    if (!isRunning) return;

    webcam.update();

    if (timestamp - lastPredTime >= THROTTLE_MS) {
        lastPredTime = timestamp;
        try {
            const predictions = await model.predict(webcam.canvas);
            renderDiagnosis(predictions);
        } catch (e) {
            console.error("Camera prediction error:", e);
        }
    }

    animFrameId = requestAnimationFrame(cameraLoop);
}

// ═══════════════════════════════════════════════════════════════
//  UPLOAD MODE — Completely decoupled from camera
// ═══════════════════════════════════════════════════════════════

function setupFileUpload() {
    const fileInput = $("file-input");
    const zone = $("upload-zone");

    // File input change — NO camera permission triggered here
    fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) processFile(file);
        e.target.value = "";
    });

    // Drag-and-drop
    zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0) processFile(e.dataTransfer.files[0]);
    });
}

async function processFile(file) {
    if (!model) return;

    const preview = $("preview-image");
    const zone = $("upload-zone");

    zone.style.display = "none";
    preview.style.display = "block";

    const objectURL = URL.createObjectURL(file);
    preview.src = objectURL;

    preview.onload = async () => {
        setStatus("Analyzing…", "loading");
        try {
            const preprocessed = preprocessForModel(preview);
            const predictions = await model.predict(preprocessed);
            renderDiagnosis(predictions);
            setStatus("Result ready", "ready");
        } catch (err) {
            console.error("Upload prediction error:", err);
            setStatus("Analysis failed", "error");
        }
        URL.revokeObjectURL(objectURL);
        $("retake-btn").style.display = "block";
    };

    preview.onerror = () => {
        URL.revokeObjectURL(objectURL);
        setStatus("Could not load image", "error");
    };
}

// ═══════════════════════════════════════════════════════════════
//  MODE SWITCHING — Clean state machine
// ═══════════════════════════════════════════════════════════════

/**
 * Switches between "camera" and "upload" mode.
 *
 * Key invariants:
 *   - Upload mode NEVER triggers getUserMedia
 *   - Camera mode ALWAYS creates a fresh stream
 *   - Switching to upload ALWAYS destroys the camera stream
 *   - No camera runs in the background during upload mode
 */
function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;

    // Update toggle button styles
    $("btn-camera").classList.toggle("active", mode === "camera");
    $("btn-upload").classList.toggle("active", mode === "upload");

    // Reset shared UI
    hideDiagnosis();
    hideError();
    $("retake-btn").style.display = "none";

    if (mode === "camera") {
        enterCameraMode();
    } else {
        enterUploadMode();
    }
}

function enterCameraMode() {
    // Hide upload UI
    $("upload-zone").style.display = "none";
    $("preview-image").style.display = "none";

    // Show loading overlay while camera starts
    $("loading-overlay").classList.remove("hidden");
    $("loading-msg").textContent = "Starting camera…";
    setStatus("Starting camera…", "loading");

    // Create a completely fresh camera
    createCamera()
        .then(() => {
            $("loading-overlay").classList.add("hidden");
            setStatus("Scanning", "ready");
        })
        .catch((err) => {
            console.warn("Camera failed:", err.message);
            showCameraUnavailable();
        });
}

function enterUploadMode() {
    // ★ Fully destroy camera — release all hardware
    destroyCamera();

    // Show upload UI
    $("preview-image").style.display = "none";
    $("upload-zone").style.display = "flex";

    // Hide placeholder if visible
    const ph = $("viewfinder").querySelector(".camera-placeholder");
    if (ph) ph.style.display = "none";

    setStatus("Upload a photo", "ready");
}

function showCameraUnavailable() {
    destroyCamera(); // Make sure everything is cleaned up
    $("loading-overlay").classList.add("hidden");

    const vf = $("viewfinder");
    let ph = vf.querySelector(".camera-placeholder");
    if (!ph) {
        ph = document.createElement("div");
        ph.className = "camera-placeholder";
        ph.innerHTML = `
            <span class="icon">📷</span>
            <p>Camera not available.<br>Switch to <strong>Upload Photo</strong> mode.</p>
        `;
        vf.appendChild(ph);
    }
    ph.style.display = "flex";

    setStatus("Camera unavailable", "error");
}

function handleRetake() {
    hideDiagnosis();
    $("retake-btn").style.display = "none";

    if (currentMode === "upload") {
        $("preview-image").style.display = "none";
        $("upload-zone").style.display = "flex";
        setStatus("Upload a photo", "ready");
    } else {
        // Re-create camera from scratch
        enterCameraMode();
    }
}

// ═══════════════════════════════════════════════════════════════
//  VISIBILITY CHANGE — Full stop/restart, not pause/resume
// ═══════════════════════════════════════════════════════════════

document.addEventListener("visibilitychange", () => {
    // Only manage camera if we're actually in camera mode
    if (currentMode !== "camera") return;

    if (document.hidden) {
        // ★ Tab hidden: fully destroy camera to release hardware lock.
        //   This prevents frozen frames and frees the camera for other apps.
        console.log("[Visibility] Tab hidden — destroying camera");
        destroyCamera();
    } else {
        // ★ Tab visible again: create a completely new camera stream.
        //   Do NOT try to resume a stale stream — it will be frozen.
        console.log("[Visibility] Tab visible — recreating camera");
        if (modelReady) {
            $("loading-overlay").classList.remove("hidden");
            $("loading-msg").textContent = "Restarting camera…";
            setStatus("Restarting camera…", "loading");

            createCamera()
                .then(() => {
                    $("loading-overlay").classList.add("hidden");
                    setStatus("Scanning", "ready");
                })
                .catch((err) => {
                    console.warn("Camera restart failed:", err.message);
                    showCameraUnavailable();
                });
        }
    }
});

// ═══════════════════════════════════════════════════════════════
//  INIT — Load model first, then camera (only if in camera mode)
// ═══════════════════════════════════════════════════════════════

async function init() {
    try {
        // 1. Set up TF.js backend (no camera permission needed)
        setStatus("Setting up AI engine…", "loading");
        $("loading-msg").textContent = "Setting up AI engine…";
        await initBackend();

        // 2. Load model (no camera permission needed)
        setStatus("Loading model…", "loading");
        $("loading-msg").textContent = "Loading model…";
        model = await tmImage.load(
            MODEL_DIR + "model.json",
            MODEL_DIR + "metadata.json"
        );
        modelReady = true;
        console.log(`Model loaded: ${model.getTotalClasses()} classes`);

        // 3. Wire up file upload (no camera permission needed)
        setupFileUpload();

        // 4. Start camera ONLY if we're in camera mode (the default)
        if (currentMode === "camera") {
            setStatus("Starting camera…", "loading");
            $("loading-msg").textContent = "Starting camera…";

            try {
                await createCamera();
                $("loading-overlay").classList.add("hidden");
                setStatus("Scanning", "ready");
            } catch (camErr) {
                console.warn("Camera unavailable:", camErr.message);
                showCameraUnavailable();
            }
        } else {
            // Upload mode — no camera needed
            $("loading-overlay").classList.add("hidden");
            setStatus("Upload a photo", "ready");
        }

    } catch (err) {
        console.error("Init failed:", err);
        let msg = err.message || "Unknown error";
        if (msg.includes("model.json") || msg.includes("404")) {
            msg = "Model not found. Ensure quantized_model/ contains model.json, metadata.json, and weights.bin.";
        }
        showError(msg);
    }
}

// ── Go ───────────────────────────────────────────────────────
window.addEventListener("load", init);
