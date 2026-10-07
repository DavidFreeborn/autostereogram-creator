import { bindNumericRanges } from "./precision-controls.js";
import {
  createPreset,
  createLayer,
  layerBounds,
  layerLocalPoint,
  drawDepth,
} from "./scene.js";
import {
  createEditor,
  defaultSettings,
  serialiseProject,
  parseProject,
  MAX_LAYERS,
  PROJECT_LIMIT,
} from "./editor.js";
import { createViewport } from "./viewport.js";
import { createCreatorTools } from "./creator-tools.js";
import {
  readImage,
  hydrateState,
  downloadBlob,
  saveDraft,
  loadDraft,
} from "./files.js";

const $ = (id) => document.getElementById(id),
  clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const editor = createEditor({
  scene: createPreset("blank"),
  settings: { ...defaultSettings },
  document: { width: 1100, height: 660 },
  texture: null,
  textureURL: null,
});
const canvas = $("main-canvas"),
  ctx = canvas.getContext("2d"),
  stage = $("stage");
let view = "relief",
  tool = "select",
  frame = null,
  viewport,
  creatorTools,
  noticeTimer,
  inputEdit = null,
  stroke = null,
  textEdit = null;
let revision = 0,
  requestId = 0,
  assetId = 0,
  renderScheduled = false,
  pendingPreview = false,
  busyPreview = false,
  interactive = false,
  saveTimer;
let workerFailed = false,
  initialising = true,
  saveRevision = 0;
let documentVersion = 0,
  openSequence = 0;
const jobs = new Map(),
  assetKeys = new WeakMap(),
  registeredAssets = new Set();
const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});
const selectedLayers = () =>
  editor.state.scene.layers.filter((l) => editor.selectedIds.includes(l.id));
const editableLayers = () => selectedLayers().filter((l) => !l.locked);
const isTyping = (target) =>
  target?.matches?.("input,textarea,select,[contenteditable=true]");
