/**
 * Optional, entirely client-side photograph depth estimation.
 * No model or runtime is requested until estimateDepth is called. The worker is
 * built from functions so the same module works in the portable HTML build.
 */
export const DEPTH_MODEL = Object.freeze({
  id: "onnx-community/depth-anything-v2-small",
  revision: "4472b7362082ad9968fee890ca0f1e5aca36b93d",
  name: "Depth Anything V2 Small",
  license: "Apache-2.0",
  source: "https://huggingface.co/onnx-community/depth-anything-v2-small",
  runtime:
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js",
  modelBytes: 27_258_801,
});

/** Preserve the model's relative near/far ordering; trim only extreme tails. */
export function normalizeDepth(values, { lower = 0.01, upper = 0.99 } = {}) {
  if (!(values instanceof Float32Array) || !values.length)
    throw new Error("The depth model returned an empty result.");
  if (!(lower >= 0 && upper <= 1 && lower < upper))
    throw new RangeError("Depth quantiles must satisfy 0 ≤ lower < upper ≤ 1.");
  const stride = Math.max(1, Math.ceil(values.length / 32_768));
  const samples = [];
  for (let i = 0; i < values.length; i += stride)
    if (Number.isFinite(values[i])) samples.push(values[i]);
  if (!samples.length)
    throw new Error("The depth model returned no finite values.");
  samples.sort((a, b) => a - b);
  const quantile = (q) => {
    const index = q * (samples.length - 1);
    const start = Math.floor(index);
    return (
      samples[start] +
      (samples[Math.min(start + 1, samples.length - 1)] - samples[start]) *
        (index - start)
    );
  };
  const low = quantile(lower);
  const high = quantile(upper);
  const range = high - low;
  const flat = range <= Math.max(1e-7, Math.abs(high) * 1e-6);
  const data = new Float32Array(values.length);
  let invalid = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      invalid++;
      data[i] = 0;
    } else {
      data[i] = flat
        ? 0.5
        : Math.max(0, Math.min(1, (values[i] - low) / range));
    }
  }
  return {
    data,
    low,
    high,
    flat,
    invalid,
    lowerQuantile: lower,
    upperQuantile: upper,
  };
}

export function validateDepthInput(image) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > 20_000_000 ||
    !(
      image.data instanceof Uint8ClampedArray ||
      image.data instanceof Uint8Array
    ) ||
    image.data.length !== image.width * image.height * 4
  )
    throw new Error(
      "Choose a PNG, JPEG or WebP photograph of up to 20 million pixels.",
    );
  if (Math.max(image.width / image.height, image.height / image.width) > 8)
    throw new Error(
      "Crop this image to an aspect ratio between 1:8 and 8:1 before estimating depth.",
    );
}

function depthWorker(normalizeDepth) {
  let estimator;
  let runtime;
  let currentQuality;
  let device = "wasm";
  let currentId;
  const progress = (value) =>
    self.postMessage({ id: currentId, kind: "progress", ...value });
  self.onmessage = async ({ data: request }) => {
    currentId = request.id;
    const { config, image, quality } = request;
    try {
      if (!runtime) {
        progress({ phase: "runtime", message: "Loading depth tools…" });
        runtime = await import(config.runtime);
        runtime.env.allowLocalModels = false;
        runtime.env.useBrowserCache = true;
        // One worker-owned WASM thread works without cross-origin isolation.
        runtime.env.backends.onnx.wasm.numThreads = 1;
        runtime.env.backends.onnx.wasm.proxy = false;
      }
      if (!estimator || currentQuality !== quality) {
        if (estimator) await estimator.dispose();
        estimator = null;
        device = "wasm";
        if (quality === "detailed" && navigator.gpu) {
          try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) device = "webgpu";
          } catch {
            /* The CPU implementation remains available. */
          }
        }
        const options = {
          device,
          dtype: quality === "detailed" ? "fp32" : "q8",
          revision: config.revision,
          progress_callback(event) {
            if (event.file?.endsWith(".onnx")) {
              const fraction =
                event.total > 0 ? event.loaded / event.total : undefined;
              progress({
                phase: "download",
                message: "Loading depth model…",
                loaded: event.loaded,
                total: event.total,
                fraction,
              });
            }
          },
        };
        progress({ phase: "model", message: "Loading depth model…", device });
        try {
          estimator = await runtime.pipeline(
            "depth-estimation",
            config.id,
            options,
          );
        } catch (error) {
          if (device !== "webgpu") throw error;
          device = "wasm";
          progress({
            phase: "model",
            message: "Switching to the CPU…",
            device,
          });
          estimator = await runtime.pipeline("depth-estimation", config.id, {
            ...options,
            device,
          });
        }
        currentQuality = quality;
      }
      progress({ phase: "inference", message: "Estimating depth…", device });
      const start = performance.now();
      let source = new runtime.RawImage(
        image.data,
        image.width,
        image.height,
        4,
      );
      const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
      if (scale < 1)
        source = await source.resize(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        );
      const output = await estimator(source);
      const [height, width] = output.predicted_depth.dims.slice(-2);
      if (width * height > 1024 * 1024)
        throw new Error(
          "The depth model returned an unexpectedly large image.",
        );
      const normalized = normalizeDepth(
        new Float32Array(output.predicted_depth.data),
      );
      const metadata = {
        model: config.id,
        revision: config.revision,
        runtime: "Transformers.js 3.8.1",
        device,
        quality,
        inferenceMs: performance.now() - start,
        nearIsWhite: true,
        relativeDepth: true,
        normalization: { ...normalized, data: undefined },
      };
      self.postMessage(
        {
          id: currentId,
          kind: "result",
          width,
          height,
          data: normalized.data,
          metadata,
        },
        [normalized.data.buffer],
      );
    } catch (error) {
      const detail = String(error?.message || error).slice(0, 500);
      self.postMessage({
        id: currentId,
        kind: "error",
        message: detail,
        offline: navigator.onLine === false,
      });
    }
  };
}

