// ── Configuration ────────────────────────────────────────────
const MODEL_DIR = "./quantized_model/";
const WEBCAM_SIZE = 300;
const PREDICTION_THROTTLE_MS = 100; // Cap inference rate for battery savings

// ── State ────────────────────────────────────────────────────
let model, webcam, labelContainer, maxPredictions;
let lastPredictionTime = 0;
let isRunning = false;
let cameraAvailable = false;

// ── UI Helpers ───────────────────────────────────────────────
function setStatus(text, state = "loading") {
    const bar = document.getElementById("status-bar");
    const label = document.getElementById("status-text");
    bar.className = state; // "loading" | "ready" | "error"
    label.textContent = text;
}

function showError(message) {
    setStatus("Error", "error");
    document.getElementById("loading-overlay").classList.add("hidden");
    const errBox = document.getElementById("error-container");
    document.getElementById("error-message").textContent = message;
    errBox.style.display = "block";
}

function showBackend(name) {
    document.getElementById("backend-badge").innerHTML =
        `Inference backend: <span>${name.toUpperCase()}</span>`;
}

// ── Backend Selection (WebGL → WASM → CPU) ──────────────────
async function initBackend() {
    await tf.ready();

    // Try WebGL first (GPU-accelerated)
    try {
        await tf.setBackend("webgl");
        await tf.ready();
        showBackend("webgl");
        console.log("Using WebGL backend");
        return;
    } catch (e) {
        console.warn("WebGL unavailable:", e.message);
    }

    // Try WASM (good perf on older devices)
    try {
        if (window.tf && tf.wasm && typeof tf.wasm.setWasmPaths === "function") {
            tf.wasm.setWasmPaths("./libs/");
        }
        await tf.setBackend("wasm");
        await tf.ready();
        showBackend("wasm");
        console.log("Using WASM backend (local ./libs/)");
        return;
    } catch (e) {
        console.warn("WASM unavailable:", e.message);
    }

    // CPU fallback (always available)
    await tf.setBackend("cpu");
    await tf.ready();
    showBackend("cpu");
    console.log("Using CPU backend (slowest)");
}

// ── Webcam Setup ─────────────────────────────────────────────
async function initWebcam() {
    const flip = true;
    webcam = new tmImage.Webcam(WEBCAM_SIZE, WEBCAM_SIZE, flip);

    // Try rear camera first, fall back to any available camera
    try {
        await webcam.setup({ facingMode: "environment" });
    } catch (e) {
        console.warn("Rear camera unavailable, trying default:", e.message);
        await webcam.setup();
    }

    await webcam.play();
    document.getElementById("webcam-container").appendChild(webcam.canvas);
}

// ── Prediction Rendering ─────────────────────────────────────
function renderPredictions(predictions) {
    // Find the top prediction index
    let topIdx = 0;
    let topProb = 0;
    for (let i = 0; i < predictions.length; i++) {
        if (predictions[i].probability > topProb) {
            topProb = predictions[i].probability;
            topIdx = i;
        }
    }

    for (let i = 0; i < predictions.length; i++) {
        const pct = (predictions[i].probability * 100).toFixed(1);
        const el = labelContainer.children[i];
        if (!el) continue;

        el.className = i === topIdx ? "metric top" : "metric";
        el.innerHTML = `
            <span class="class-name">${predictions[i].className}</span>
            <span class="bar-bg"><span class="bar-fill" style="width:${pct}%"></span></span>
            <span class="confidence">${pct}%</span>
        `;
    }
}

// ── Inference Loop (camera mode) ─────────────────────────────
async function loop(timestamp) {
    if (!isRunning) return;

    webcam.update();

    // Throttle predictions to save battery
    if (timestamp - lastPredictionTime >= PREDICTION_THROTTLE_MS) {
        lastPredictionTime = timestamp;
        try {
            const predictions = await model.predict(webcam.canvas);
            renderPredictions(predictions);
        } catch (e) {
            console.error("Prediction error:", e);
        }
    }

    window.requestAnimationFrame(loop);
}