const anyDialog = () => !!document.querySelector("dialog[open]");

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  $("notice-text").textContent = text;
  $("notice").hidden = false;
  $("notice").classList.toggle("error", error);
  $("notice").setAttribute("role", error ? "alert" : "status");
  if (!error) noticeTimer = setTimeout(() => ($("notice").hidden = true), 5500);
}
$("dismiss-notice").onclick = () => ($("notice").hidden = true);
function run(fn) {
  try {
    const result = fn();
    return result?.catch
      ? result.catch((error) => notice(error.message, true))
      : result;
  } catch (error) {
    notice(error.message, true);
  }
}
function assetKey(asset) {
  if (!asset) return null;
  let key = assetKeys.get(asset.data);
  if (!key) {
    key = `asset-${++assetId}`;
    assetKeys.set(asset.data, key);
  }
  return key;
}
function prepareAssets(scene, settings, texture) {
  const needed = new Map(),
    byURL = new Map();
  const register = (asset, url) => {
    if (!asset) return null;
    const dimensions = `${asset.width}:${asset.height}`;
    const variants = url ? byURL.get(url) : null;
    const key = variants?.get(dimensions) || assetKey(asset);
    if (url) {
      if (!variants) byURL.set(url, new Map([[dimensions, key]]));
      else variants.set(dimensions, key);
    }
    needed.set(key, asset);
    return key;
  };
  const prepared = {
    ...scene,
    layers: scene.layers.map((layer) => {
      const { image, imageURL, imageData, ...rest } = layer;
      if (layer.visible === false) return rest;
      const imageKey = imageData ? register(imageData, imageURL) : null;
      const rasterKey = (raster) =>
        raster ? `${assetKey(raster)}:${raster.revision || 0}` : "";
      return {
        ...rest,
        ...(imageKey ? { imageKey } : {}),
        _cacheKey: `${imageKey || ""}|${rasterKey(layer.field)}|${rasterKey(layer.mask)}`,
      };
    }),
  };
  const textureKey =
    settings.palette === "custom"
      ? register(texture, editor.state.textureURL)
      : null;
  if (
    [...needed.values()].reduce((n, a) => n + a.data.byteLength, 0) >
    128 * 1024 * 1024
  )
    throw new Error(
      "Decoded image assets exceed 128 MB. Use smaller images or remove an image layer.",
    );
  worker.postMessage({ kind: "prune", keys: [...needed.keys()] });
  for (const key of registeredAssets)
    if (!needed.has(key)) registeredAssets.delete(key);
  for (const [key, imageData] of needed)
    if (!registeredAssets.has(key)) {
      worker.postMessage({ kind: "asset", key, imageData });
      registeredAssets.add(key);
    }
  return { scene: prepared, textureKey };
}
function requestFrame({
  scene = editor.state.scene,
  settings = editor.state.settings,
  width,
  height,
  texture = editor.state.texture,
  output,
  diagnostics = false,
} = {}) {
  if (workerFailed)
    return Promise.reject(
      new Error(
        "Rendering stopped. Save your project, then reload the studio.",
      ),
    );
  const id = ++requestId;
  const assets = prepareAssets(scene, settings, texture);
  const payload = {
    id,
    kind: "frame",
    ...assets,
    settings: { ...settings },
    width,
    height,
    output,
    diagnostics,
  };
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker.postMessage(payload);
  });
}
worker.onmessage = ({ data }) => {
  const job = jobs.get(data.id);
  if (!job) return;
  jobs.delete(data.id);
  data.error ? job.reject(new Error(data.error)) : job.resolve(data);
};
worker.onerror = () => {
  workerFailed = true;
  for (const job of jobs.values())
    job.reject(
      new Error(
        "The rendering worker stopped. Save your project before reloading.",
      ),
    );
  jobs.clear();
  notice("The renderer stopped. Your document can still be saved.", true);
};
function scheduleRender(draft = false) {
  interactive = draft;
  revision++;
  pendingPreview = true;
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      renderPreview();
    });
  }
  viewport?.refresh();
}
async function renderPreview() {
  if (busyPreview || !pendingPreview) return;
  pendingPreview = false;
  busyPreview = true;
  const doc = editor.state.document,
    max = interactive ? 660 : 1100,
    scale = max / Math.max(doc.width, doc.height),
    width = Math.max(1, Math.round(doc.width * scale)),
    height = Math.max(1, Math.round(doc.height * scale));
  const aspect = doc.width / doc.height,
    startedRevision = revision,
    sceneIdentity = editor.state.scene;
  const delayed = setTimeout(() => ($("rendering").hidden = false), 200);
  try {
    const result = await requestFrame({
      width,
      height,
      scene: creatorTools?.scene || editor.state.scene,
    });
    if (
      (startedRevision === revision || interactive) &&
      editor.state.scene === sceneIdentity &&
      Math.abs(
        editor.state.document.width / editor.state.document.height - aspect,
      ) < 0.001
    ) {
      frame = result;
      drawFrame();
    }
  } catch (error) {
    notice(error.message, true);
  } finally {
    clearTimeout(delayed);
    $("rendering").hidden = true;
    busyPreview = false;
    if (pendingPreview) renderPreview();
  }
}
function drawFrame() {
  if (!frame) return;
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  if (view === "depth")
    drawDepth(canvas, frame.depth, frame.width, frame.height);
  else
    ctx.putImageData(
      new ImageData(
        view === "stereo" && !creatorTools?.revealing
          ? frame.pixels
          : frame.relief,
        frame.width,
        frame.height,
      ),
      0,
      0,
    );
  canvas.setAttribute(
    "aria-label",
    `${view === "stereo" ? "Autostereogram" : view === "relief" ? "Editable relief" : "Depth map"} of ${editor.state.scene.name}`,
  );
  updateStatus();
}
function setView(next) {
  if (next !== "relief" && tool !== "select") setTool("select");
  view = next;
  creatorTools?.onView(view);
  document.querySelector(".creation-toolbar").hidden = view === "stereo";
  $("viewing-toolbar").hidden = view !== "stereo";
  setPanel(view === "stereo" ? "pattern" : "scene");
  document.querySelectorAll("[data-view]").forEach((b) => {
    const active = b.dataset.view === view;
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
  });
  stage.setAttribute("aria-labelledby", `tab-${view}`);
  $("alignment").hidden = view !== "stereo" || !editor.state.settings.dots;
  viewport?.setView(view);
  drawFrame();
}
function setTool(next) {
  finishText();
  tool = next;
  document
    .querySelectorAll("button[data-tool]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.tool === tool)),
    );
  const painting = tool === "brush" || tool === "erase";
  $("tool-options").hidden = !painting;
  $("brush-depth-label").hidden = tool === "erase";
  $("eraser-scope-label").hidden = tool !== "erase";
  document.querySelector(".inspector").dataset.mode = tool;
  stage.dataset.tool = tool;
  viewport?.setTool(tool);
  if (painting || tool === "text") setView("relief");
  $("brush-cursor").hidden = true;
  setPanel(view === "stereo" ? "pattern" : "scene");
  updateStatus();
}
function setPanel(name) {
  const painting = tool === "brush" || tool === "erase";
  $("scene-panel").hidden = name !== "scene" || painting;
  $("pattern-panel").hidden = name !== "pattern";
  $("inspector-title").textContent =
    name === "pattern"
      ? "Texture"
      : painting
        ? tool === "brush"
          ? "Paint"
          : "Erase"
        : "Objects";
  $("finish-tool").hidden = !painting;
}
function setField(id, value) {
  const field = $(id);
  if (
    document.activeElement !== field ||
    field.matches("input[type=range],select")
  )
    field.value = value;
}
function mean(layers, key, fallback = 0) {
  return layers.length
    ? layers.reduce((s, l) => s + (l[key] ?? fallback), 0) / layers.length
    : fallback;
}
function rotationValue(layers) {
  if (layers.length < 2) return layers[0]?.rotation || 0;
  const angles = layers.map((l) => ((l.rotation || 0) * Math.PI) / 180),
    x = angles.reduce((sum, a) => sum + Math.cos(a), 0),
    y = angles.reduce((sum, a) => sum + Math.sin(a), 0),
    angle =
      Math.hypot(x, y) < 1e-8
        ? layers[0].rotation || 0
        : (Math.atan2(y, x) * 180) / Math.PI;
  return ((angle % 360) + 360) % 360;
}
function visualBounds(layers) {
  const doc = editor.state.document;
  const boxes = layers.map((layer) => {
    const b = layerBounds(layer, doc.width, doc.height),
      angle = (b.rotation * Math.PI) / 180,
      c = Math.abs(Math.cos(angle)),
      s = Math.abs(Math.sin(angle)),
      hx = b.halfWidth * doc.width,
      hy = b.halfHeight * doc.height;
    return {
      x: b.x,
      y: b.y,
      halfWidth: (c * hx + s * hy) / doc.width,
      halfHeight: (s * hx + c * hy) / doc.height,
    };
  });
  const left = Math.min(...boxes.map((b) => b.x - b.halfWidth)),
    right = Math.max(...boxes.map((b) => b.x + b.halfWidth)),
    top = Math.min(...boxes.map((b) => b.y - b.halfHeight)),
    bottom = Math.max(...boxes.map((b) => b.y + b.halfHeight));
  return {
    left,
    right,
    top,
    bottom,
    x: (left + right) / 2,
    y: (top + bottom) / 2,
  };
}
function moveLayers(layers, dx, dy) {
  dx = clamp(
    dx,
    Math.max(...layers.map((l) => -0.5 - l.x)),
    Math.min(...layers.map((l) => 1.5 - l.x)),
  );
  dy = clamp(
    dy,
    Math.max(...layers.map((l) => -0.5 - l.y)),
    Math.min(...layers.map((l) => 1.5 - l.y)),
  );
  for (const layer of layers) {
    layer.x += dx;
    layer.y += dy;
  }
}
function syncProperties() {
  const all = selectedLayers(),
    layers = all.filter((l) => !l.locked),
    first = all[0];
  $("object-properties").hidden = !all.length;
  if (!first) return;
  const multiple = all.length > 1;
  $("object-name").disabled = multiple || first.locked;
  setField("object-name", multiple ? `${all.length} objects` : first.name);
  $("text-properties").hidden = multiple || first.type !== "text";
  $("object-name-field").hidden = !multiple && first.type === "text";
  $("bevel-label").hidden = multiple || first.type !== "text";
  $("gradient-fields").hidden = first.profile !== "gradient";
  setField("object-operation", first.operation || "union");
  setField("object-bevel", (first.bevel ?? 0.015) * 100);
  $("object-bevel-value").textContent =
    `${Math.round((first.bevel ?? 0.015) * 1000) / 10}%`;
  setField("object-gradient-angle", first.gradientAngle || 0);
  setField("object-gradient-floor", (first.gradientFloor ?? 0.2) * 100);
  setField("object-text", first.text || "");
  setField("font-family", first.fontFamily || "serif");
  const base = layers.length ? layers : all;
  setField("object-depth", Math.round(mean(base, "depth", 0.7) * 100));
  $("object-depth-value").textContent =
    `${Math.round(mean(base, "depth", 0.7) * 100)}%`;
  for (const [key, factor] of [
    ["x", 100],
    ["y", 100],
    ["size", 100],
    ["rotation", 1],
  ])
    setField(
      `object-${key}`,
      Math.round(
        (key === "rotation" ? rotationValue(base) : mean(base, key, 0)) *
          factor *
          10,
      ) / 10,
    );
  setField("object-scale-x", Math.round(mean(base, "scaleX", 1) * 100) / 100);
  setField("object-scale-y", Math.round(mean(base, "scaleY", 1) * 100) / 100);
  setField(
    "object-profile",
    first.profile || (first.flat ? "flat" : "rounded"),
  );
  $("tube-label").hidden = multiple || first.type !== "torus";
  setField("object-tube", Math.round((first.tube || 0.32) * 100));
  $("object-properties")
    .querySelectorAll("input:not(#object-name),textarea,select,button")
    .forEach((el) => (el.disabled = !layers.length));
}
function renderLayers() {
  const host = $("layers");
  const focusId = document.activeElement?.closest?.(".layer")?.dataset.id;
  host.replaceChildren();
  if (!editor.state.scene.layers.length) {
    const p = document.createElement("p");
    p.className = "empty-layers";
    p.textContent = "";
    host.append(p);
  }
  for (const layer of [...editor.state.scene.layers].reverse()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `layer${layer.visible === false ? " hidden-layer" : ""}${layer.groupId ? " grouped" : ""}`;
    row.dataset.id = layer.id;
    row.setAttribute("role", "option");
    row.setAttribute(
      "aria-selected",
      String(editor.selectedIds.includes(layer.id)),
    );
    row.tabIndex =
      (editor.selectedIds.at(-1) || editor.state.scene.layers.at(-1)?.id) ===
      layer.id
        ? 0
        : -1;
    const button = document.createElement("span");
    button.className = "layer-name";
    button.textContent = layer.name;
    row.setAttribute(
      "aria-label",
      `${layer.name}${layer.locked ? ", locked" : ""}${layer.visible === false ? ", hidden" : ""}`,
    );
    row.onclick = (event) => {
      const ids = layerSelection(layer);
      editor.select(ids, event.shiftKey ? { toggle: true } : {});
      setView("relief");
    };
    row.ondblclick = () => {
      if (layer.type === "text" && !layer.locked) startText(layer);
      else if (!layer.locked) $("object-name").focus();
    };
    row.onkeydown = (event) => {
      if (
        !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const nodes = [...host.querySelectorAll(".layer")],
        i = nodes.indexOf(row),
        next =
          nodes[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? nodes.length - 1
                : clamp(
                    i + (event.key === "ArrowDown" ? 1 : -1),
                    0,
                    nodes.length - 1,
                  )
          ];
      const id = next.dataset.id;
      const destination = editor.state.scene.layers.find((l) => l.id === id);
      editor.select(
        layerSelection(destination),
        event.shiftKey ? { add: true } : {},
      );
      host.querySelector(`[data-id="${id}"]`)?.focus();
    };
    row.append(button);
    if (layer.locked || layer.visible === false) {
      const label = document.createElement("span");
      label.className = "layer-state";
      label.textContent = layer.locked ? "Locked" : "Hidden";
      row.append(label);
    }
    host.append(row);
  }
  host.setAttribute(
    "role",
    editor.state.scene.layers.length ? "listbox" : "group",
  );
  if (editor.state.scene.layers.length)
    host.setAttribute("aria-multiselectable", "true");
  else host.removeAttribute("aria-multiselectable");
  if (focusId)
    host
      .querySelector(`[data-id="${focusId}"]`)
      ?.focus({ preventScroll: true });
  const selected = selectedLayers();
  $("layer-actions").hidden = !selected.length;
  $("arrange").hidden = selected.length < 2;
  document
    .querySelectorAll("[data-command=lock]")
    .forEach(
      (b) =>
        (b.textContent =
          selected.length && selected.every((l) => l.locked)
            ? "Unlock"
            : "Lock"),
    );
  document
    .querySelectorAll("[data-command=visibility]")
    .forEach(
      (b) =>
        (b.textContent =
          selected.length && selected.every((l) => l.visible === false)
            ? "Show"
            : "Hide"),
    );
}
function layerSelection(layer) {
  return layer.groupId
    ? editor.state.scene.layers
        .filter((l) => l.groupId === layer.groupId)
        .map((l) => l.id)
    : [layer.id];
}
function refreshUI() {
  setField("document-name", editor.state.scene.name);
  const s = editor.state.settings;
  for (const key of [
    "palette",
    "strength",
    "repeat",
    "mode",
    "grain",
    "soften",
    "levels",
  ])
    setField(key, s[key]);
  for (const key of ["strength", "repeat", "soften"])
    $(`${key}-value`).textContent =
      `${s[key]}${key === "strength" ? "%" : " px"}`;
  $("invert").checked = s.invert;
  $("show-dots").checked = s.dots;
  $("alignment").hidden = view !== "stereo" || !s.dots;
  $("alignment").style.setProperty("--spacing", `${(s.repeat / 1100) * 100}%`);
  $("palette").querySelector("[value=custom]").hidden = !editor.state.texture;
  $("shuffle").disabled = s.palette === "custom";
  $("undo").disabled = !editor.canUndo();
  $("redo").disabled = !editor.canRedo();
  document
    .querySelectorAll("[data-command=undo]")
    .forEach((b) => (b.disabled = !editor.canUndo()));
  document
    .querySelectorAll("[data-command=redo]")
    .forEach((b) => (b.disabled = !editor.canRedo()));
  renderLayers();
  syncProperties();
  viewport?.refresh();
  updateStatus();
}
function updateStatus() {
  const selected = selectedLayers(),
    s = editor.state.settings;
  if (view === "stereo")
    $("context-status").textContent =
      s.mode === "parallel"
        ? "Parallel viewing · look through the image"
        : "Cross-eyed viewing · converge in front";
  else if (tool === "erase")
    $("context-status").textContent =
      $("eraser-scope").value === "all"
        ? "Erase · all visible unlocked surfaces"
        : "Erase · selected unlocked surfaces";
  else if (tool === "brush")
    $("context-status").textContent = "Brush · painted depth";
  else if (tool === "text")
    $("context-status").textContent = "Click to place text";
  else
    $("context-status").textContent = selected.length
      ? selected.length === 1
        ? `${selected[0].name}${selected[0].locked ? " · locked" : ""}`
        : `${selected.length} objects selected`
      : "Select an object to edit";
}
let draftState = "clean";
let backupRevision = -1;
async function flushDraft() {
  clearTimeout(saveTimer);
  if (initialising || draftState !== "pending") return;
  const rev = saveRevision;
  draftState = "saving";
  try {
    await saveDraft(editor.state);
    if (rev === saveRevision) {
      draftState = "clean";
      $("saved-indicator").textContent = "Saved locally";
    }
  } catch (error) {
    if (rev === saveRevision) {
      draftState = "failed";
      $("saved-indicator").textContent = "Draft not saved";
      notice(error.message, true);
    }
  }
}
function queueSave() {
  if (initialising) return;
  clearTimeout(saveTimer);
  saveRevision++;
  draftState = "pending";
  $("saved-indicator").textContent = "Unsaved edits";
  saveTimer = setTimeout(flushDraft, 400);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden && !initialising) {
    commitInput();
    finishText();
    flushDraft();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (initialising) return;
  commitInput();
  finishText();
  flushDraft();
  if (draftState !== "clean" && backupRevision !== saveRevision) {
    event.preventDefault();
    event.returnValue = "";
  }
});
editor.subscribe((event) => {
  if (event.kind === "history") {
    $("undo").disabled = !event.canUndo;
    $("redo").disabled = !event.canRedo;
    return;
  }
  refreshUI();
  if (event.kind === "scene") {
    scheduleRender(false);
    queueSave();
  }
});

