import { parseProject, serialiseProject } from "./editor.js";

const IMAGE_LIMIT = 20 * 1024 * 1024;
const PIXEL_LIMIT = 20_000_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DRAFT_FORMAT = "autostereogram-studio-draft";
const LOCAL_FORMAT = "autostereogram-studio-local-draft";
const LOCAL_KEY = "stereogram-draft-v2";
const LEGACY_KEY = "stereogram-draft-v1";
let databasePromise;
let saveQueue = Promise.resolve();
let lastSaveTime = 0;

function imageDimensions(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > PIXEL_LIMIT
  )
    throw new Error("Images must contain between one and 20 million pixels.");
  return { width, height };
}

function rasterise(image, longestEdge) {
  const source = imageDimensions(image);
  const scale = Math.min(
    1,
    longestEdge / Math.max(source.width, source.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("This browser could not create an image canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    canvas,
    imageData: {
      data: pixels.data,
      width: pixels.width,
      height: pixels.height,
    },
  };
}

function imageFromURL(url) {
  if (
    typeof url !== "string" ||
    !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
  )
    return Promise.reject(
      new Error("The saved image is not a supported embedded image."),
    );
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      image.onload = image.onerror = null;
      resolve(image);
    };
    image.onerror = () => {
      image.onload = image.onerror = null;
      reject(new Error("The image could not be decoded."));
    };
    image.src = url;
  });
}

async function bitmapFromFile(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      throw new Error("The image could not be decoded.");
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("The image could not be decoded."));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Imports only local raster images; saved PNG assets retain transparent pixels. */
export async function readImage(file) {
  if (!file || !IMAGE_TYPES.has(file.type))
    throw new Error("Choose a PNG, JPEG or WebP image.");
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > IMAGE_LIMIT)
    throw new Error("Choose an image smaller than 20 MB.");
  const image = await bitmapFromFile(file);
  try {
    const { canvas, imageData } = rasterise(image, 1600);
    return {
      imageURL: canvas.toDataURL("image/png"),
      imageData,
      name: String(file.name || "Image")
        .replace(/\.[^.]+$/, "")
        .slice(0, 120),
    };
  } finally {
    image.close?.();
  }
}

