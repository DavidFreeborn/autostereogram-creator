/**
 * Analytic front surfaces for the stereogram editor.
 *
 * Coordinates are fractions of the field; `size` is the full nominal width,
 * measured against the shorter side of the field. Positive depth points toward
 * the viewer. Union takes the frontmost surface; subsequent subtract/intersect
 * layers operate on the height field accumulated below them.
 */

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smoothstep = (v) => {
  const t = clamp(v);
  return t * t * (3 - 2 * t);
};
let nextId = 0;
const maskCache = new Map();
const MASK_CACHE_LIMIT = 32 * 1024 * 1024;
let maskCacheBytes = 0;
const imageCache = new WeakMap();
const samplerCache = new WeakMap();
const tileCache = new Map();
const TILE_CACHE_LIMIT = 64 * 1024 * 1024;
let tileBytes = 0,
  tileHits = 0,
  tileMisses = 0;
export function sceneCacheStats() {
  return {
    bytes: tileBytes,
    entries: tileCache.size,
    hits: tileHits,
    misses: tileMisses,
  };
}
export function clearSceneCache() {
  tileCache.clear();
  tileBytes = tileHits = tileMisses = 0;
}
function deleteTile(key) {
  const old = tileCache.get(key);
  if (old) {
    tileBytes -= old.data.byteLength;
    tileCache.delete(key);
  }
}
function retainTile(key, tile) {
  deleteTile(key);
  // Preserve at most the current preview and export resolutions per object.
  const sameLayer = [...tileCache].filter(([, value]) => value.id === tile.id);
  while (sameLayer.length >= 2) deleteTile(sameLayer.shift()[0]);
  while (tileBytes + tile.data.byteLength > TILE_CACHE_LIMIT && tileCache.size)
    deleteTile(tileCache.keys().next().value);
  tileCache.set(key, tile);
  tileBytes += tile.data.byteLength;
}

const defaults = {
  sphere: { name: "Sphere", size: 0.44, depth: 0.82 },
  ellipsoid: { name: "Ellipsoid", size: 0.62, aspect: 0.6, depth: 0.82 },
  cone: { name: "Cone", size: 0.5, depth: 0.82 },
  pyramid: { name: "Pyramid", size: 0.52, depth: 0.82 },
  cylinder: { name: "Cylinder", size: 0.56, aspect: 0.72, depth: 0.78 },
  torus: { name: "Torus", size: 0.78, depth: 0.72, tube: 0.31 },
  star: { name: "Star", size: 0.48, depth: 0.78 },
  box: { name: "Plateau", size: 0.52, depth: 0.64, aspect: 1, roundness: 0.12 },
  text: {
    name: "Lettering",
    size: 1.32,
    depth: 0.78,
    text: "DEPTH",
    bevel: 0.003,
    fontFamily: "sans",
  },
  whale: { name: "Whale", size: 1.34, depth: 0.82 },
  terrain: { name: "Landscape", size: 1.34, depth: 0.72 },
  image: { name: "Image relief", size: 1.25, depth: 0.82, fit: "contain" },
  paint: { name: "Drawing", size: 1, depth: 1 },
};

export function createLayer(type = "sphere") {
  const knownType = Object.hasOwn(defaults, type) ? type : "sphere";
  return {
    id: `layer-${Date.now().toString(36)}-${++nextId}`,
    type: knownType,
    x: 0.5,
    y: 0.5,
    visible: true,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    profile: "rounded",
    operation: "union",
    ...defaults[knownType],
  };
}

function layer(type, values) {
  return {
    ...createLayer(type),
    ...values,
    ...(values.flat && values.profile === undefined ? { profile: "flat" } : {}),
  };
}

