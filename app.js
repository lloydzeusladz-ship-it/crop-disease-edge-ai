// ═══════════════════════════════════════════════════════════════
//  Edge-AI Crop Diagnostics — app.js
//  Fixes: 224×224 center-crop preprocessing for uploads,
//         correct class-index mapping, seamless mode switching.
// ═══════════════════════════════════════════════════════════════

// ── Config ───────────────────────────────────────────────────
const MODEL_DIR   = "./quantized_model/";
const WASM_DIR    = "./libs/wasm/";
const MODEL_INPUT = 224;       // MobileNetV2 expects 224×224
const WEBCAM_SIZE = 300;       // Display size (rendered, not inference size)
const THROTTLE_MS = 150;

// ── Class Styling Map ────────────────────────────────────────
// Maps className from metadata.json → UI style.
// Order does NOT matter here — we match by className string.
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
let webcam = null;
let isRunning = false;
let cameraAvailable = false;
let cameraStarted = false;
let currentMode = "camera";    // "camera" | "upload"
let lastPredTime = 0;

// Reusable offscreen canvas for preprocessing uploads
const inferCanvas = document.createElement("canvas");
inferCanvas.width = MODEL_INPUT;
inferCanvas.height = MODEL_INPUT;
const inferCtx = inferCanvas.getContext("2d");

// ── DOM References ───────────────────────────────────────────
const $status      = () => document.getElementById("status-pill");
const $statusText  = () => document.getElementById("status-text");
const $loadingMsg  = () => document.getElementById("loading-msg");
const $overlay     = () => document.getElementById("loading-overlay");
const $viewfinder  = () => document.getElementById("viewfinder");
const $preview     = () => document.getElementById("preview-image");
const $uploadZone  = () => document.getElementById("upload-zone");
const $fileInput   = () => document.getElementById("file-input");
const $resultCard  = () => document.getElementById("result-card");
const $badge       = () => document.getElementById("diagnosis-badge");
const $hint        = () => document.getElementById("diagnosis-hint");
const $retakeBtn   = () => document.getElementById("retake-btn");
const $errorCard   = () => document.getElementById("error-card");
const $errorMsg    = () => document.getElementById("error-message");
const $backendInfo = () => document.getElementById("backend-info");
const $btnCamera   = () => document.getElementById("btn-camera");
const $btnUpload   = () => document.getElementById("btn-upload");

// ── UI Helpers ───────────────────────────────────────────────
function setStatus(text, state) {
    const pill = $status();
    pill.className = "status-pill " + state;
    $statusText().textContent = text;
}

function showError(message) {
    setStatus("Error", "error");
    $overlay().classList.add("hidden");
    $errorMsg().textContent = message;
    $errorCard().style.display = "block";
}

function hideError() {
    $errorCard().style.display = "none";
}

// ── Backend Init (WebGL → WASM → CPU) ───────────────────────
async function initBackend() {
    await tf.ready();

    // Try WebGL
    try {
        await tf.setBackend("webgl");
        await tf.ready();
        $backendInfo().innerHTML = "Backend: <code>WebGL</code>";
        return;
    } catch (e) {
        console.warn("WebGL unavailable:", e.message);
    }

    // Try WASM with local binaries
    try {
        if (tf.wasm && tf.wasm.setWasmPaths) {
            tf.wasm.setWasmPaths(WASM_DIR);
        } else if (tf.setWasmPaths) {
            tf.setWasmPaths(WASM_DIR);
        }
        await tf.setBackend("wasm");
        await tf.ready();
        $backendInfo().innerHTML = "Backend: <code>WASM</code>";
        return;
    } catch (e) {
        console.warn("WASM unavailable:", e.message);
    }

    // CPU fallback
    await tf.setBackend("cpu");
    await tf.ready();
    $backendInfo().innerHTML = "Backend: <code>CPU</code>";
}

// ═══════════════════════════════════════════════════════════════
//  PREPROCESSING — The critical fix for upload misclassification
// ═══════════════════════════════════════════════════════════════

/**
 * Center-crop an image/canvas into a 224×224 canvas for model input.
 * This matches the preprocessing that the Teachable Machine webcam
 * applies internally, preventing the model from seeing distorted
 * aspect ratios that bias toward Late Blight.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} source
 * @returns {HTMLCanvasElement} 224×224 canvas ready for model.predict()
 */