// ── File Upload Handler ──────────────────────────────────────
function setupFileUpload() {
    const fileInput = document.getElementById("file-input");
    if (!fileInput) return;

    fileInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file || !model) return;

        const preview = document.getElementById("preview-image");
        const container = document.getElementById("webcam-container");

        // Hide webcam canvas if present, show uploaded image
        const existingCanvas = container.querySelector("canvas");
        if (existingCanvas) existingCanvas.style.display = "none";

        preview.style.display = "block";
        preview.src = window.URL.createObjectURL(file);

        preview.onload = async () => {
            setStatus("Analyzing…", "loading");

            // Draw image to a canvas for prediction
            const canvas = document.createElement("canvas");
            canvas.width = WEBCAM_SIZE;
            canvas.height = WEBCAM_SIZE;
            const ctx = canvas.getContext("2d");

            // Center-crop to square
            const aspect = preview.naturalWidth / preview.naturalHeight;
            let sx = 0, sy = 0, sw = preview.naturalWidth, sh = preview.naturalHeight;
            if (aspect > 1) {
                sx = (sw - sh) / 2;
                sw = sh;
            } else {
                sy = (sh - sw) / 2;
                sh = sw;
            }
            ctx.drawImage(preview, sx, sy, sw, sh, 0, 0, WEBCAM_SIZE, WEBCAM_SIZE);

            try {
                const predictions = await model.predict(canvas);
                renderPredictions(predictions);
                setStatus("Result ready", "ready");
            } catch (err) {
                console.error("Upload prediction error:", err);
                setStatus("Prediction failed", "error");
            }

            window.URL.revokeObjectURL(preview.src);
        };

        // Reset input so the same file can be re-selected
        fileInput.value = "";
    });
}

// ── Build Prediction UI Slots ────────────────────────────────
function buildPredictionSlots() {
    labelContainer = document.getElementById("label-container");
    labelContainer.innerHTML = "";
    for (let i = 0; i < maxPredictions; i++) {
        const div = document.createElement("div");
        div.className = "metric";
        div.innerHTML = `<span class="class-name">—</span>
            <span class="bar-bg"><span class="bar-fill" style="width:0%"></span></span>
            <span class="confidence">—</span>`;
        labelContainer.appendChild(div);
    }
}

// ── Main Init ────────────────────────────────────────────────
async function init() {
    try {
        // 1. Set up TF.js backend
        setStatus("Setting up AI engine…", "loading");
        await initBackend();

        // 2. Load the model
        setStatus("Loading model…", "loading");
        const modelURL = MODEL_DIR + "model.json";
        const metadataURL = MODEL_DIR + "metadata.json";
        model = await tmImage.load(modelURL, metadataURL);
        maxPredictions = model.getTotalClasses();

        // 3. Build prediction UI slots
        buildPredictionSlots();

        // 4. Always wire up file upload as a fallback
        setupFileUpload();

        // 5. Try starting the camera
        setStatus("Starting camera…", "loading");
        try {
            await initWebcam();
            cameraAvailable = true;
            document.getElementById("loading-overlay").classList.add("hidden");
            setStatus("Scanning", "ready");
            isRunning = true;
            window.requestAnimationFrame(loop);
        } catch (camErr) {
            // Camera failed — fall back to upload-only mode
            cameraAvailable = false;
            console.warn("Camera unavailable:", camErr.message);
            document.getElementById("loading-overlay").classList.add("hidden");

            // Show helpful context in the webcam area
            const container = document.getElementById("webcam-container");
            container.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:20px;color:#888;">
                    <div style="font-size:2.5rem;margin-bottom:10px;">📷</div>
                    <div style="font-size:0.85rem;line-height:1.4;">
                        Camera not available.<br>
                        Use the button below to<br>upload or take a photo.
                    </div>
                </div>
            `;

            let reason = "Camera is not accessible.";
            if (location.protocol === "http:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
                reason += " You're on HTTP — camera requires HTTPS or localhost.";
            }

            setStatus("Upload mode", "ready");
            console.info("Running in upload-only mode.", reason);
        }

    } catch (err) {
        console.error("Init failed:", err);
        let userMsg = err.message || "Unknown error";

        if (userMsg.includes("model.json") || userMsg.includes("404")) {
            userMsg = "Model files not found. Make sure the quantized_model/ folder contains model.json, metadata.json, and weights.bin.";
        }

        showError(userMsg);
    }
}

// Handle visibility changes — pause/resume to save resources
document.addEventListener("visibilitychange", () => {
    if (!cameraAvailable) return;
    if (document.hidden) {
        isRunning = false;
        if (webcam) webcam.stop();
    } else if (model && webcam) {
        webcam.play();
        isRunning = true;
        window.requestAnimationFrame(loop);
    }
});

// Auto-initialize on load
window.addEventListener("load", init);
