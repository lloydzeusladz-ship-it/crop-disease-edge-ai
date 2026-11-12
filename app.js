// ── Configuration ────────────────────────────────────────────
const MODEL_DIR = "./quantized_model/";
const WASM_DIR  = "./libs/wasm/";
const WEBCAM_SIZE = 300;
const PREDICTION_THROTTLE_MS = 100;

// ── State ────────────────────────────────────────────────────
let model, webcam, labelContainer, maxPredictions;
let lastPredictionTime = 0;
let isRunning = false;
let cameraAvailable = false;

// ── UI Helpers ───────────────────────────────────────────────
function setStatus(text, state = "loading") {
    const bar = document.getElementById("status-bar");
    const label = document.getElementById("status-text");
    bar.className = state;
    label.textContent = text;
}

function showError(message) {
    setStatus("Error", "error");
    document.getElementById("loading-overlay").classList.add("hidden");
    document.getElementById("error-message").textContent = message;
    document.getElementById("error-container").style.display = "block";
}

function showBackend(name) {
    document.getElementById("backend-badge").innerHTML =
        `Inference backend: <span>${name.toUpperCase()}</span>`;
}

// ── Backend Selection (WebGL → WASM → CPU) ──────────────────
async function initBackend() {
    await tf.ready();

    // 1. Try WebGL (GPU-accelerated)
    try {
        await tf.setBackend("webgl");
        await tf.ready();
        showBackend("webgl");
        console.log("Using WebGL backend");
        return;
    } catch (e) {
        console.warn("WebGL unavailable:", e.message);
    }

    // 2. Try WASM — point it to local .wasm binaries
    try {
        if (typeof tf.wasm !== "undefined" && tf.wasm.setWasmPaths) {
            tf.wasm.setWasmPaths(WASM_DIR);
        } else if (typeof tf.setWasmPaths === "function") {
            tf.setWasmPaths(WASM_DIR);
        }
        await tf.setBackend("wasm");
        await tf.ready();
        showBackend("wasm");
        console.log("Using WASM backend");
        return;
    } catch (e) {
        console.warn("WASM unavailable:", e.message);
    }

    // 3. CPU fallback
    await tf.setBackend("cpu");
    await tf.ready();
    showBackend("cpu");
    console.log("Using CPU backend (slowest)");
}

// ── Webcam Setup ─────────────────────────────────────────────
async function initWebcam() {
    const flip = true;
    webcam = new tmImage.Webcam(WEBCAM_SIZE, WEBCAM_SIZE, flip);

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
    let topIdx = 0, topProb = 0;
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
            <span class="confidence">${pct}%</span>`;
    }
}

// ── Inference Loop (camera mode) ─────────────────────────────
async function loop(timestamp) {
    if (!isRunning) return;
    webcam.update();
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
        const existingCanvas = container.querySelector("canvas");
        if (existingCanvas) existingCanvas.style.display = "none";

        preview.style.display = "block";
        preview.src = window.URL.createObjectURL(file);

        preview.onload = async () => {
            setStatus("Analyzing…", "loading");
            const canvas = document.createElement("canvas");
            canvas.width = WEBCAM_SIZE;
            canvas.height = WEBCAM_SIZE;
            const ctx = canvas.getContext("2d");

            const aspect = preview.naturalWidth / preview.naturalHeight;
            let sx = 0, sy = 0, sw = preview.naturalWidth, sh = preview.naturalHeight;
            if (aspect > 1) { sx = (sw - sh) / 2; sw = sh; }
            else             { sy = (sh - sw) / 2; sh = sw; }
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
        setStatus("Setting up AI engine…", "loading");
        await initBackend();

        setStatus("Loading model…", "loading");
        model = await tmImage.load(MODEL_DIR + "model.json", MODEL_DIR + "metadata.json");
        maxPredictions = model.getTotalClasses();

        buildPredictionSlots();
        setupFileUpload();

        setStatus("Starting camera…", "loading");
        try {
            await initWebcam();
            cameraAvailable = true;
            document.getElementById("loading-overlay").classList.add("hidden");
            setStatus("Scanning", "ready");
            isRunning = true;
            window.requestAnimationFrame(loop);
        } catch (camErr) {
            cameraAvailable = false;
            console.warn("Camera unavailable:", camErr.message);
            document.getElementById("loading-overlay").classList.add("hidden");
            document.getElementById("webcam-container").innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:20px;color:#888;">
                    <div style="font-size:2.5rem;margin-bottom:10px;">📷</div>
                    <div style="font-size:0.85rem;line-height:1.4;">
                        Camera not available.<br>
                        Use the button below to<br>upload or take a photo.
                    </div>
                </div>`;
            setStatus("Upload mode", "ready");
        }
    } catch (err) {
        console.error("Init failed:", err);
        let msg = err.message || "Unknown error";
        if (msg.includes("model.json") || msg.includes("404"))
            msg = "Model files not found. Ensure quantized_model/ contains model.json, metadata.json, and weights.bin.";
        showError(msg);
    }
}

// Pause/resume on visibility change
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

window.addEventListener("load", init);