function changeProperty(fn, label = "Edit properties") {
  if (!inputEdit) {
    editor.begin(label);
    inputEdit = true;
  }
  fn();
  syncProperties();
  scheduleRender(true);
}
function commitInput() {
  if (!inputEdit) return;
  inputEdit = null;
  editor.commit();
  scheduleRender(false);
}
function bindInput(id, fn, label) {
  const el = $(id);
  el.addEventListener("input", () =>
    run(() => changeProperty(() => fn(el), label)),
  );
  el.addEventListener("change", commitInput);
  el.addEventListener("blur", commitInput);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && inputEdit) {
      event.preventDefault();
      event.stopPropagation();
      cancelInput();
      el.blur();
    } else if (event.key === "Enter" && el.tagName !== "TEXTAREA") {
      event.preventDefault();
      commitInput();
      el.blur();
    }
  });
}
function cancelInput() {
  if (!inputEdit) return false;
  inputEdit = null;
  editor.cancel();
  refreshUI();
  scheduleRender(false);
  return true;
}
bindInput(
  "object-name",
  (el) => {
    const l = editableLayers()[0];
    if (l) l.name = el.value.slice(0, 60);
  },
  "Rename object",
);
bindInput(
  "object-text",
  (el) => {
    const l = editableLayers()[0];
    if (l) {
      l.text = el.value.slice(0, 80);
      l.name = l.text.trim().slice(0, 40) || "Text";
    }
  },
  "Edit text",
);
bindInput(
  "document-name",
  (el) => (editor.state.scene.name = el.value.slice(0, 60) || "Untitled"),
  "Rename document",
);
for (const [key, property, factor, min, max] of [
  ["depth", "depth", 0.01, 0.01, 1],
  ["x", "x", 0.01, -0.5, 1.5],
  ["y", "y", 0.01, -0.5, 1.5],
  ["size", "size", 0.01, 0.02, 4],
  ["rotation", "rotation", 1, -360, 360],
  ["scale-x", "scaleX", 1, 0.1, 5],
  ["scale-y", "scaleY", 1, 0.1, 5],
  ["tube", "tube", 0.01, 0.14, 0.48],
  ["bevel", "bevel", 0.01, 0, 0.12],
  ["gradient-angle", "gradientAngle", 1, -360, 360],
  ["gradient-floor", "gradientFloor", 0.01, 0, 1],
]) {
  bindInput(
    `object-${key}`,
    (el) => {
      if (el.value === "" || !Number.isFinite(el.valueAsNumber)) return;
      const layers = editableLayers(),
        value = clamp(el.valueAsNumber * factor, min, max),
        old =
          property === "rotation"
            ? rotationValue(layers)
            : mean(layers, property, property.startsWith("scale") ? 1 : 0);
      if (!layers.length) return;
      if (property === "x" || property === "y") {
        moveLayers(
          layers,
          property === "x" ? value - old : 0,
          property === "y" ? value - old : 0,
        );
        return;
      }
      if (
        layers.length > 1 &&
        (property === "rotation" || property === "size")
      ) {
        const bounds = visualBounds(layers),
          doc = editor.state.document,
          angle = ((value - old) * Math.PI) / 180,
          c = Math.cos(angle),
          s = Math.sin(angle);
        const ratio =
          property === "size"
            ? clamp(
                value / old,
                Math.max(...layers.map((l) => min / l.size)),
                Math.min(...layers.map((l) => max / l.size)),
              )
            : 1;
        const positions = layers.map((layer) => {
          const x = (layer.x - bounds.x) * doc.width,
            y = (layer.y - bounds.y) * doc.height;
          return property === "rotation"
            ? {
                x: bounds.x + (x * c - y * s) / doc.width,
                y: bounds.y + (x * s + y * c) / doc.height,
              }
            : {
                x: bounds.x + (x * ratio) / doc.width,
                y: bounds.y + (y * ratio) / doc.height,
              };
        });
        if (
          positions.some(
            (p) => p.x < -0.5 || p.x > 1.5 || p.y < -0.5 || p.y > 1.5,
          )
        )
          return;
        layers.forEach((layer, i) => {
          Object.assign(layer, positions[i]);
          if (property === "size") layer.size *= ratio;
          else {
            layer.rotation =
              ((((layer.rotation || 0) + value - old) % 360) + 360) % 360;
          }
        });
        return;
      }
      for (const l of layers) l[property] = value;
    },
    "Transform objects",
  );
}
for (const [id, key] of [
  ["font-family", "fontFamily"],
  ["object-profile", "profile"],
  ["object-operation", "operation"],
])
  $(id).onchange = () =>
    run(() =>
      editor.transact("Change surface", () => {
        for (const l of editableLayers()) l[key] = $(id).value;
      }),
    );