export function createPreset(name = "orbital") {
  if (name === "blank") return { name: "Blank canvas", layers: [] };
  if (name === "typography")
    return {
      name: "Cut in stone",
      layers: [
        layer("box", {
          name: "Stone slab",
          size: 1.35,
          aspect: 0.53,
          depth: 0.58,
          roundness: 0.035,
          rotation: -5,
        }),
        layer("text", {
          name: "Recessed lettering",
          text: "DEEP",
          size: 1.09,
          depth: 0.29,
          bevel: 0.008,
          rotation: -5,
          operation: "subtract",
          fontFamily: "sans",
        }),
        layer("sphere", {
          name: "Floating bead",
          x: 0.77,
          y: 0.25,
          size: 0.13,
          depth: 0.91,
        }),
      ],
    };
  if (name === "architecture") {
    const layers = [];
    for (let i = 0; i < 5; i++) {
      const width = 1.35 - i * 0.205;
      layers.push(
        layer("box", {
          name: `Portal ${i + 1}`,
          x: 0.5,
          y: 0.53,
          size: width,
          aspect: 0.67,
          depth: 0.88 - i * 0.135,
          roundness: 0.015,
          profile: "flat",
        }),
      );
      layers.push(
        layer("box", {
          name: `Portal ${i + 1} opening`,
          x: 0.5,
          y: 0.51,
          size: width - 0.095,
          aspect: 0.67,
          depth: 1,
          roundness: 0.01,
          profile: "flat",
          operation: "subtract",
        }),
      );
    }
    layers.push(
      layer("sphere", {
        name: "Distant sphere",
        size: 0.14,
        y: 0.54,
        depth: 0.25,
      }),
    );
    return { name: "Five portals", layers };
  }
  if (name === "landscape")
    return {
      name: "Folded terrain",
      layers: [
        layer("sphere", {
          name: "Distant moon",
          x: 0.67,
          y: 0.23,
          size: 0.25,
          depth: 0.3,
        }),
        layer("terrain", {
          name: "Far ridge",
          x: 0.48,
          y: 0.51,
          size: 1.5,
          depth: 0.38,
          scaleY: 0.55,
          rotation: -6,
        }),
        layer("terrain", {
          name: "Middle ridge",
          x: 0.54,
          y: 0.63,
          size: 1.45,
          depth: 0.62,
          scaleY: 0.62,
          rotation: 5,
        }),
        layer("terrain", {
          name: "Near ridge",
          x: 0.43,
          y: 0.79,
          size: 1.65,
          depth: 0.88,
          scaleY: 0.64,
          rotation: -8,
        }),
      ],
    };
  if (name === "sculpture")
    return {
      name: "Balance study",
      layers: [
        layer("box", {
          name: "Plinth",
          x: 0.5,
          y: 0.78,
          size: 0.98,
          aspect: 0.23,
          depth: 0.39,
          profile: "gradient",
          gradientAngle: 100,
          gradientFloor: 0.5,
        }),
        layer("ellipsoid", {
          name: "Lower stone",
          x: 0.49,
          y: 0.65,
          size: 0.72,
          aspect: 0.38,
          rotation: 9,
          depth: 0.66,
        }),
        layer("torus", {
          name: "Open form",
          x: 0.5,
          y: 0.43,
          size: 0.66,
          scaleX: 0.64,
          rotation: -24,
          tube: 0.28,
          depth: 0.8,
        }),
        layer("ellipsoid", {
          name: "Upper stone",
          x: 0.49,
          y: 0.21,
          size: 0.32,
          aspect: 0.68,
          rotation: -11,
          depth: 0.91,
        }),
        layer("sphere", {
          name: "Counterweight",
          x: 0.7,
          y: 0.58,
          size: 0.16,
          depth: 0.95,
        }),
      ],
    };
  if (name === "whale")
    return {
      name: "The sunken garden",
      layers: [
        layer("box", {
          name: "Distant arch",
          variant: "arch",
          x: 0.3,
          y: 0.71,
          size: 0.26,
          depth: 0.22,
        }),
        layer("box", {
          name: "Central arch",
          variant: "arch",
          x: 0.46,
          y: 0.69,
          size: 0.34,
          depth: 0.29,
        }),
        layer("box", {
          name: "Broken arch",
          variant: "arch",
          x: 0.63,
          y: 0.74,
          size: 0.24,
          depth: 0.19,
        }),
        layer("whale", { x: 0.5, y: 0.41, size: 1.26, depth: 0.82 }),
      ],
    };
  if (name === "terraces")
    return {
      name: "Three terraces",
      layers: [
        layer("box", {
          name: "Lower terrace",
          x: 0.5,
          y: 0.53,
          size: 1.13,
          aspect: 0.7,
          depth: 0.27,
          roundness: 0.08,
          flat: true,
        }),
        layer("box", {
          name: "Middle terrace",
          x: 0.5,
          y: 0.49,
          size: 0.83,
          aspect: 0.68,
          depth: 0.53,
          roundness: 0.08,
          flat: true,
        }),
        layer("box", {
          name: "Upper terrace",
          x: 0.5,
          y: 0.45,
          size: 0.53,
          aspect: 0.67,
          depth: 0.84,
          roundness: 0.1,
          flat: true,
        }),
      ],
    };
  if (name === "type")
    return {
      name: "A word in space",
      layers: [
        layer("text", {
          name: "DEPTH",
          x: 0.5,
          y: 0.49,
          size: 1.43,
          depth: 0.8,
          text: "DEPTH",
        }),
      ],
    };
  return {
    name: "Orbital forms",
    layers: [
      layer("torus", {
        name: "Ring",
        x: 0.465,
        y: 0.495,
        size: 0.86,
        depth: 0.69,
        tube: 0.32,
      }),
      layer("sphere", {
        name: "Large sphere",
        x: 0.676,
        y: 0.586,
        size: 0.39,
        depth: 0.94,
      }),
      layer("sphere", {
        name: "Satellite",
        x: 0.18,
        y: 0.24,
        size: 0.155,
        depth: 0.55,
      }),
    ],
  };
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height);
  if (typeof document === "undefined")
    throw new Error("Canvas rendering is unavailable in this environment");
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** Exact separable Euclidean distance transform, then a small subpixel filter. */
function interiorDistance(alpha, width, height) {
  const length = Math.max(width, height);
  const f = new Float64Array(length);
  const result = new Float64Array(length);
  const sites = new Int32Array(length);
  const edges = new Float64Array(length + 1);
  const squared = new Float32Array(width * height);
  const distance = new Float32Array(width * height);
  function transform(n) {
    let k = 0;
    sites[0] = 0;
    edges[0] = -Infinity;
    edges[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let intersection;
      do {
        const site = sites[k];
        intersection =
          (f[q] + q * q - (f[site] + site * site)) / (2 * q - 2 * site);
        if (intersection > edges[k]) break;
        k--;
      } while (k >= 0);
      k++;
      sites[k] = q;
      edges[k] = intersection;
      edges[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (edges[k + 1] < q) k++;
      result[q] = (q - sites[k]) ** 2 + f[sites[k]];
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++)
      f[y] = alpha[y * width + x] > 127 ? 1e9 : 0;
    transform(height);
    for (let y = 0; y < height; y++) squared[y * width + x] = result[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = squared[y * width + x];
    transform(width);
    for (let x = 0; x < width; x++)
      distance[y * width + x] = Math.sqrt(result[x]);
  }
  // Smooth the pixel lattice without changing the antialiased silhouette.
  const temporary = new Float32Array(distance.length);
  const radius = Math.max(2, Math.min(7, Math.round(width / 120)));
  const sigma = Math.max(1, radius / 2.5);
  const weights = [];
  let weightSum = 0;
  for (let k = -radius; k <= radius; k++) {
    const weight = Math.exp((-k * k) / (2 * sigma * sigma));
    weights.push(weight);
    weightSum += weight;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum +=
          distance[y * width + clamp(x + k, 0, width - 1)] *
          weights[k + radius];
      temporary[y * width + x] = sum / weightSum;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum +=
          temporary[clamp(y + k, 0, height - 1) * width + x] *
          weights[k + radius];
      distance[y * width + x] = sum / weightSum;
    }
  }
  return distance;
}

function shapeMask(item, width, height) {
  const text = String(item.text ?? "DEPTH").slice(0, 80);
  const family =
    item.fontFamily === "sans"
      ? "Arial, Helvetica, sans-serif"
      : "Georgia, 'Times New Roman', serif";
  const key = [item.type, item.variant, width, height, text, family].join("|");
  if (maskCache.has(key)) {
    const cached = maskCache.get(key);
    maskCache.delete(key);
    maskCache.set(key, cached);
    return cached;
  }
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  const inset = 2;
  if (item.type === "text") {
    // A broad, upright letterform leaves enough horizontal extent for fusion.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let fontSize = height * 0.82;
    ctx.font = `700 ${fontSize}px ${family}`;
    const measured = ctx.measureText(text).width;
    if (measured > width - 2 * inset)
      fontSize *= (width - 2 * inset) / measured;
    ctx.font = `700 ${fontSize}px ${family}`;
    ctx.fillText(text, width / 2, height / 2 + fontSize * 0.055);
  } else if (item.type === "whale") {
    ctx.save();
    ctx.translate(width / 2, height * 0.44);
    ctx.scale((width - 4) / 2, (height - 4) / 1.2);
    ctx.beginPath();
    ctx.moveTo(-0.96, -0.005);
    ctx.bezierCurveTo(-0.93, -0.25, -0.58, -0.37, -0.2, -0.31);
    ctx.bezierCurveTo(0.07, -0.29, 0.26, -0.15, 0.57, -0.065);
    ctx.bezierCurveTo(0.65, -0.045, 0.73, -0.03, 0.78, -0.065);
    ctx.bezierCurveTo(0.83, -0.18, 0.87, -0.32, 0.995, -0.37);
    ctx.bezierCurveTo(0.975, -0.22, 0.96, -0.08, 0.85, 0.035);
    ctx.bezierCurveTo(0.93, 0.105, 0.99, 0.21, 0.99, 0.34);
    ctx.bezierCurveTo(0.89, 0.33, 0.78, 0.25, 0.73, 0.115);
    ctx.bezierCurveTo(0.58, 0.13, 0.41, 0.16, 0.25, 0.21);
    ctx.bezierCurveTo(0.04, 0.28, -0.16, 0.32, -0.36, 0.265);
    ctx.bezierCurveTo(-0.35, 0.44, -0.39, 0.57, -0.57, 0.62);
    ctx.bezierCurveTo(-0.59, 0.46, -0.57, 0.35, -0.6, 0.215);
    ctx.bezierCurveTo(-0.8, 0.18, -0.97, 0.13, -0.96, -0.005);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (item.variant === "arch") {
    const w = width - 4;
    const h = height - 4;
    ctx.beginPath();
    ctx.moveTo(2, h + 2);
    ctx.lineTo(2, h * 0.45 + 2);
    ctx.bezierCurveTo(2, 2, w + 2, 2, w + 2, h * 0.45 + 2);
    ctx.lineTo(w + 2, h + 2);
    ctx.lineTo(w * 0.73 + 2, h + 2);
    ctx.lineTo(w * 0.73 + 2, h * 0.46 + 2);
    ctx.bezierCurveTo(
      w * 0.73 + 2,
      h * 0.2 + 2,
      w * 0.27 + 2,
      h * 0.2 + 2,
      w * 0.27 + 2,
      h * 0.46 + 2,
    );
    ctx.lineTo(w * 0.27 + 2, h + 2);
    ctx.closePath();
    ctx.fill();
  } else if (item.type === "star") {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI) / 5 - Math.PI / 2;
      const r = (i % 2 ? 0.225 : 0.495) * (Math.min(width, height) - 4);
      const x = width / 2 + Math.cos(angle) * r;
      const y = height / 2 + Math.sin(angle) * r;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  const result = {
    alpha,
    distance: interiorDistance(alpha, width, height),
    width,
    height,
  };
  // A byte limit accommodates many small shapes without retaining dozens of
  // full export rasters. Recently used glyphs survive repeated frame requests.
  const bytes = result.alpha.byteLength + result.distance.byteLength;
  while (maskCacheBytes + bytes > MASK_CACHE_LIMIT && maskCache.size) {
    const oldest = maskCache.keys().next().value;
    const removed = maskCache.get(oldest);
    maskCacheBytes -= removed.alpha.byteLength + removed.distance.byteLength;
    maskCache.delete(oldest);
  }
  maskCache.set(key, result);
  maskCacheBytes += bytes;
  return result;
}

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

function sourceAspect(item) {
  if (Number.isFinite(item.aspect)) return clamp(item.aspect, 0.02, 20);
  const source = item.imageData || item.image || item.field;
  if ((item.type === "image" || item.type === "paint") && source) {
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    if (w > 0 && h > 0) return h / w;
  }
  if (item.type === "text") return 0.38;
  if (item.type === "whale") return 0.6;
  if (item.variant === "arch") return 1.22;
  if (item.type === "terrain") return 0.65;
  return 1;
}

/** Unrotated object bounds in normalized scene coordinates. Size uses the shorter scene side. */
export function layerBounds(item, width, height) {
  const fullSize =
    Math.max(0.01, finite(item.size, 0.5)) * Math.min(width, height);
  const halfWidth = (fullSize * Math.abs(finite(item.scaleX, 1))) / (2 * width);
  const halfHeight =
    (fullSize * sourceAspect(item) * Math.abs(finite(item.scaleY, 1))) /
    (2 * height);
  const x = finite(item.x, 0.5),
    y = finite(item.y, 0.5);
  return {
    x,
    y,
    halfWidth,
    halfHeight,
    width: halfWidth * 2,
    height: halfHeight * 2,
    left: x - halfWidth,
    top: y - halfHeight,
    rotation: finite(item.rotation, 0),
  };
}

/** Map a normalized scene point into the object's own bounding box (u,v in 0..1). */
export function layerLocalPoint(item, x, y, width, height) {
  const b = layerBounds(item, width, height);
  const angle = (b.rotation * Math.PI) / 180;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const px = (x - b.x) * width,
    py = (y - b.y) * height;
  return {
    u:
      0.5 +
      ((cos * px + sin * py) / (2 * b.halfWidth * width || 1)) *
        (item.scaleX < 0 ? -1 : 1),
    v:
      0.5 +
      ((-sin * px + cos * py) / (2 * b.halfHeight * height || 1)) *
        (item.scaleY < 0 ? -1 : 1),
  };
}

function sampleBilinear(data, width, height, x, y) {
  x = clamp(x, 0, width - 1);
  y = clamp(y, 0, height - 1);
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1),
    y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0,
    ty = y - y0;
  const a = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
  const b = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function validField(field, channels = 1) {
  return (
    field &&
    Number.isInteger(field.width) &&
    field.width > 0 &&
    Number.isInteger(field.height) &&
    field.height > 0 &&
    field.data &&
    field.data.length >= field.width * field.height * channels
  );
}

function fieldSample(field, u, v) {
  return sampleBilinear(
    field.data,
    field.width,
    field.height,
    u * field.width - 0.5,
    v * field.height - 0.5,
  );
}

// Keep image pixels independent of DOM objects so project snapshots can be sent
// to a worker. Legacy HTMLImageElements are converted once for old projects.
function imageField(item) {
  const source = item.imageData || item.image;
  if (!source || typeof source !== "object") return null;
  const old = imageCache.get(source);
  if (old && old.invert === !!item.invert) return old.field;
  let rgba = source;
  if (!validField(rgba, 4)) {
    const w = source.naturalWidth || source.width,
      h = source.naturalHeight || source.height;
    if (!w || !h) return null;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    try {
      ctx.drawImage(source, 0, 0, w, h);
      rgba = ctx.getImageData(0, 0, w, h);
    } catch {
      return null;
    }
  }
  const data = new Float32Array(rgba.width * rgba.height);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    let z =
      (0.2126 * rgba.data[p] +
        0.7152 * rgba.data[p + 1] +
        0.0722 * rgba.data[p + 2]) /
      255;
    if (item.invert) z = 1 - z;
    data[i] = (z * rgba.data[p + 3]) / 255;
  }
  const field = { data, width: rgba.width, height: rgba.height };
  imageCache.set(source, { invert: !!item.invert, field });
  return field;
}

function compileLayer(item, width, height) {
  // The snapshot includes scalar properties; field content is read live. A stroke
  // therefore needs no expensive recompile, while a moved object never picks at
  // its former position. Weak keys let deleted/imported objects be collected.
  const key = [
    width,
    height,
    item.type,
    item.x,
    item.y,
    item.size,
    item.depth,
    item.aspect,
    item.scaleX,
    item.scaleY,
    item.rotation,
    item.tube,
    item.roundness,
    item.flat,
    item.profile,
    item.bevel,
    item.gradientAngle,
    item.gradientFloor,
    item.variant,
    item.text,
    item.fontFamily,
    item.fit,
    item.invert,
  ].join("|");
  const old = samplerCache.get(item);
  if (
    old?.key === key &&
    old.mask === item.mask &&
    old.field === item.field &&
    old.image === (item.imageData || item.image)
  )
    return old.compiled;
  const b = layerBounds(item, width, height);
  const halfX = Math.max(0.001, b.halfWidth * width),
    halfY = Math.max(0.001, b.halfHeight * height);
  const angle = (b.rotation * Math.PI) / 180;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const sx = item.scaleX < 0 ? -1 : 1,
    sy = item.scaleY < 0 ? -1 : 1;
  const peak = clamp(finite(item.depth, 0.7));
  const gradient = item.profile === "gradient";
  const flat =
    gradient ||
    (item.profile !== undefined ? item.profile === "flat" : item.flat === true);
  const edge = 1 / Math.min(halfX, halfY);
  // Convert a local signed-distance gradient into one screen pixel. Using a
  // single radius here makes an extremely stretched object grow a wide halo.
  const radialEdge = (dx, dy, radius) =>
    radius > 0 ? Math.hypot(dx / halfX, dy / halfY) / radius : edge;
  const squareEdge = (dx, dy) =>
    Math.abs(dx) > Math.abs(dy) ? 1 / halfX : 1 / halfY;
  let geometry;
  if (
    ["text", "whale", "star"].includes(item.type) ||
    item.variant === "arch"
  ) {
    // Rasterize at display resolution with a fixed memory ceiling. Transforms
    // operate on this local surface, so glyphs and erase marks rotate together.
    const nativeWidth = finite(item.size, 0.5) * Math.min(width, height);
    const density =
      item.type === "text"
        ? 2 *
          Math.max(
            Math.abs(finite(item.scaleX, 1)),
            Math.abs(finite(item.scaleY, 1)),
          )
        : 1;
    const desiredWidth = Math.max(8, nativeWidth * density);
    const desiredHeight = Math.max(8, desiredWidth * sourceAspect(item));
    const limit = Math.min(
      1,
      4096 / Math.max(desiredWidth, desiredHeight),
      Math.sqrt(4_000_000 / (desiredWidth * desiredHeight)),
    );
    const w = Math.max(8, Math.round(desiredWidth * limit));
    const h = Math.max(8, Math.round(desiredHeight * limit));
    const mask = shapeMask(item, w, h);
    const bevel =
      item.type === "whale"
        ? w * 0.1
        : item.type === "star"
          ? w * 0.15
          : w * clamp(finite(item.bevel, 0.015), 0, 0.12);
    const rounded = item.type === "whale" || item.type === "star";
    geometry = (dx, dy) => {
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return 0;
      const mx = (dx + 1) * 0.5 * w - 0.5,
        my = (dy + 1) * 0.5 * h - 0.5;
      const alpha = sampleBilinear(mask.alpha, w, h, mx, my) / 255;
      if (!alpha) return 0;
      if (flat || bevel === 0) return peak * alpha;
      const t = clamp(
        sampleBilinear(mask.distance, w, h, mx, my) / Math.max(1, bevel),
      );
      const relief = rounded ? Math.sqrt(t * (2 - t)) : smoothstep(t);
      return peak * (0.5 + 0.5 * relief) * alpha;
    };
  } else if (item.type === "sphere" || item.type === "ellipsoid") {
    geometry = (dx, dy) => {
      const r2 = dx * dx + dy * dy;
      if (r2 <= 1) return peak * (flat ? 1 : 0.22 + 0.78 * Math.sqrt(1 - r2));
      const radius = Math.sqrt(r2);
      return (
        peak *
        (flat ? 1 : 0.22) *
        clamp(1 - (radius - 1) / radialEdge(dx, dy, radius))
      );
    };
  } else if (item.type === "torus") {
    const tube = clamp(item.tube ?? 0.31, 0.14, 0.48);
    geometry = (dx, dy) => {
      const radius = Math.hypot(dx, dy);
      const d = Math.abs(radius - (1 - tube)) / tube;
      if (d <= 1) return peak * (flat ? 1 : 0.37 + 0.63 * Math.sqrt(1 - d * d));
      return (
        peak *
        (flat ? 1 : 0.37) *
        clamp(1 - ((d - 1) * tube) / radialEdge(dx, dy, radius))
      );
    };
  } else if (item.type === "box") {
    const radius = clamp(item.roundness ?? 0.12, 0, 0.5);
    geometry = (dx, dy) => {
      const qx = Math.abs(dx) - (1 - radius),
        qy = Math.abs(dy) - (1 - radius);
      const distance =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
        Math.min(Math.max(qx, qy), 0) -
        radius;
      if (distance >= edge) return 0;
      const cornerRadius = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const pixel =
        qx > 0 && qy > 0
          ? Math.hypot(qx / halfX, qy / halfY) / cornerRadius
          : qx > qy
            ? 1 / halfX
            : 1 / halfY;
      const coverage = clamp(0.5 - distance / pixel);
      return (
        peak *
        (flat ? 1 : 0.68 + 0.32 * smoothstep(-distance / 0.15)) *
        coverage
      );
    };
  } else if (item.type === "cone" || item.type === "pyramid") {
    const square = item.type === "pyramid";
    geometry = (dx, dy) => {
      const r = square
        ? Math.max(Math.abs(dx), Math.abs(dy))
        : Math.hypot(dx, dy);
      const pixel = square ? squareEdge(dx, dy) : radialEdge(dx, dy, r);
      const coverage = clamp(0.5 + (1 - r) / pixel);
      return peak * (flat ? 1 : 0.12 + 0.88 * clamp(1 - r)) * coverage;
    };
  } else if (item.type === "cylinder") {
    geometry = (dx, dy) => {
      const coverage = clamp(
        0.5 + (1 - Math.max(Math.abs(dx), Math.abs(dy))) / squareEdge(dx, dy),
      );
      return (
        peak *
        (flat ? 1 : 0.22 + 0.78 * Math.sqrt(Math.max(0, 1 - dx * dx))) *
        coverage
      );
    };
  } else if (item.type === "terrain") {
    geometry = (dx, dy) => {
      const fade =
        smoothstep((1 - Math.abs(dx)) / 0.12) *
        smoothstep((1 - Math.abs(dy)) / 0.15);
      if (!fade) return 0;
      if (flat) return peak * fade;
      const hill1 = Math.exp(
        -((dx + 0.32) ** 2 / 0.16 + (dy + 0.08) ** 2 / 0.42),
      );
      const hill2 = Math.exp(
        -((dx - 0.35) ** 2 / 0.12 + (dy - 0.06) ** 2 / 0.2),
      );
      const ridge =
        0.16 * (1 + Math.sin(7 * dx + 2 * dy)) * Math.exp(-dy * dy * 2.2);
      return (
        peak * clamp(0.04 + 0.82 * Math.max(hill1, hill2 * 0.78) + ridge) * fade
      );
    };
  } else if (item.type === "image") {
    const field = imageField(item);
    // Explicit aspect ratios support contain/cover without stretching the source.
    const boxRatio = sourceAspect(item),
      imageRatio = field ? field.height / field.width : 1;
    const fitScale =
      item.fit === "cover"
        ? Math.max(1, boxRatio / imageRatio)
        : Math.min(1, boxRatio / imageRatio);
    geometry = (dx, dy) => {
      if (!field || Math.abs(dx) > 1 || Math.abs(dy) > 1) return 0;
      const u = (dx / fitScale + 1) / 2,
        v = ((dy * boxRatio) / (imageRatio * fitScale) + 1) / 2;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      return peak * fieldSample(field, u, v);
    };
  } else if (item.type === "paint" && validField(item.field)) {
    const field = item.field;
    geometry = (dx, dy) =>
      Math.abs(dx) <= 1 && Math.abs(dy) <= 1
        ? peak * clamp(fieldSample(field, (dx + 1) / 2, (dy + 1) / 2))
        : 0;
  } else geometry = () => 0;
  const mask = validField(item.mask) ? item.mask : null;
  const gradientAngle = (finite(item.gradientAngle, 0) * Math.PI) / 180;
  const gradientX = Math.cos(gradientAngle),
    gradientY = Math.sin(gradientAngle);
  const gradientExtent = Math.abs(gradientX) + Math.abs(gradientY);
  const gradientFloor = clamp(finite(item.gradientFloor, 0.2));
  const clipX = 1 + 1 / halfX,
    clipY = 1 + 1 / halfY;
  const sample = (dx, dy) => {
    // Linearized edge distances are valid only next to the boundary. This
    // physical pixel guard also bounds antialiasing under extreme stretching.
    if (Math.abs(dx) > clipX || Math.abs(dy) > clipY) return 0;
    let value = geometry(dx, dy);
    if (gradient) {
      const ramp = clamp(
        0.5 + (dx * gradientX + dy * gradientY) / (2 * gradientExtent),
      );
      value *= gradientFloor + (1 - gradientFloor) * ramp;
    }
    return mask && value > 0
      ? value * (1 - clamp(fieldSample(mask, (dx + 1) / 2, (dy + 1) / 2)))
      : value;
  };
  const compiled = {
    signature: key + "|" + sourceAspect(item),
    sample,
    cx: b.x * width,
    cy: b.y * height,
    // Inverse transform coefficients, shared by composition and picking.
    xx: (cos / halfX) * sx,
    xy: (sin / halfX) * sx,
    yx: (-sin / halfY) * sy,
    yy: (cos / halfY) * sy,
    radiusX: Math.abs(cos) * halfX + Math.abs(sin) * halfY + 2,
    radiusY: Math.abs(sin) * halfX + Math.abs(cos) * halfY + 2,
  };
  samplerCache.set(item, {
    key,
    compiled,
    mask: item.mask,
    field: item.field,
    image: item.imageData || item.image,
  });
  return compiled;
}

/** Exact local front-surface hit test, including transforms, holes and erasing. */
export function sampleLayerDepth(item, x, y, width, height) {
  if (item.visible === false || item.scaleX === 0 || item.scaleY === 0)
    return 0;
  const c = compileLayer(item, width, height);
  const px = x * width - c.cx,
    py = y * height - c.cy;
  return c.sample(px * c.xx + py * c.xy, px * c.yx + py * c.yy);
}

export function composeDepth(scene, width, height) {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width * height > 64_000_000)
    throw new RangeError("Scene exceeds 64 million pixels");
  const output = new Float32Array(width * height);
  for (const item of scene.layers || []) {
    if (
      item.visible === false ||
      item.scaleX === 0 ||
      item.scaleY === 0 ||
      (item.depth === 0 && item.operation !== "intersect")
    )
      continue;
    const c = compileLayer(item, width, height);
    const x0 = Math.max(0, Math.floor(c.cx - c.radiusX)),
      x1 = Math.min(width - 1, Math.ceil(c.cx + c.radiusX));
    const y0 = Math.max(0, Math.floor(c.cy - c.radiusY)),
      y1 = Math.min(height - 1, Math.ceil(c.cy + c.radiusY));
    const operation = item.operation || "union";
    // A height field is solid from zero up to its surface. Intersection with
    // empty space outside this object's bounds therefore clears that space.
    if (operation === "intersect") {
      for (let y = 0; y < height; y++) {
        const row = y * width;
        if (y < y0 || y > y1) output.fill(0, row, row + width);
        else {
          output.fill(0, row, row + Math.min(width, x0));
          output.fill(0, row + Math.max(0, x1 + 1), row + width);
        }
      }
    }
    const cacheKey =
      item.id && Object.hasOwn(item, "_cacheKey")
        ? `${item.id}|${width}|${height}`
        : null;
    const signature = `${c.signature}|${item._cacheKey}`;
    const old = cacheKey && tileCache.get(cacheKey);
    if (old && old.signature === signature) {
      tileHits++;
      tileCache.delete(cacheKey);
      tileCache.set(cacheKey, old);
      let source = 0;
      for (let y = old.y0; y <= old.y1; y++) {
        let target = y * width + old.x0;
        for (let x = old.x0; x <= old.x1; x++, source++, target++)
          if (operation === "subtract")
            output[target] = Math.max(0, output[target] - old.data[source]);
          else if (operation === "intersect")
            output[target] = Math.min(output[target], old.data[source]);
          else if (old.data[source] > output[target])
            output[target] = old.data[source];
      }
      continue;
    }
    if (cacheKey) tileMisses++;
    const count = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
    const tile =
      cacheKey && count && count * 4 <= TILE_CACHE_LIMIT
        ? new Float32Array(count)
        : null;
    let tileIndex = 0;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5 - c.cy;
      let dx = (x0 + 0.5 - c.cx) * c.xx + py * c.xy;
      let dy = (x0 + 0.5 - c.cx) * c.yx + py * c.yy;
      let index = y * width + x0;
      for (let x = x0; x <= x1; x++, index++, dx += c.xx, dy += c.yx) {
        const value = c.sample(dx, dy);
        if (tile) tile[tileIndex++] = value;
        if (operation === "subtract")
          output[index] = Math.max(0, output[index] - value);
        else if (operation === "intersect")
          output[index] = Math.min(output[index], value);
        else if (value > output[index]) output[index] = value;
      }
    }
    if (tile)
      retainTile(cacheKey, {
        id: item.id,
        signature,
        data: tile,
        x0,
        x1,
        y0,
        y1,
      });
  }
  // Older project files stored a single fixed canvas painting. Preserve it.
  const paint = scene.paint;
  if (validField(paint)) {
    const sameSize = paint.width === width && paint.height === height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const value = sameSize
          ? paint.data[i]
          : fieldSample(paint, (x + 0.5) / width, (y + 0.5) / height);
        if (value > output[i]) output[i] = clamp(value);
      }
    }
  }
  return output;
}