function preprocessForModel(source) {
    const sw = source.naturalWidth  || source.width;
    const sh = source.naturalHeight || source.height;

    // Center-crop to square (take the largest centered square)
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

    // Draw cropped region scaled to 224×224
    inferCtx.clearRect(0, 0, MODEL_INPUT, MODEL_INPUT);
    inferCtx.drawImage(source, sx, sy, cropSize, cropSize, 0, 0, MODEL_INPUT, MODEL_INPUT);

    return inferCanvas;
}

// ═══════════════════════════════════════════════════════════════
//  DIAGNOSIS RENDERING
// ═══════════════════════════════════════════════════════════════

/**
 * Given the prediction array from model.predict(), find the top
 * class and render the diagnosis badge. No percentages, no bars.
 *
 * The prediction array indices match metadata.json "labels" order:
 *   [0] = "Healthy"
 *   [1] = "Leaf Miner Infestation"
 *   [2] = "Late Blight"
 *
 * We match by className string (not index) for safety.
 */
function renderDiagnosis(predictions) {
    // Find top prediction
    let top = predictions[0];
    for (let i = 1; i < predictions.length; i++) {
        if (predictions[i].probability > top.probability) {
            top = predictions[i];
        }
    }

    const style = CLASS_STYLES[top.className] || DEFAULT_STYLE;

    const badge = $badge();
    badge.className = "diagnosis-badge " + style.cssClass;
    badge.querySelector(".badge-icon").textContent = style.icon;
    badge.querySelector(".badge-text").textContent = top.className;

    $hint().textContent = style.hint;

    const card = $resultCard();
    card.classList.add("visible");
}

function hideDiagnosis() {
    $resultCard().classList.remove("visible");
}

// ═══════════════════════════════════════════════════════════════
//  CAMERA MODE
// ═══════════════════════════════════════════════════════════════

async function startCamera() {
    if (cameraStarted && webcam) {
        // Re-show existing webcam canvas
        const existing = $viewfinder().querySelector("canvas");
        if (existing) existing.style.display = "block";
        await webcam.play();
        isRunning = true;
        window.requestAnimationFrame(cameraLoop);
        return;
    }

    const flip = true;
    webcam = new tmImage.Webcam(WEBCAM_SIZE, WEBCAM_SIZE, flip);

    try {
        await webcam.setup({ facingMode: "environment" });
    } catch (e) {
        console.warn("Rear camera failed, trying default:", e.message);
        await webcam.setup();
    }

    await webcam.play();
    $viewfinder().appendChild(webcam.canvas);
    cameraStarted = true;
    cameraAvailable = true;
    isRunning = true;
    window.requestAnimationFrame(cameraLoop);
}

function stopCamera() {
    isRunning = false;
    if (webcam) {
        webcam.stop();
        const canvas = $viewfinder().querySelector("canvas");
        if (canvas) canvas.style.display = "none";
    }
}

async function cameraLoop(timestamp) {
    if (!isRunning) return;
    webcam.update();

    if (timestamp - lastPredTime >= THROTTLE_MS) {
        lastPredTime = timestamp;
        try {
            // Webcam canvas is already square — Teachable Machine handles
            // its own 224×224 resize internally for webcam frames
            const predictions = await model.predict(webcam.canvas);
            renderDiagnosis(predictions);
        } catch (e) {
            console.error("Camera prediction error:", e);
        }
    }
    window.requestAnimationFrame(cameraLoop);
}

// ═══════════════════════════════════════════════════════════════
//  UPLOAD MODE
// ═══════════════════════════════════════════════════════════════

function setupFileUpload() {
    const fileInput = $fileInput();
    const zone = $uploadZone();

    fileInput.addEventListener("change", handleFileSelect);

    // Drag-and-drop support
    zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0) {
            processFile(e.dataTransfer.files[0]);
        }
    });
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) processFile(file);
    e.target.value = ""; // Allow re-selecting same file
}