for (const key of ["strength", "repeat", "soften"])
  bindInput(
    key,
    (el) => {
      editor.state.settings[key] = Number(el.value);
      $(`${key}-value`).textContent =
        `${el.value}${key === "strength" ? "%" : " px"}`;
    },
    "Adjust rendering",
  );
for (const key of ["palette", "mode", "grain", "levels"])
  $(key).onchange = () =>
    run(() =>
      editor.transact("Change rendering", () => {
        editor.state.settings[key] = ["grain", "levels"].includes(key)
          ? Number($(key).value)
          : $(key).value;
      }),
    );
for (const [id, key] of [
  ["invert", "invert"],
  ["show-dots", "dots"],
])
  $(id).onchange = () =>
    editor.transact(
      "Change rendering",
      () => (editor.state.settings[key] = $(id).checked),
    );
$("shuffle").onclick = () =>
  editor.transact(
    "Resample pattern",
    () =>
      (editor.state.settings.seed = (editor.state.settings.seed + 1987) >>> 0),
  );
for (const key of ["size", "softness", "depth"])
  $(`brush-${key}`).oninput = () => {
    $(`brush-${key}-value`).textContent = `${$(`brush-${key}`).value}%`;
  };
$("eraser-scope").onchange = updateStatus;
function bindTabs(attribute, ids, activate) {
  document.querySelectorAll(`[${attribute}]`).forEach((button) => {
    button.onclick = () => activate(button.getAttribute(attribute));
    button.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const buttons = [...document.querySelectorAll(`[${attribute}]`)];
      let i = buttons.indexOf(button);
      i =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (i + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) %
              buttons.length;
      buttons[i].click();
      buttons[i].focus();
    };
  });
}
bindTabs("data-view", [], setView);
$("finish-tool").onclick = () => setTool("select");
$("add-text").onclick = () => {
  closeMenus();
  run(() => addObject("text"));
};
document
  .querySelectorAll("button[data-tool]")
  .forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