/** Linear-time separable box blur, with replicated boundary samples. */
export function blurDepth(data, width, height, radius) {
  radius = Math.min(256, Math.max(0, Math.round(radius)));
  if (!radius) return data;
  const temp = new Float32Array(data.length),
    result = new Float32Array(data.length),
    divisor = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++)
      sum += data[row + clamp(k, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      temp[row + x] = sum / divisor;
      sum +=
        data[row + Math.min(width - 1, x + radius + 1)] -
        data[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++)
      sum += temp[clamp(k, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      result[y * width + x] = sum / divisor;
      sum +=
        temp[Math.min(height - 1, y + radius + 1) * width + x] -
        temp[Math.max(0, y - radius) * width + x];
    }
  }
  return result;
}

/** Settings use UI units: soften at the 1100px reference width, levels=0 off. */
export function transformDepth(depth, width, height, settings = {}) {
  if (settings.invert)
    for (let i = 0; i < depth.length; i++) depth[i] = 1 - depth[i];
  if (settings.levels > 1) {
    const steps = Math.max(1, Math.round(settings.levels) - 1);
    for (let i = 0; i < depth.length; i++)
      depth[i] = Math.round(depth[i] * steps) / steps;
  }
  return blurDepth(
    depth,
    width,
    height,
    (finite(settings.soften, 0) * width) / 1100,
  );
}

function prepare(canvas, width, height) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas.getContext("2d", { alpha: false });
}

