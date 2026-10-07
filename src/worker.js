import { renderStereogram, analyseDepth } from "./stereogram.js";
import { composeDepth, transformDepth, renderRelief } from "./scene.js";

// Imported images are registered once. Their decoded pixels do not cross the
// thread boundary on each pointer move. Least-recently-used data is bounded.
const assets = new Map();
const ASSET_LIMIT = 128 * 1024 * 1024;
let assetBytes = 0;
function registerAsset(key, imageData) {
  const evicted = [];
  if (
    typeof key !== "string" ||
    !imageData?.data ||
    !Number.isInteger(imageData.width) ||
    !Number.isInteger(imageData.height) ||
    imageData.width < 1 ||
    imageData.height < 1 ||
    imageData.data.length !== imageData.width * imageData.height * 4
  )
    throw new Error("Invalid image asset");
  const bytes = imageData.data.byteLength;
  if (bytes > ASSET_LIMIT)
    throw new Error("Image asset exceeds the 128 MB renderer limit");
  if (assets.has(key)) {
    assetBytes -= assets.get(key).data.byteLength;
    assets.delete(key);
  }
  while (assetBytes + bytes > ASSET_LIMIT && assets.size) {
    const oldest = assets.keys().next().value;
    assetBytes -= assets.get(oldest).data.byteLength;
    assets.delete(oldest);
    evicted.push(oldest);
  }
  assets.set(key, imageData);
  assetBytes += bytes;
  return evicted;
}
function getAsset(key) {
  const value = assets.get(key);
  if (!value) throw new Error(`Image asset is unavailable: ${key}`);
  assets.delete(key);
  assets.set(key, value);
  return value;
}

/** Pure frame entry point also available for deterministic pipeline tests. */
export function renderFrame({
  scene,
  width,
  height,
  settings = {},
  texture = null,
  textureKey,
  quality,
  output = "all",
  diagnostics = false,
}) {
  if (!["all", "stereo", "depth", "relief"].includes(output))
    throw new RangeError("Unknown frame output");
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 64_000_000
  )
    throw new RangeError(
      "Frame dimensions must be positive integers (at most 64 million pixels)",
    );
  const start = performance.now();
  const required = new Set(
    (scene.layers || []).map((layer) => layer.imageKey).filter(Boolean),
  );
  const needsStereo = output === "all" || output === "stereo";
  if (needsStereo && settings.palette === "custom" && textureKey)
    required.add(textureKey);
  const missingAssets = [...required].filter((key) => !assets.has(key));
  if (missingAssets.length)
    throw Object.assign(new Error("The renderer needs to reload image data."), {
      missingAssets,
    });
  const resolvedScene = {
    ...scene,
    layers: (scene.layers || []).map((layer) =>
      layer.imageKey
        ? { ...layer, imageData: getAsset(layer.imageKey) }
        : layer,
    ),
  };
  const depth = transformDepth(
    composeDepth(resolvedScene, width, height),
    width,
    height,
    settings,
  );
  const composed = performance.now();
  const scale = width / 1100;
  const result = needsStereo
    ? renderStereogram({
        depth,
        width,
        height,
        repeat: Math.max(1, Math.round((settings.repeat ?? 90) * scale)),
        strength: (settings.strength ?? 45) / 100,
        mode: settings.mode ?? "parallel",
        seed: settings.seed ?? 3271,
        palette:
          settings.palette === "custom"
            ? "verdigris"
            : (settings.palette ?? "verdigris"),
        grain: (settings.grain ?? 2) * scale,
        textureStyle: settings.textureStyle ?? "stipple",
        textureRepeat: settings.textureRepeat ?? "both",
        textureScale: settings.textureScale ?? 100,
        texture:
          settings.palette === "custom"
            ? textureKey
              ? getAsset(textureKey)
              : texture
            : null,
      })
    : null;
  const stereoDone = performance.now();
  const relief =
    output === "all" || output === "relief"
      ? renderRelief(depth, width, height)
      : undefined;
  const end = performance.now();
  let analysis;
  if (diagnostics) {
    // A 2× reference reveals within-pixel variation without allocating an
    // unbounded export raster. Large-output checks still report quantisation.
    const referenceDepth =
      width * height * 4 <= 4_000_000
        ? transformDepth(
            composeDepth(resolvedScene, width * 2, height * 2),
            width * 2,
            height * 2,
            settings,
          )
        : null;
    analysis = analyseDepth({
      depth,
      width,
      height,
      repeat: Math.max(1, Math.round((settings.repeat ?? 90) * scale)),
      strength: (settings.strength ?? 45) / 100,
      mode: settings.mode ?? "parallel",
      referenceDepth,
    });
  }
  return {
    width,
    height,
    quality,
    depth,
    pixels: result?.pixels,
    relief,
    stats: result?.stats,
    ...analysis,
    timing: {
      compose: composed - start,
      stereogram: stereoDone - composed,
      relief: end - stereoDone,
      total: end - start,
      diagnostics: performance.now() - end,
    },
  };
}

if (
  typeof WorkerGlobalScope !== "undefined" &&
  self instanceof WorkerGlobalScope
)
  self.onmessage = ({ data }) => {
    const { id, kind, options } = data;
    try {
      if (kind === "asset") {
        const keys = registerAsset(data.key, data.imageData);
        if (keys.length) self.postMessage({ kind: "assets-evicted", keys });
        return;
      }
      if (kind === "prune") {
        const keep = new Set(data.keys || []);
        const keys = [];
        for (const [key, value] of assets)
          if (!keep.has(key)) {
            assetBytes -= value.data.byteLength;
            assets.delete(key);
            keys.push(key);
          }
        if (keys.length) self.postMessage({ kind: "assets-evicted", keys });
        return;
      }
      const result =
        kind === "frame" ? renderFrame(data) : renderStereogram(options);
      const transfer = [];
      for (const key of ["pixels", "depth", "relief", "diagnosticMask"])
        if (result[key]) transfer.push(result[key].buffer);
      self.postMessage({ id, ...result }, transfer);
    } catch (error) {
      self.postMessage({
        id,
        error: error.message,
        ...(error.missingAssets ? { missingAssets: error.missingAssets } : {}),
      });
    }
  };