function addObject(type, point = { x: 0.5, y: 0.5 }) {
  const layer = createLayer(type);
  layer.x = clamp(point.x, -0.5, 1.5);
  layer.y = clamp(point.y, -0.5, 1.5);
  if (type === "text") {
    layer.text = "Text";
    layer.name = "Text";
    layer.size = 1;
  }
  finishText();
  commitInput();
  if (type === "text") editor.begin("Add text");
  try {
    editor.add([layer]);
  } catch (error) {
    if (type === "text") editor.cancel();
    throw error;
  }
  setView("relief");
  setPanel("scene");
  setTool("select");
  if (type === "text")
    startText(
      editor.state.scene.layers.find((l) => l.id === editor.selectedIds[0]),
      true,
    );
}
document.querySelectorAll("[data-shape]").forEach(
  (b) =>
    (b.onclick = () =>
      run(() => {
        addObject(b.dataset.shape);
        closeMenus();
      })),
);
function startText(layer, creating = false) {
  if (layer.locked) return;
  finishText();
  editor.setSelection([layer.id]);
  setView("relief");
  editor.begin("Edit text");
  textEdit = { id: layer.id, creating };
  const box = layerBounds(
      layer,
      editor.state.document.width,
      editor.state.document.height,
    ),
    el = $("inline-text");
  el.value = layer.text || "";
  el.style.left = `${(box.x - box.halfWidth) * 100}%`;
  el.style.top = `${(box.y - box.halfHeight) * 100}%`;
  el.style.width = `${box.width * 100}%`;
  el.style.height = `${box.height * 100}%`;
  el.style.transform = `rotate(${layer.rotation || 0}deg)`;
  el.style.fontFamily =
    layer.fontFamily === "sans" ? "Arial, sans-serif" : "Georgia, serif";
  el.style.fontSize = `${clamp(box.height * $("artboard").clientHeight * 0.65, 16, 95)}px`;
  el.hidden = false;
  el.focus();
  el.select();
}
function finishText(cancel = false) {
  if (!textEdit) return;
  if (textEdit.creating && !$("inline-text").value.trim()) cancel = true;
  textEdit = null;
  $("inline-text").hidden = true;
  cancel ? editor.cancel() : editor.commit();
  scheduleRender(false);
}
$("inline-text").oninput = () => {
  if (!textEdit) return;
  const layer = editor.state.scene.layers.find((l) => l.id === textEdit.id);
  if (layer) {
    layer.text = $("inline-text").value.replace(/\n/g, " ").slice(0, 80);
    layer.name = layer.text.trim().slice(0, 40) || "Text";
    scheduleRender(true);
  }
};
$("inline-text").onkeydown = (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.stopPropagation();
    finishText(true);
    stage.focus();
  } else if (event.key === "Enter") {
    event.preventDefault();
    finishText();
    stage.focus();
  }
};
$("inline-text").onblur = () => finishText();