/** Hydrates embedded URLs without network requests. Mutates and returns state. */
export async function hydrateState(state) {
  const assets = new Map();
  for (const layer of state.scene.layers) {
    delete layer.image;
    if (layer.type !== "image" || layer.imageData || !layer.imageURL) continue;
    let data = assets.get(layer.imageURL);
    if (!data) {
      data = rasterise(await imageFromURL(layer.imageURL), 1600).imageData;
      assets.set(layer.imageURL, data);
    }
    layer.imageData = data;
  }
  if (state.textureURL && !state.texture)
    state.texture = rasterise(
      await imageFromURL(state.textureURL),
      512,
    ).imageData;
  return state;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // The browser may begin reading after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function database() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) return Promise.resolve(null);
  databasePromise = new Promise((resolve, reject) => {
    let rejected = false;
    let request;
    try {
      request = indexedDB.open("autostereogram-studio", 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("draft"))
        request.result.createObjectStore("draft");
    };
    request.onblocked = () => {
      rejected = true;
      reject(
        new Error(
          "Browser draft storage is blocked by another open studio tab.",
        ),
      );
    };
    request.onerror = () =>
      reject(
        request.error || new Error("Browser draft storage could not open."),
      );
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        databasePromise = undefined;
      };
      resolve(db);
    };
  }).catch((error) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

function indexedDraft(db, record) {
  return new Promise((resolve, reject) => {
    let transaction;
    let request;
    try {
      transaction = db.transaction(
        "draft",
        record === undefined ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore("draft");
      request =
        record === undefined
          ? store.get("current")
          : store.put(record, "current");
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () =>
      reject(
        transaction.error ||
          request.error ||
          new Error("The browser could not store the draft."),
      );
  });
}

function snapshotState(state) {
  return structuredClone({
    document: state.document,
    settings: state.settings,
    scene: {
      ...state.scene,
      layers: state.scene.layers.map(({ image, ...layer }) => layer),
    },
    preset: state.preset,
    texture: state.texture,
    textureURL: state.textureURL,
  });
}

/**
 * Captures immediately, then queues durable writes. Pixel buffers remain typed;
 * JSON/base64 encoding is needed only when IndexedDB is unavailable.
 */
export async function saveDraft(state) {
  const snapshot = snapshotState(state);
  const savedAt = (lastSaveTime = Math.max(Date.now(), lastSaveTime + 1));
  const task = saveQueue.then(async () => {
    let indexedError;
    try {
      const db = await database();
      if (db) {
        await indexedDraft(db, {
          format: DRAFT_FORMAT,
          version: 2,
          savedAt,
          state: snapshot,
        });
        return;
      }
    } catch (error) {
      indexedError = error;
    }
    try {
      localStorage.setItem(
        LOCAL_KEY,
        JSON.stringify({
          format: LOCAL_FORMAT,
          version: 2,
          savedAt,
          project: serialiseProject(snapshot),
        }),
      );
    } catch (error) {
      throw new Error(
        "The browser could not save your draft. Save a project file to keep this composition.",
        { cause: indexedError || error },
      );
    }
  });
  saveQueue = task.catch(() => {});
  return task;
}

async function decodeDraft(record) {
  // Full schema validation is a load-time cost, never part of ordinary saves.
  const typedState =
    record?.format === DRAFT_FORMAT && record.version === 2
      ? record.state
      : null;
  const project = typedState
    ? serialiseProject(typedState)
    : record?.format === LOCAL_FORMAT && record.version === 2
      ? record.project
      : record;
  const parsed = parseProject(project);
  if (typedState) {
    // Keep full-precision brush fields and decoded pixels from IndexedDB.
    // Portable project files quantize fields; ordinary draft reloads do not.
    parsed.scene.layers.forEach((layer, index) => {
      const source = typedState.scene.layers[index];
      if (!source) return;
      for (const key of ["field", "mask"])
        if (validTypedField(source[key], false)) layer[key] = source[key];
      if (layer.type === "image" && validTypedField(source.imageData, true))
        layer.imageData = source.imageData;
    });
    if (validTypedField(typedState.texture, true))
      parsed.texture = typedState.texture;
  }
  return hydrateState(parsed);
}

function validTypedField(field, rgba) {
  if (
    !field ||
    !Number.isInteger(field.width) ||
    !Number.isInteger(field.height) ||
    field.width < 1 ||
    field.height < 1 ||
    field.width > 4096 ||
    field.height > 4096
  )
    return false;
  if (rgba)
    return (
      field.data instanceof Uint8ClampedArray &&
      field.data.length === field.width * field.height * 4
    );
  return (
    field.data instanceof Float32Array &&
    field.data.length === field.width * field.height &&
    field.data.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    )
  );
}

/** Returns null only when there is no stored draft; storage failures reject. */
export async function loadDraft() {
  await saveQueue;
  let indexedError;
  const candidates = [];
  try {
    const db = await database();
    if (db) {
      const record = await indexedDraft(db);
      if (record) candidates.push(record);
    }
  } catch (error) {
    indexedError = error;
  }
  try {
    const current = localStorage.getItem(LOCAL_KEY);
    if (current) candidates.push(JSON.parse(current));
    if (!candidates.length) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) candidates.push(JSON.parse(legacy));
    }
  } catch (error) {
    if (!candidates.length)
      throw new Error("The saved browser draft could not be opened.", {
        cause: error,
      });
  }
  if (candidates.length) {
    candidates.sort(
      (a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0),
    );
    let lastError;
    for (const candidate of candidates) {
      try {
        return await decodeDraft(candidate);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  if (indexedError)
    throw new Error("Browser draft storage is unavailable.", {
      cause: indexedError,
    });
  return null;
}