let worker;
let active;
let nextId = 0;
let idleTimer;
const abortError = () =>
  new DOMException("Depth estimation cancelled.", "AbortError");

function stopWorker() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = undefined;
}

export function disposeDepthEstimator() {
  stopWorker();
  active?.reject(abortError());
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint8Array}} image
 * @param {{onProgress?:(progress:object)=>void, signal?:AbortSignal, quality?:'balanced'|'detailed'}} options
 * @returns {Promise<{width:number,height:number,data:Float32Array,metadata:object}>}
 */
export function estimateDepth(
  image,
  { onProgress, signal, quality = "balanced" } = {},
) {
  validateDepthInput(image);
  if (!new Set(["balanced", "detailed"]).has(quality))
    return Promise.reject(
      new Error("Choose balanced or detailed depth estimation."),
    );
  if (signal?.aborted) return Promise.reject(abortError());
  if (active)
    return Promise.reject(
      new Error("A photograph is already being processed."),
    );
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined")
    return Promise.reject(
      new Error(
        "Depth estimation needs a browser with Web Workers and WebAssembly support.",
      ),
    );
  clearTimeout(idleTimer);
  if (!worker) {
    const source = `(${depthWorker.toString()})(${normalizeDepth.toString()});`;
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    try {
      worker = new Worker(url, { name: "photo-depth" });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    let timeout;
    const finish = (callback, value) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      active = undefined;
      if (worker) idleTimer = setTimeout(stopWorker, 120_000);
      callback(value);
    };
    const fail = (error) => {
      stopWorker();
      finish(reject, error);
    };
    const onAbort = () => fail(abortError());
    active = { reject: (error) => finish(reject, error) };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () =>
        fail(
          new Error(
            "Depth estimation timed out. Check your connection and try again, or use a smaller photograph.",
          ),
        ),
      180_000,
    );
    worker.onmessage = ({ data: message }) => {
      if (message.id !== id) return;
      if (message.kind === "progress") {
        try {
          onProgress?.(message);
        } catch {
          /* Display callbacks cannot interrupt inference. */
        }
      } else if (message.kind === "result") {
        const { kind, id: resultId, ...result } = message;
        finish(resolve, result);
      } else if (message.kind === "error") {
        const reason = message.offline
          ? "Connect to the Internet to load the optional depth tools, then try again. Your photograph stays on this device."
          : "The depth tools could not finish. Check your connection and available memory, then try again.";
        const error = new Error(reason);
        error.cause = message.message;
        fail(error);
      }
    };
    worker.onerror = () =>
      fail(
        new Error(
          "The depth worker could not start. Allow scripts from jsDelivr and model downloads from Hugging Face, then retry.",
        ),
      );
    // Clone rather than transfer: callers can still show or reuse the photograph.
    worker.postMessage({ id, config: DEPTH_MODEL, quality, image });
  });
}