function paintLayer(field = null) {
  const doc = editor.state.document,
    max = 700,
    scale = max / Math.max(doc.width, doc.height),
    width = Math.round(doc.width * scale),
    height = Math.round(doc.height * scale);
  const fullSize = doc.width / Math.min(doc.width, doc.height),
    size = Math.min(4, fullSize);
  return {
    ...createLayer("paint"),
    name: "Paint",
    x: 0.5,
    y: 0.5,
    size,
    scaleX: fullSize / size,
    scaleY: fullSize / size,
    aspect: doc.height / doc.width,
    depth: 1,
    field: field || { width, height, data: new Float32Array(width * height) },
  };
}
function writable(layer, key, width = 256, height = 256) {
  const mark = `${layer.id}:${key}`;
  if (stroke.copied.has(mark)) return layer[key];
  const previous = layer[key];
  layer[key] = previous
    ? { ...previous, data: previous.data.slice() }
    : { width, height, data: new Float32Array(width * height) };
  stroke.copied.add(mark);
  return layer[key];
}
function stampField(field, u, v, rx, ry, action, depth, pressure = 1) {
  const cx = u * field.width,
    cy = v * field.height,
    fx = Math.max(0.5, rx * field.width),
    fy = Math.max(0.5, ry * field.height);
  const softness = Number($("brush-softness").value) / 100,
    inner = 1 - softness;
  for (
    let y = Math.max(0, Math.floor(cy - fy));
    y < Math.min(field.height, Math.ceil(cy + fy));
    y++
  )
    for (
      let x = Math.max(0, Math.floor(cx - fx));
      x < Math.min(field.width, Math.ceil(cx + fx));
      x++
    ) {
      const d = Math.hypot((x + 0.5 - cx) / fx, (y + 0.5 - cy) / fy);
      if (d >= 1) continue;
      const t = d <= inner ? 1 : (1 - d) / Math.max(0.001, softness),
        a = t * t * (3 - 2 * t) * pressure,
        i = y * field.width + x;
      field.data[i] =
        action === "erase"
          ? field.data[i] + (1 - field.data[i]) * a
          : action === "restore"
            ? field.data[i] * (1 - a)
            : Math.max(field.data[i], depth * a);
    }
  field.revision = (field.revision || 0) + 1;
}
function applyStroke(point, event) {
  if (!stroke) return;
  const doc = editor.state.document,
    radius =
      (Number($("brush-size").value) / 200) * Math.min(doc.width, doc.height),
    pressure =
      event.pointerType === "pen" ? clamp(event.pressure || 0.5, 0.05, 1) : 1;
  for (const layer of stroke.layers) {
    const { u, v } = layerLocalPoint(
        layer,
        point.x,
        point.y,
        doc.width,
        doc.height,
      ),
      bounds = layerBounds(layer, doc.width, doc.height),
      rx = radius / (bounds.width * doc.width),
      ry = radius / (bounds.height * doc.height);
    if (u + rx < 0 || u - rx > 1 || v + ry < 0 || v - ry > 1) continue;
    if (stroke.tool === "erase") {
      const longest = 384,
        ratio = (bounds.height * doc.height) / (bounds.width * doc.width),
        w = Math.max(32, Math.round(longest / Math.max(1, ratio))),
        h = Math.max(32, Math.round(longest * Math.min(1, ratio)));
      stampField(
        writable(layer, "mask", w, h),
        u,
        v,
        rx,
        ry,
        "erase",
        0,
        pressure,
      );
    } else {
      stampField(
        writable(layer, "field"),
        u,
        v,
        rx,
        ry,
        "paint",
        Number($("brush-depth").value) / 100,
        pressure,
      );
      if (layer.mask)
        stampField(
          writable(layer, "mask"),
          u,
          v,
          rx,
          ry,
          "restore",
          0,
          pressure,
        );
    }
  }
}
function strokeStart(point, event) {
  editor.begin(tool === "erase" ? "Erase surfaces" : "Paint depth");
  stroke = { tool, copied: new Set(), point, layers: [] };
  if (tool === "brush") {
    let layer = editableLayers().find(
      (l) => l.type === "paint" && l.visible !== false,
    );
    if (!layer) {
      if (editor.state.scene.layers.length >= MAX_LAYERS) {
        editor.cancel();
        stroke = null;
        notice("The document has reached its 100-layer limit.", true);
        return;
      }
      layer = paintLayer();
      editor.state.scene.layers.push(layer);
      editor.setSelection([layer.id]);
    }
    stroke.layers = [layer];
  } else
    stroke.layers = (
      $("eraser-scope").value === "selection"
        ? selectedLayers()
        : editor.state.scene.layers
    ).filter((l) => !l.locked && l.visible !== false);
  applyStroke(point, event);
  scheduleRender(true);
}
function strokeMove(point, event) {
  if (!stroke) return;
  const doc = editor.state.document,
    r = (Number($("brush-size").value) / 200) * Math.min(doc.width, doc.height),
    distance = Math.hypot(
      (point.x - stroke.point.x) * doc.width,
      (point.y - stroke.point.y) * doc.height,
    ),
    steps = clamp(Math.ceil(distance / Math.max(1, r * 0.22)), 1, 80),
    old = stroke.point;
  for (let i = 1; i <= steps; i++)
    applyStroke(
      {
        x: old.x + ((point.x - old.x) * i) / steps,
        y: old.y + ((point.y - old.y) * i) / steps,
      },
      event,
    );
  stroke.point = point;
  scheduleRender(true);
}
function strokeEnd({ cancelled = false } = {}) {
  if (!stroke) return;
  stroke = null;
  if (!cancelled) editor.commit();
  scheduleRender(false);
}
viewport = createViewport({
  editor,
  stage,
  artboard: $("artboard"),
  canvas,
  overlay: $("overlay"),
  onRender: scheduleRender,
  snapEnabled: () => $("snap-alignment").checked,
  onTextEdit: startText,
  onStrokeStart: strokeStart,
  onStrokeMove: strokeMove,
  onStrokeEnd: strokeEnd,
  onRequestEdit: () => setView("relief"),
  onStatus: (text) => ($("context-status").textContent = text),
  onZoom: (z) => ($("zoom-value").textContent = `${Math.round(z * 100)}%`),
});
stage.addEventListener(
  "pointerdown",
  (event) => {
    if (
      tool !== "text" ||
      event.button !== 0 ||
      event.isPrimary === false ||
      event.target === $("inline-text")
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = viewport.pointFromClient(event.clientX, event.clientY);
    run(() => addObject("text", point));
  },
  true,
);
stage.addEventListener("pointermove", (event) => {
  if (tool !== "brush" && tool !== "erase") return;
  const r = stage.getBoundingClientRect(),
    size =
      (Number($("brush-size").value) / 100) *
      Math.min($("artboard").clientWidth, $("artboard").clientHeight),
    c = $("brush-cursor");
  c.hidden = false;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  c.style.left = `${event.clientX - r.left}px`;
  c.style.top = `${event.clientY - r.top}px`;
});
stage.addEventListener("pointerleave", () => ($("brush-cursor").hidden = true));
$("zoom-in").onclick = () => viewport.zoomBy(1.25);
$("zoom-out").onclick = () => viewport.zoomBy(0.8);
$("fit").onclick = () => viewport.fit();
$("zoom-value").onclick = () => viewport.fit();

function group() {
  const layers = editableLayers();
  if (layers.length < 2) return;
  editor.transact("Group objects", () => {
    const id = `group-${Date.now().toString(36)}`;
    for (const l of layers) l.groupId = id;
  });
}
function ungroup() {
  editor.transact("Ungroup objects", () => {
    for (const l of editableLayers()) delete l.groupId;
  });
}
function reorder(direction) {
  editor.transact("Reorder layers", () => {
    const array = editor.state.scene.layers,
      ids = new Set(editor.selectedIds);
    if (direction > 0) {
      for (let i = array.length - 2; i >= 0; i--)
        if (
          ids.has(array[i].id) &&
          !array[i].locked &&
          !ids.has(array[i + 1].id)
        )
          [array[i], array[i + 1]] = [array[i + 1], array[i]];
    } else
      for (let i = 1; i < array.length; i++)
        if (
          ids.has(array[i].id) &&
          !array[i].locked &&
          !ids.has(array[i - 1].id)
        )
          [array[i], array[i - 1]] = [array[i - 1], array[i]];
  });
}
function align(kind) {
  const layers = editableLayers();
  if (layers.length < 2) return;
  const units = new Map(),
    bounds = visualBounds(layers);
  for (const layer of layers) {
    const key = layer.groupId ? `group:${layer.groupId}` : `layer:${layer.id}`;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(layer);
  }
  if (units.size < 2) return;
  editor.transact("Align objects", () => {
    for (const members of units.values()) {
      const b = visualBounds(members);
      moveLayers(
        members,
        kind === "left"
          ? bounds.left - b.left
          : kind === "right"
            ? bounds.right - b.right
            : kind === "center"
              ? bounds.x - b.x
              : 0,
        kind === "top"
          ? bounds.top - b.top
          : kind === "bottom"
            ? bounds.bottom - b.bottom
            : kind === "middle"
              ? bounds.y - b.y
              : 0,
      );
    }
  });
}
document
  .querySelectorAll("[data-align]")
  .forEach((b) => (b.onclick = () => align(b.dataset.align)));
async function rasterize() {
  const layers = editableLayers();
  if (!layers.length) return;
  const singleOperation =
    layers.length === 1 ? layers[0].operation || "union" : "union";
  if (
    layers.length > 1 &&
    layers.some((l) => l.operation && l.operation !== "union") &&
    layers.length !==
      editor.state.scene.layers.filter((l) => l.visible !== false).length
  )
    throw new Error(
      "Select the whole design to combine carved objects into paint.",
    );
  const rev = revision,
    selection = editor.selectedIds.join("|"),
    doc = editor.state.document,
    scale = 700 / Math.max(doc.width, doc.height),
    result = await requestFrame({
      scene: {
        layers:
          layers.length === 1
            ? layers.map((l) => ({ ...l, operation: "union" }))
            : layers,
      },
      settings: { ...defaultSettings, soften: 0, strength: 0 },
      width: Math.round(doc.width * scale),
      height: Math.round(doc.height * scale),
      output: "depth",
    });
  if (rev !== revision || selection !== editor.selectedIds.join("|"))
    throw new Error("The document changed during conversion. Try again.");
  const layer = paintLayer({
      width: result.width,
      height: result.height,
      data: result.depth,
    }),
    ids = new Set(layers.map((l) => l.id));
  layer.operation = singleOperation;
  editor.transact("Convert selection to paint", () => {
    editor.state.scene.layers = editor.state.scene.layers.filter(
      (l) => !ids.has(l.id),
    );
    editor.state.scene.layers.push(layer);
    editor.setSelection([layer.id]);
  });
  setTool("brush");
}
async function copyClipboard(cut = false) {
  const payload = cut ? editor.cut() : editor.copy();
  if (!payload?.layers?.length) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload));
  } catch {}
  return payload;
}
async function pasteClipboard() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {}
  if (text) await pasteContent(text);
  else editor.paste();
  setView("relief");
}
async function pasteContent(text) {
  if (text.trimStart().startsWith("{")) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {}
    if (payload?.format === "autostereogram-clipboard") {
      editor.paste(payload);
      return;
    }
  }
  if (text.trim()) {
    const layer = createLayer("text");
    layer.text = text.replace(/\s+/g, " ").slice(0, 80);
    layer.name = layer.text.slice(0, 40);
    editor.add([layer]);
  } else editor.paste();
}
document.addEventListener("copy", (event) => {
  if (isTyping(event.target) || anyDialog()) return;
  const payload = editor.copy();
  if (!payload?.layers?.length) return;
  event.clipboardData.setData("text/plain", JSON.stringify(payload));
  event.preventDefault();
});
document.addEventListener("cut", (event) => {
  if (isTyping(event.target) || anyDialog()) return;
  const payload = editor.cut();
  if (!payload?.layers?.length) return;
  event.clipboardData.setData("text/plain", JSON.stringify(payload));
  event.preventDefault();
});
document.addEventListener("paste", (event) => {
  if (isTyping(event.target) || anyDialog()) return;
  const image = [...event.clipboardData.items].find((i) =>
    i.type.startsWith("image/"),
  );
  event.preventDefault();
  if (image) run(() => creatorTools.openImage(image.getAsFile()));
  else run(() => pasteContent(event.clipboardData.getData("text/plain")));
  setView("relief");
});
function closeMenus() {
  document.querySelectorAll(".menu[open]").forEach((el) => (el.open = false));
}
async function command(name) {
  const cancelled = viewport?.cancel();
  if (cancelled && name === "undo") return;
  commitInput();
  finishText();
  closeMenus();
  if (name === "new" || name === "examples") {
    const examples = name === "examples";
    $("starter-designs").hidden = !examples;
    $("new-title").textContent = examples ? "Examples" : "New document";
    $("new-dialog").classList.toggle("examples-open", examples);
    $("preset").value = examples ? "typography" : "blank";
    $("new-dialog").showModal();
  }
  if (name === "open") $("project-file").click();
  if (name === "save") saveProject();
  if (name === "import-depth") $("depth-file").click();
  if (name === "import-texture") $("texture-file").click();
  if (name === "document") {
    $("document-width").setCustomValidity("");
    $("document-width").value = editor.state.document.width;
    $("document-height").value = editor.state.document.height;
    $("document-dialog").showModal();
  }
  if (name === "undo") editor.undo();
  if (name === "redo") editor.redo();
  if (name === "copy") await copyClipboard();
  if (name === "cut") await copyClipboard(true);
  if (name === "paste") await pasteClipboard();
  if (name === "duplicate") editor.duplicateSelected();
  if (name === "delete") editor.removeSelected();
  if (name === "select-all") editor.selectAll();
  if (name === "group") group();
  if (name === "ungroup") ungroup();
  if (name === "rasterize") await rasterize();
  if (name === "restore")
    editor.transact("Restore erased areas", () => {
      for (const l of editableLayers()) delete l.mask;
    });
  if (name === "lock") {
    const layers = selectedLayers(),
      value = !layers.every((l) => l.locked);
    editor.transact(value ? "Lock objects" : "Unlock objects", () =>
      layers.forEach((l) => (l.locked = value)),
    );
  }
  if (name === "visibility") {
    const layers = selectedLayers(),
      visible = layers.every((l) => l.visible === false);
    editor.transact("Change visibility", () =>
      layers.forEach((l) => (l.visible = visible)),
    );
  }
  if (name === "up") reorder(1);
  if (name === "down") reorder(-1);
}
document
  .querySelectorAll("[data-command]")
  .forEach((b) => (b.onclick = () => run(() => command(b.dataset.command))));