async function processFile(file) {
    if (!model) return;

    const preview = $preview();
    const zone = $uploadZone();

    // Hide upload zone, show preview
    zone.style.display = "none";
    preview.style.display = "block";

    const objectURL = URL.createObjectURL(file);
    preview.src = objectURL;

    preview.onload = async () => {
        setStatus("Analyzing…", "loading");

        try {
            // ★ Critical fix: center-crop to 224×224 before inference
            const preprocessed = preprocessForModel(preview);
            const predictions = await model.predict(preprocessed);
            renderDiagnosis(predictions);
            setStatus("Result ready", "ready");
        } catch (err) {
            console.error("Upload prediction error:", err);
            setStatus("Analysis failed", "error");
        }

        URL.revokeObjectURL(objectURL);
        $retakeBtn().style.display = "block";
    };

    preview.onerror = () => {
        URL.revokeObjectURL(objectURL);
        setStatus("Could not load image", "error");
    };
}

// ═══════════════════════════════════════════════════════════════
//  MODE SWITCHING
// ═══════════════════════════════════════════════════════════════

function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;

    const preview = $preview();
    const zone = $uploadZone();

    // Update toggle buttons
    $btnCamera().classList.toggle("active", mode === "camera");
    $btnUpload().classList.toggle("active", mode === "upload");

    // Hide the previous result
    hideDiagnosis();
    hideError();
    $retakeBtn().style.display = "none";

    if (mode === "camera") {
        // Hide upload UI
        zone.style.display = "none";
        preview.style.display = "none";

        // Start or resume camera
        if (cameraAvailable || !cameraStarted) {
            startCamera()
                .then(() => {
                    $overlay().classList.add("hidden");
                    setStatus("Scanning", "ready");
                })
                .catch((err) => {
                    showCameraUnavailable();
                });
        } else {
            showCameraUnavailable();
        }
    } else {
        // Upload mode
        stopCamera();
        preview.style.display = "none";
        zone.style.display = "flex";
        setStatus("Upload a photo", "ready");
    }
}

function showCameraUnavailable() {
    cameraAvailable = false;
    $overlay().classList.add("hidden");

    // Clear viewfinder and show placeholder
    const vf = $viewfinder();
    const canvas = vf.querySelector("canvas");
    if (canvas) canvas.style.display = "none";

    // Check if placeholder already exists
    if (!vf.querySelector(".camera-placeholder")) {
        const ph = document.createElement("div");
        ph.className = "camera-placeholder";
        ph.innerHTML = `
            <span class="icon">📷</span>
            <p>Camera not available.<br>Switch to <strong>Upload Photo</strong> mode.</p>
        `;
        vf.appendChild(ph);
    } else {
        vf.querySelector(".camera-placeholder").style.display = "flex";
    }

    setStatus("Camera unavailable", "error");
}

function handleRetake() {
    hideDiagnosis();
    $retakeBtn().style.display = "none";

    if (currentMode === "upload") {
        $preview().style.display = "none";
        $uploadZone().style.display = "flex";
        setStatus("Upload a photo", "ready");
    } else {
        switchMode("camera");
    }
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════

async function init() {
    try {
        // 1. Backend
        setStatus("Setting up AI engine…", "loading");
        $loadingMsg().textContent = "Setting up AI engine…";
        await initBackend();

        // 2. Load model
        setStatus("Loading model…", "loading");
        $loadingMsg().textContent = "Loading model…";
        model = await tmImage.load(
            MODEL_DIR + "model.json",
            MODEL_DIR + "metadata.json"
        );

        // Verify class labels loaded correctly
        const totalClasses = model.getTotalClasses();
        console.log(`Model loaded: ${totalClasses} classes`);

        // 3. Wire up file upload
        setupFileUpload();

        // 4. Try starting camera (default mode)
        setStatus("Starting camera…", "loading");
        $loadingMsg().textContent = "Starting camera…";

        try {
            await startCamera();
            $overlay().classList.add("hidden");
            setStatus("Scanning", "ready");
        } catch (camErr) {
            console.warn("Camera unavailable:", camErr.message);
            $overlay().classList.add("hidden");
            showCameraUnavailable();
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

// ── Visibility: pause/resume to save battery ─────────────────
document.addEventListener("visibilitychange", () => {
    if (!cameraAvailable || currentMode !== "camera") return;
    if (document.hidden) {
        isRunning = false;
        if (webcam) webcam.stop();
    } else if (model && webcam) {
        webcam.play();
        isRunning = true;
        window.requestAnimationFrame(cameraLoop);
    }
});

// ── Go ───────────────────────────────────────────────────────
window.addEventListener("load", init);
