/**
 * DOM-independent document editing, transactions and portable project files.
 *
 * History snapshots copy object properties but share immutable pixel buffers.
 * Replace a field/mask/imageData buffer before editing its contents (copy-on-write).
 * A begin/commit pair makes a pointer gesture a single undo step.
 */
export const PROJECT_LIMIT = 32 * 1024 * 1024;
export const MAX_LAYERS = 100;
const HISTORY_LIMIT = 64 * 1024 * 1024;
const HISTORY_STEPS = 60;
const FORMAT = "autostereogram-studio";
const CLIPBOARD_FORMAT = "autostereogram-clipboard";
const TYPES = new Set([
  "sphere",
  "ellipsoid",
  "torus",
  "star",
  "box",
  "cone",
  "pyramid",
  "cylinder",
  "text",
  "whale",
  "terrain",
  "image",
  "paint",
]);
export const defaultSettings = Object.freeze({
  strength: 45,
  repeat: 90,
  palette: "verdigris",
  textureStyle: "stipple",
  textureRepeat: "both",
  textureScale: 100,
  grain: 2,
  mode: "parallel",
  soften: 0,
  levels: 0,
  invert: false,
  dots: true,
  seed: 3271,
});
const LAYER_PROPERTIES = [
  "id",
  "type",
  "name",
  "x",
  "y",
  "size",
  "depth",
  "visible",
  "locked",
  "rotation",
  "scaleX",
  "scaleY",
  "tube",
  "aspect",
  "roundness",
  "variant",
  "flat",
  "profile",
  "operation",
  "bevel",
  "gradientAngle",
  "gradientFloor",
  "text",
  "fontFamily",
  "fit",
  "invert",
  "imageURL",
  "groupId",
];
let nextId = 0;
const newId = () =>
  `layer-${Date.now().toString(36)}-${++nextId}-${Math.random().toString(36).slice(2, 8)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback, min, max) =>
  typeof value === "number" && Number.isFinite(value)
    ? clamp(value, min, max)
    : fallback;

function remapGroups(layers) {
  const groups = new Map();
  for (const layer of layers) {
    if (!layer.groupId) continue;
    if (!groups.has(layer.groupId))
      groups.set(layer.groupId, `group-${newId()}`);
    layer.groupId = groups.get(layer.groupId);
  }
  return layers;
}

// Constrain the translation once for the complete selection. Independent
// per-object clamping would change spacing as the first member hits a bound.
function translateLayers(layers, dx, dy) {
  if (!layers.length) return false;
  dx = clamp(
    dx,
    Math.max(...layers.map((layer) => -0.5 - (layer.x ?? 0.5))),
    Math.min(...layers.map((layer) => 1.5 - (layer.x ?? 0.5))),
  );
  dy = clamp(
    dy,
    Math.max(...layers.map((layer) => -0.5 - (layer.y ?? 0.5))),
    Math.min(...layers.map((layer) => 1.5 - (layer.y ?? 0.5))),
  );
  if (!dx && !dy) return false;
  for (const layer of layers) {
    layer.x = (layer.x ?? 0.5) + dx;
    layer.y = (layer.y ?? 0.5) + dy;
  }
  return true;
}

function clone(value, copyBuffers = false, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (ArrayBuffer.isView(value)) {
    if (!copyBuffers) return value;
    const result =
      value instanceof DataView
        ? new DataView(
            value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            ),
          )
        : value.slice();
    seen.set(value, result);
    return result;
  }
  if (value instanceof ArrayBuffer) {
    const result = copyBuffers ? value.slice(0) : value;
    seen.set(value, result);
    return result;
  }
  // Browser image objects are immutable source assets, never document properties.
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    return value;
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    if (key !== "__proto__" && key !== "constructor" && key !== "prototype")
      result[key] = clone(value[key], copyBuffers, seen);
  }
  return result;
}

function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (
    ArrayBuffer.isView(a) ||
    ArrayBuffer.isView(b) ||
    a instanceof ArrayBuffer ||
    b instanceof ArrayBuffer
  )
    return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function memorySize(values) {
  const seen = new Set();
  const strings = new Set();
  function visit(value) {
    if (typeof value === "string") {
      if (strings.has(value)) return 0;
      strings.add(value);
      return value.length * 2;
    }
    if (!value || typeof value !== "object") return 8;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (ArrayBuffer.isView(value)) return 32 + visit(value.buffer);
    if (value instanceof ArrayBuffer) return value.byteLength;
    return (
      48 +
      Object.entries(value).reduce(
        (sum, [key, item]) => sum + key.length * 2 + visit(item),
        0,
      )
    );
  }
  return values.reduce((sum, value) => sum + visit(value), 0);
}

/**
 * Subscribers receive {kind, label, state, selectedIds, canUndo, canRedo, revision}.
 * Selection emits `selection`. Committed edits and undo/redo emit `scene`, then
 * `history`. `begin` does not emit: the caller owns its live gesture preview.
 */
export function createEditor(initialState) {
  let state = clone(initialState, true);
  state.document ??= { width: 1100, height: 660 };
  state.settings ??= { ...defaultSettings };
  state.scene ??= { name: "Untitled", layers: [] };
  let selected = [];
  let pending = null;
  let clipboard = null;
  let pasteCount = 0;
  let revision = 0;
  const past = [];
  const future = [];
  const listeners = new Set();
  const capture = (label) => ({
    state: clone(state),
    selectedIds: [...selected],
    label,
  });
  const validIds = (ids) => {
    const available = new Set(state.scene.layers.map((layer) => layer.id));
    return [...new Set(ids)].filter((id) => available.has(id));
  };
  function emit(kind, label = "") {
    const event = {
      kind,
      label,
      state,
      selectedIds: [...selected],
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      revision,
    };
    for (const listener of listeners) listener(event);
  }
  function changed(label) {
    revision++;
    emit("scene", label);
    emit("history", label);
  }
  function boundHistory() {
    while (past.length + future.length > HISTORY_STEPS)
      (past.length ? past : future).shift();
    while (
      (past.length || future.length) &&
      memorySize([state, ...past, ...future]) > HISTORY_LIMIT
    )
      (past.length ? past : future).shift();
  }
  function restore(snapshot) {
    state = clone(snapshot.state);
    selected = validIds(snapshot.selectedIds);
  }
  function setSelection(ids) {
    const next = validIds(
      ids == null ? [] : typeof ids === "string" ? [ids] : ids,
    );
    if (
      next.length === selected.length &&
      next.every((id, index) => id === selected[index])
    )
      return false;
    selected = next;
    emit("selection");
    return true;
  }
  function begin(label = "Edit") {
    if (pending) return false;
    pending = capture(label);
    return true;
  }
  function commit() {
    if (!pending) return false;
    const before = pending;
    pending = null;
    if (equal(before.state, state)) return false;
    selected = validIds(selected);
    past.push(before);
    future.length = 0;
    boundHistory();
    changed(before.label);
    return true;
  }
  function cancel() {
    if (!pending) return false;
    const before = pending;
    pending = null;
    restore(before);
    changed(before.label);
    return true;
  }
  function transact(label, fn) {
    const ownsTransaction = begin(label);
    try {
      const result = fn(state);
      if (ownsTransaction) commit();
      return result;
    } catch (error) {
      if (ownsTransaction) cancel();
      throw error;
    }
  }
  const selectedLayers = (editable = false) =>
    state.scene.layers.filter(
      (layer) => selected.includes(layer.id) && (!editable || !layer.locked),
    );
  function add(layers) {
    const incoming = Array.isArray(layers) ? layers : [layers];
    if (!incoming.length) return [];
    if (state.scene.layers.length + incoming.length > MAX_LAYERS)
      throw new RangeError(
        `A document can contain up to ${MAX_LAYERS} objects.`,
      );
    return transact("Add objects", () => {
      const ids = new Set(state.scene.layers.map((layer) => layer.id));
      const copies = incoming.map((layer) => {
        const copy = clone(layer, true);
        if (!copy.id || ids.has(copy.id)) copy.id = newId();
        ids.add(copy.id);
        return copy;
      });
      state.scene.layers.push(...copies);
      setSelection(copies.map((layer) => layer.id));
      return [...selected];
    });
  }
  function removeSelected() {
    const removable = new Set(selectedLayers(true).map((layer) => layer.id));
    if (!removable.size) return 0;
    transact("Delete objects", () => {
      state.scene.layers = state.scene.layers.filter(
        (layer) => !removable.has(layer.id),
      );
      setSelection(selected.filter((id) => !removable.has(id)));
    });
    return removable.size;
  }
  function copyLayers(layers) {
    if (!layers.length) return null;
    clipboard = clone(layers, true);
    pasteCount = 0;
    return {
      format: CLIPBOARD_FORMAT,
      version: 2,
      layers: clipboard.map((layer) => encodeLayer(layer, true)),
    };
  }
  function paste(payload) {
    let layers;
    if (payload !== undefined && payload !== null) {
      const parsed = readRaw(payload);
      if (
        parsed.format !== CLIPBOARD_FORMAT ||
        parsed.version !== 2 ||
        !Array.isArray(parsed.layers) ||
        parsed.layers.length > MAX_LAYERS
      )
        throw new Error("The clipboard does not contain studio objects.");
      layers = parsed.layers.map((layer) => parseLayer(layer));
      // Identical repeated system clipboard pastes should advance the offset.
      const encoded = JSON.stringify(parsed);
      if (encoded !== lastPastedPayload) pasteCount = 0;
      lastPastedPayload = encoded;
      clipboard = clone(layers, true);
    } else {
      if (!clipboard?.length) return [];
      layers = clone(clipboard, true);
    }
    if (!layers.length) return [];
    if (state.scene.layers.length + layers.length > MAX_LAYERS)
      throw new RangeError(
        `A document can contain up to ${MAX_LAYERS} objects.`,
      );
    const offset = 0.025 * ++pasteCount;
    layers = remapGroups(
      layers.map((layer) => ({
        ...layer,
        id: newId(),
        locked: false,
      })),
    );
    translateLayers(layers, offset, offset);
    return transact("Paste objects", () => add(layers));
  }
  let lastPastedPayload = null;
  return {
    get state() {
      return state;
    },
    get selectedIds() {
      return [...selected];
    },
    select(ids, { toggle = false, add: append = false } = {}) {
      const incoming = validIds(typeof ids === "string" ? [ids] : (ids ?? []));
      if (toggle) {
        const next = new Set(selected);
        for (const id of incoming)
          next.has(id) ? next.delete(id) : next.add(id);
        return setSelection([...next]);
      }
      return setSelection(append ? [...selected, ...incoming] : incoming);
    },
    setSelection,
    selectAll: () =>
      setSelection(
        state.scene.layers
          .filter((layer) => layer.visible !== false && !layer.locked)
          .map((layer) => layer.id),
      ),
    transact,
    begin,
    commit,
    cancel,
    add,
    removeSelected,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undo() {
      if (pending) commit();
      if (!past.length) return false;
      const previous = past.pop();
      future.push(capture(previous.label));
      restore(previous);
      changed(`Undo ${previous.label}`);
      return true;
    },
    redo() {
      if (pending) commit();
      if (!future.length) return false;
      const next = future.pop();
      past.push(capture(next.label));
      restore(next);
      changed(`Redo ${next.label}`);
      return true;
    },
    // offset:0 supports Alt-drag without moving clones before the gesture.
    duplicateSelected({ offset = 0.025 } = {}) {
      const originals = selectedLayers(true);
      if (!originals.length) return [];
      const copies = remapGroups(
        originals.map((layer) => ({
          ...clone(layer, true),
          id: newId(),
          name: `${layer.name || layer.type} copy`,
        })),
      );
      const delta = finite(offset, 0.025, -2, 2);
      translateLayers(copies, delta, delta);
      return transact("Duplicate objects", () => add(copies));
    },
    copy() {
      lastPastedPayload = null;
      return copyLayers(selectedLayers());
    },
    cut() {
      const payload = copyLayers(selectedLayers(true));
      if (payload) removeSelected();
      return payload;
    },
    paste,
    nudge(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy))
        return false;
      const layers = selectedLayers(true);
      if (!layers.length) return false;
      return transact("Move objects", () => translateLayers(layers, dx, dy));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function bytesToBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(""));
}

function base64ToBytes(encoded, expectedLength) {
  if (
    typeof encoded !== "string" ||
    encoded.length !== Math.ceil(expectedLength / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    throw new Error("A saved pixel field is incomplete or invalid.");
  let binary;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("A saved pixel field is invalid.");
  }
  if (binary.length !== expectedLength)
    throw new Error("A saved pixel field has the wrong dimensions.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function dimensions(field) {
  if (
    !field ||
    !Number.isInteger(field.width) ||
    !Number.isInteger(field.height) ||
    field.width < 1 ||
    field.height < 1 ||
    field.width > 4096 ||
    field.height > 4096
  )
    throw new Error("A saved pixel field has invalid dimensions.");
  return field.width * field.height;
}

function encodeField(field, rgba = false) {
  const length = dimensions(field) * (rgba ? 4 : 1);
  if (!field.data || field.data.length !== length)
    throw new Error("A pixel field has incomplete data.");
  const bytes = rgba
    ? new Uint8Array(field.data)
    : Uint8Array.from(field.data, (v) => Math.round(finite(v, 0, 0, 1) * 255));
  return {
    width: field.width,
    height: field.height,
    encoding: rgba ? "base64-rgba8" : "base64-u8",
    data: bytesToBase64(bytes),
  };
}

function parseField(field, rgba = false) {
  const length = dimensions(field) * (rgba ? 4 : 1);
  if (
    field.encoding !== undefined &&
    field.encoding !== (rgba ? "base64-rgba8" : "base64-u8")
  )
    throw new Error("A saved pixel field uses an unsupported encoding.");
  const bytes = base64ToBytes(field.data, length);
  return {
    width: field.width,
    height: field.height,
    data: rgba
      ? new Uint8ClampedArray(bytes)
      : Float32Array.from(bytes, (byte) => byte / 255),
  };
}

function validDataURL(url) {
  return (
    typeof url === "string" &&
    url.length < PROJECT_LIMIT &&
    /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
  );
}

function encodeLayer(layer, clipboard = false) {
  const result = {};
  for (const key of LAYER_PROPERTIES)
    if (layer[key] !== undefined) result[key] = layer[key];
  if (layer.field) result.field = encodeField(layer.field);
  if (layer.mask) result.mask = encodeField(layer.mask);
  if (layer.imageData && (clipboard || !layer.imageURL))
    result.imageData = encodeField(layer.imageData, true);
  return result;
}

function parseLayer(data) {
  if (!data || !TYPES.has(data.type))
    throw new Error("The project contains an unsupported object.");
  const layer = {
    id:
      typeof data.id === "string" && data.id.length <= 120 ? data.id : newId(),
    type: data.type,
    name: String(data.name || data.type).slice(0, 120),
    x: finite(data.x, 0.5, -0.5, 1.5),
    y: finite(data.y, 0.5, -0.5, 1.5),
    size: finite(data.size, 0.6, 0.02, 4),
    depth: finite(data.depth, 0.7, 0, 1),
    visible: data.visible !== false,
    locked: data.locked === true,
    rotation: finite(data.rotation, 0, -360, 360),
    scaleX: finite(data.scaleX, 1, 0.1, 5),
    scaleY: finite(data.scaleY, 1, 0.1, 5),
  };
  for (const [key, low, high] of [
    ["tube", 0.01, 0.95],
    ["aspect", 0.01, 20],
    ["roundness", 0, 1],
    ["bevel", 0, 0.12],
    ["gradientAngle", -360, 360],
    ["gradientFloor", 0, 1],
  ])
    if (data[key] !== undefined) layer[key] = finite(data[key], 0.3, low, high);
  if (data.variant === "arch") layer.variant = "arch";
  if (data.flat === true) layer.flat = true;
  if (["rounded", "flat", "gradient"].includes(data.profile))
    layer.profile = data.profile;
  if (["union", "subtract", "intersect"].includes(data.operation))
    layer.operation = data.operation;
  if (data.text !== undefined) layer.text = String(data.text).slice(0, 80);
  if (
    typeof data.groupId === "string" &&
    /^[A-Za-z0-9_-]{1,120}$/.test(data.groupId)
  )
    layer.groupId = data.groupId;
  if (data.fontFamily === "serif" || data.fontFamily === "sans")
    layer.fontFamily = data.fontFamily;
  if (data.fit === "cover" || data.fit === "contain") layer.fit = data.fit;
  if (data.invert === true) layer.invert = true;
  if (data.field) layer.field = parseField(data.field);
  if (data.mask) layer.mask = parseField(data.mask);
  if (data.imageData) layer.imageData = parseField(data.imageData, true);
  if (data.imageURL !== undefined) {
    if (!validDataURL(data.imageURL))
      throw new Error("A depth image is invalid.");
    layer.imageURL = data.imageURL;
  }
  if (layer.type === "image" && !layer.imageURL && !layer.imageData)
    throw new Error("A depth image is missing.");
  if (layer.type === "paint" && !layer.field)
    throw new Error("A painted object is missing its depth field.");
  return layer;
}

function readRaw(raw) {
  let text;
  try {
    text = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    throw new Error("This is not a valid project file.");
  }
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).byteLength > PROJECT_LIMIT
  )
    throw new Error("This project exceeds the 32 MB limit.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("This is not a valid project file.");
  }
}

/** Returns a JSON-compatible version 2 object; hydrated images are reloaded from imageURL. */
export function serialiseProject(state) {
  if (
    !Array.isArray(state.scene?.layers) ||
    state.scene.layers.length > MAX_LAYERS
  )
    throw new Error(`A project can contain up to ${MAX_LAYERS} objects.`);
  const project = {
    format: FORMAT,
    version: 2,
    document: {
      width: state.document?.width ?? 1100,
      height: state.document?.height ?? 660,
    },
    settings: { ...state.settings },
    scene: {
      name: state.scene.name,
      layers: state.scene.layers.map((layer) => encodeLayer(layer)),
    },
    preset: state.preset ?? "custom",
    textureURL: state.textureURL ?? null,
  };
  if (state.scene.paint) project.scene.paint = encodeField(state.scene.paint);
  if (state.texture && !state.textureURL)
    project.texture = encodeField(state.texture, true);
  if (
    new TextEncoder().encode(JSON.stringify(project)).byteLength > PROJECT_LIMIT
  )
    throw new Error("This project exceeds the 32 MB limit.");
  return project;
}

/** Synchronous validated parser. The UI hydrates imageURL / textureURL after loading. */
export function parseProject(input) {
  const raw = readRaw(input);
  if (
    !raw ||
    raw.format !== FORMAT ||
    ![1, 2].includes(raw.version) ||
    !Array.isArray(raw.scene?.layers) ||
    raw.scene.layers.length > MAX_LAYERS
  )
    throw new Error("This is not a supported Autostereogram studio project.");
  const settings = { ...defaultSettings };
  const source = raw.settings ?? {};
  for (const [key, low, high] of [
    ["strength", 0, 100],
    ["repeat", 40, 165],
    ["grain", 1, 5],
    ["soften", 0, 6],
    ["seed", 0, 4294967295],
    ["textureScale", 100, 200],
  ])
    settings[key] = Math.round(
      finite(source[key], defaultSettings[key], low, high),
    );
  settings.mode = source.mode === "cross" ? "cross" : "parallel";
  settings.textureStyle = ["stipple", "mineral", "paper", "organic"].includes(
    source.textureStyle,
  )
    ? source.textureStyle
    : "stipple";
  settings.textureRepeat =
    source.textureRepeat === "horizontal" ? "horizontal" : "both";
  settings.palette = [
    "verdigris",
    "mineral",
    "ochre",
    "ink",
    "custom",
  ].includes(source.palette)
    ? source.palette
    : "verdigris";
  settings.levels = [0, 2, 3, 5, 8, 16].includes(source.levels)
    ? source.levels
    : 0;
  settings.invert = source.invert === true;
  settings.dots = source.dots !== false;
  const layers = raw.scene.layers.map((data) => {
    const layer = parseLayer(data);
    // Version 1 fitted imported images into square object bounds. Version 2
    // defaults to the image's own aspect ratio, so preserve that old framing.
    if (
      raw.version === 1 &&
      layer.type === "image" &&
      data.aspect === undefined
    )
      layer.aspect = 1;
    return layer;
  });
  const seen = new Set();
  for (const layer of layers) {
    if (!layer.id || seen.has(layer.id)) layer.id = newId();
    seen.add(layer.id);
  }
  if (raw.scene.paint) {
    if (layers.length >= MAX_LAYERS)
      throw new Error("The saved paint would exceed the object limit.");
    const field = parseField(raw.scene.paint);
    const canvasWidth = finite(raw.document?.width, 1100, 320, 6000);
    const canvasHeight = finite(raw.document?.height, 660, 320, 6000);
    layers.push({
      id: newId(),
      type: "paint",
      name: "Paint",
      x: 0.5,
      y: 0.5,
      size: canvasWidth / Math.min(canvasWidth, canvasHeight),
      aspect: canvasHeight / canvasWidth,
      depth: 1,
      visible: true,
      locked: false,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      field,
    });
  }
  const width = Math.round(finite(raw.document?.width, 1100, 320, 6000));
  const height = Math.round(finite(raw.document?.height, 660, 320, 6000));
  if (width * height > 20000000)
    throw new Error("The saved canvas is too large.");
  let textureURL = null;
  if (raw.textureURL !== undefined && raw.textureURL !== null) {
    if (!validDataURL(raw.textureURL))
      throw new Error("The texture image is invalid.");
    textureURL = raw.textureURL;
  }
  const texture = raw.texture ? parseField(raw.texture, true) : null;
  if (settings.palette === "custom" && !textureURL && !texture)
    settings.palette = "verdigris";
  return {
    document: { width, height },
    settings,
    scene: { name: String(raw.scene.name || "Untitled").slice(0, 120), layers },
    preset: typeof raw.preset === "string" ? raw.preset.slice(0, 40) : "custom",
    textureURL,
    texture,
  };
}