$("undo").onclick = () => run(() => command("undo"));
$("redo").onclick = () => run(() => command("redo"));

$("import-image").onclick = () => {
  closeMenus();
  command("import-depth");
};
$("help").onclick = () => $("help-dialog").showModal();
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".menu")) closeMenus();
});
document.querySelectorAll(".menu").forEach((menu) =>
  menu.addEventListener("toggle", () => {
    if (menu.open)
      document.querySelectorAll(".menu").forEach((other) => {
        if (other !== menu) other.open = false;
      });
  }),
);
document.addEventListener("keydown", (event) => {
  if (
    $("document-dialog").open &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    run(() => command("save"));
    return;
  }
  if (event.defaultPrevented || anyDialog() || event.isComposing) return;
  const mod = event.ctrlKey || event.metaKey,
    key = event.key.toLowerCase();
  if (mod && ["s", "o", "n"].includes(key)) {
    event.preventDefault();
    run(() => command({ s: "save", o: "open", n: "new" }[key]));
    return;
  }
  if (isTyping(event.target)) {
    const textInput = event.target.matches(
      "textarea,[contenteditable=true],input:not([type=range]):not([type=checkbox])",
    );
    if (textInput || !mod || !["z", "y"].includes(key)) return;
  }
  const shortcuts = {
    z: event.shiftKey ? "redo" : "undo",
    y: "redo",
    a: "select-all",
    d: "duplicate",
    g: event.shiftKey ? "ungroup" : "group",
    s: "save",
    o: "open",
    n: "new",
  };
  if (mod && shortcuts[key]) {
    event.preventDefault();
    run(() => command(shortcuts[key]));
    return;
  }
  if (mod) return;
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    viewport.cancel();
    editor.removeSelected();
  } else if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    viewport.cancel();
    const n = event.shiftKey ? 10 : 1,
      doc = editor.state.document;
    editor.nudge(
      event.key === "ArrowLeft"
        ? -n / doc.width
        : event.key === "ArrowRight"
          ? n / doc.width
          : 0,
      event.key === "ArrowUp"
        ? -n / doc.height
        : event.key === "ArrowDown"
          ? n / doc.height
          : 0,
    );
  } else if (event.key === "Escape") {
    if (stroke) {
      stroke = null;
      editor.cancel();
      scheduleRender(false);
    }
    viewport.cancel();
    editor.setSelection([]);
    closeMenus();
    setTool("select");
  } else if (event.key === "Enter") {
    const l = editableLayers()[0];
    if (
      l?.type === "text" &&
      (event.target === document.body || event.target.closest?.(".layer"))
    ) {
      event.preventDefault();
      startText(l);
    }
  } else if (key === "t") {
    event.preventDefault();
    run(() => addObject("text"));
  } else if ({ v: "select", b: "brush", e: "erase", h: "pan" }[key]) {
    event.preventDefault();
    setTool({ v: "select", b: "brush", e: "erase", h: "pan" }[key]);
  } else if (key === "0") viewport.fit();
});