export function drawDepth(canvas, depth, width, height) {
  const ctx = prepare(canvas, width, height);
  const image = ctx.createImageData(width, height);
  const pixels = image.data;
  for (let i = 0; i < width * height; i++) {
    const v = Math.round(clamp(depth[i] || 0) * 255);
    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = v;
    pixels[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

/** An orthographic, matte relief. Shading describes geometry, not UI chrome. */
export function renderRelief(depth, width, height, options = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const paper = options.background || [237, 234, 225];
  const shadow = [24, 61, 63];
  const lit = [151, 181, 165];
  const step = Math.max(1, Math.round(Math.min(width, height) / 660));
  const scale = (Math.min(width, height) * 0.27) / (step * 2);
  for (let y = 0; y < height; y++) {
    const yt = Math.max(0, y - step),
      yb = Math.min(height - 1, y + step);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      const z = depth[i] || 0;
      if (z > 0.001) {
        const xl = Math.max(0, x - step),
          xr = Math.min(width - 1, x + step);
        const nx = (depth[y * width + xl] - depth[y * width + xr]) * scale;
        const ny = (depth[yt * width + x] - depth[yb * width + x]) * scale;
        const magnitude = Math.sqrt(nx * nx + ny * ny + 1);
        const light = clamp((-0.46 * nx - 0.56 * ny + 0.69) / magnitude);
        const t = clamp(0.18 + 0.71 * light + 0.1 * z);
        for (let c = 0; c < 3; c++)
          pixels[p + c] = Math.round(shadow[c] + (lit[c] - shadow[c]) * t);
      } else {
        pixels[p] = paper[0];
        pixels[p + 1] = paper[1];
        pixels[p + 2] = paper[2];
      }
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

export function drawScene(canvas, depth, width, height, options = {}) {
  const ctx = prepare(canvas, width, height);
  const image = ctx.createImageData(width, height);
  image.data.set(renderRelief(depth, width, height, options));
  ctx.putImageData(image, 0, 0);
}