async function importDepth(file) {
  if (editor.state.scene.layers.length >= MAX_LAYERS)
    throw new Error("The document has reached its 100-layer limit.");
  const version = documentVersion,
    state = editor.state;
  const asset = await readImage(file),
    layer = createLayer("image");
  if (version !== documentVersion || editor.state !== state)
    throw new Error(
      "Image import cancelled because another document was opened.",
    );
  Object.assign(layer, asset);
  layer.depth = 1;
  const doc = editor.state.document,
    unit = Math.min(doc.width, doc.height),
    ratio = clamp(asset.imageData.height / asset.imageData.width, 0.02, 20);
  layer.aspect = ratio;
  const fitSize =
    0.85 * Math.min(doc.width / unit, doc.height / (ratio * unit));
  layer.size = clamp(fitSize, 0.02, 4);
  layer.scaleX = layer.scaleY = fitSize / layer.size;
  editor.add([layer]);
  setTool("select");
  setView("relief");
  setPanel("scene");
}
$("depth-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (file) await run(() => creatorTools.openImage(file));
  event.target.value = "";
};
$("texture-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (file)
    await run(async () => {
      const version = documentVersion,
        state = editor.state;
      const asset = await readImage(file);
      if (version !== documentVersion || editor.state !== state)
        throw new Error(
          "Texture import cancelled because another document was opened.",
        );
      editor.transact("Import texture", () => {
        editor.state.texture = asset.imageData;
        editor.state.textureURL = asset.imageURL;
        editor.state.settings.palette = "custom";
      });
      setPanel("pattern");
      setView("stereo");
    });
  event.target.value = "";
};
stage.addEventListener("dragover", (event) => {
  if (event.dataTransfer.types.includes("Files")) event.preventDefault();
});
stage.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (file)
    run(() =>
      file.name.endsWith(".json")
        ? openProject(file)
        : creatorTools.openImage(file),
    );
});
function replaceDocument(next, label) {
  creatorTools?.reset();
  documentVersion++;
  editor.transact(label, (state) => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
    editor.setSelection([]);
  });
  viewport.fit();
  setTool("select");
  setView("relief");
}
function saveProject() {
  const json = JSON.stringify(serialiseProject(editor.state)),
    blob = new Blob([json], { type: "application/json" });
  if (blob.size > PROJECT_LIMIT)
    throw new Error(
      "The project exceeds 32 MB. Remove an imported image before saving.",
    );
  downloadBlob(blob, `${safeName()}-project.json`);
  backupRevision = saveRevision;
  notice("Editable project saved.");
}
async function openProject(file) {
  if (file.size > PROJECT_LIMIT)
    throw new Error("Projects must be smaller than 32 MB.");
  const sequence = ++openSequence,
    version = documentVersion,
    rev = revision;
  const state = await hydrateState(parseProject(await file.text()));
  if (
    sequence !== openSequence ||
    version !== documentVersion ||
    revision !== rev
  )
    throw new Error(
      "Opening was cancelled because the document changed while loading.",
    );
  replaceDocument(state, "Open project");
  notice("Project opened.");
}
$("project-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (file) await run(() => openProject(file));
  event.target.value = "";
};
$("create-document").onclick = (event) => {
  event.preventDefault();
  const [width, height] = $("new-aspect").value.split(",").map(Number);
  replaceDocument(
    {
      scene: createPreset($("preset").value),
      settings: { ...defaultSettings },
      document: { width, height },
      texture: null,
      textureURL: null,
    },
    "New composition",
  );
  $("new-dialog").close();
};
$("resize-document").onclick = (event) => {
  event.preventDefault();
  const width = Number($("document-width").value),
    height = Number($("document-height").value);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 320 ||
    height < 320 ||
    width > 6000 ||
    height > 6000 ||
    width * height > 20e6
  ) {
    $("document-width").setCustomValidity(
      "Use dimensions from 320 to 6,000 px, with at most 20 million pixels.",
    );
    $("document-width").reportValidity();
    return;
  }
  editor.transact(
    "Resize canvas",
    (state) => (state.document = { width, height }),
  );
  viewport.fit();
  $("document-dialog").close();
};
for (const id of ["document-width", "document-height"])
  $(id).addEventListener("input", () =>
    $("document-width").setCustomValidity(""),
  );
function safeName() {
  return (
    (editor.state.scene.name || "autostereogram")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "autostereogram"
  );
}
function exportDimensions() {
  const width = Number($("export-width").value),
    doc = editor.state.document,
    height = Math.round((width * doc.height) / doc.width),
    strip =
      $("export-kind").value === "stereo" && $("export-dots").checked
        ? Math.round((width * 35) / 1100)
        : 0;
  $("export-dots").disabled = $("export-kind").value !== "stereo";
  $("export-dimensions").textContent =
    `${width.toLocaleString()} × ${(height + strip).toLocaleString()} px`;
  return { width, height, strip };
}
let exportSequence = 0;
function exportBusy(busy) {
  for (const id of [
    "download-image",
    "export-width",
    "export-kind",
    "export-dots",
  ])
    $(id).disabled = busy;
  if (!busy) exportDimensions();
}
$("export-dialog").addEventListener("close", () => {
  exportSequence++;
  exportBusy(false);
});
$("export").onclick = () => {
  commitInput();
  finishText();
  $("export-kind").value = view;
  $("export-status").textContent = "";
  exportDimensions();
  $("export-dialog").showModal();
};
$("export-kind").onchange = exportDimensions;
$("export-width").oninput = exportDimensions;
$("export-dots").onchange = exportDimensions;
$("download-image").onclick = () =>
  run(async () => {
    const { width, height, strip } = exportDimensions();
    if (
      !Number.isInteger(width) ||
      width < 320 ||
      width > 6000 ||
      height < 1 ||
      height > 6000 ||
      width * height > 20e6
    ) {
      $("export-status").textContent =
        "Use up to 6,000 px per side and 20 million pixels.";
      return;
    }
    const sequence = ++exportSequence;
    exportBusy(true);
    $("export-status").textContent = "Rendering full resolution…";
    const kind = $("export-kind").value,
      settings = { ...editor.state.settings },
      name = safeName();
    try {
      const result = await requestFrame({
          width,
          height,
          settings,
          output: kind,
        }),
        output = document.createElement("canvas");
      if (sequence !== exportSequence || !$("export-dialog").open) return;
      output.width = width;
      output.height = height + strip;
      const c = output.getContext("2d");
      if (kind === "depth") {
        const base = document.createElement("canvas");
        drawDepth(base, result.depth, width, height);
        c.drawImage(base, 0, 0);
      } else
        c.putImageData(
          new ImageData(
            kind === "stereo" ? result.pixels : result.relief,
            width,
            height,
          ),
          0,
          strip,
        );
      if (strip) {
        c.fillStyle = "#faf9f6";
        c.fillRect(0, 0, width, strip);
        c.fillStyle = "#292d31";
        for (const sign of [-1, 1]) {
          c.beginPath();
          c.arc(
            width / 2 + (sign * settings.repeat * width) / 1100 / 2,
            strip / 2,
            (2.5 * width) / 1100,
            0,
            Math.PI * 2,
          );
          c.fill();
        }
      }
      const blob = await new Promise((resolve) =>
        output.toBlob(resolve, "image/png"),
      );
      if (sequence !== exportSequence || !$("export-dialog").open) return;
      if (!blob) throw new Error("PNG encoding failed.");
      downloadBlob(blob, `${name}-${kind}-${width}.png`);
      $("export-status").textContent = "PNG downloaded.";
    } catch (error) {
      if (sequence === exportSequence)
        $("export-status").textContent = error.message;
    } finally {
      if (sequence === exportSequence) exportBusy(false);
    }
  });

async function init() {
  document.querySelector("main").inert = true;
  stage.setAttribute("aria-busy", "true");
  try {
    const stored = await loadDraft();
    if (stored) {
      Object.assign(editor.state, stored);
    }
  } catch {
    notice(
      "The previous draft could not be restored. You can open a saved project.",
      true,
    );
  }
  initialising = false;
  refreshUI();
  creatorTools.refresh();
  viewport.fit();
  pendingPreview = true;
  await renderPreview();
  document.querySelector("main").inert = false;
  stage.removeAttribute("aria-busy");
}
creatorTools = createCreatorTools({
  editor,
  requestFrame,
  setView,
  scheduleRender,
  drawFrame,
  importDepth,
  getRevision: () => revision,
});
bindNumericRanges(
  [
    "object-depth",
    "strength",
    "repeat",
    "soften",
    "brush-size",
    "brush-softness",
    "brush-depth",
  ],
  cancelInput,
);
init();
