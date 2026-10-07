/**
 * Single-image random-dot stereograms, with symmetric pixel constraints.
 *
 * Based on the geometry and hidden-surface method of Thimbleby, Witten & Inglis,
 * “Displaying 3D Images: Algorithms for Single Image Random Dot Stereograms”.
 * https://harold.thimbleby.net/sirds/ieee3d.pdf, Figure 3 and pp. 5–8.
 *
 * The image's colours are independent of depth. Only the correspondence between
 * pixels carries the scene. This module has no DOM or Canvas dependencies.
 */

const PALETTES = Object.freeze({
  verdigris: [
    "#153c3d",
    "#285953",
    "#458577",
    "#709e89",
    "#a6baa0",
    "#d8d3ae",
    "#d7e1cc",
    "#789493",
  ],
  mineral: [
    "#283748",
    "#38556d",
    "#557f96",
    "#83a9b6",
    "#afc2c1",
    "#d4d9c8",
    "#9c9ab2",
    "#616b8a",
  ],
  ink: [
    "#232b2b",
    "#495351",
    "#707977",
    "#939b92",
    "#bcc0ae",
    "#e5dfc9",
    "#c9c5b7",
    "#828777",
  ],
  ochre: [
    "#433b2e",
    "#6e4e36",
    "#9d693e",
    "#be9155",
    "#d9b873",
    "#ece0b5",
    "#c3b998",
    "#8c967c",
  ],
});

const RGB = Object.fromEntries(
  Object.entries(PALETTES).map(([name, colours]) => [
    name,
    colours.map((colour) =>
      [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16)),
    ),
  ]),
);

export const paletteNames = Object.freeze(Object.keys(PALETTES));
export const textureStyleNames = Object.freeze([
  "stipple",
  "mineral",
  "paper",
  "organic",
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const unit = (value) => (Number.isFinite(value) ? clamp(value, 0, 1) : 0);

function geometry(repeat, strength, mode) {
  const amount = 0.2 * unit(strength);
  // Choose mu so the endpoint disparity is exactly 20% × strength. This keeps
  // the slider predictable while preserving the nonlinear stereo geometry.
  const mu =
    mode === "cross"
      ? (2 * amount) / (3 + amount)
      : (2 * amount) / (1 + amount);
  return {
    repeat: Math.max(1, Math.round(repeat)),
    mu,
    cross: mode === "cross",
  };
}

function separation(z, { repeat, mu, cross }) {
  return Math.max(
    1,
    Math.round((2 * repeat * (1 + (cross ? 1 : -1) * mu * z)) / (2 - mu * z)),
  );
}

/** Integer separation in output pixels. z=0 is far, z=1 is near. */
export function separationForDepth(
  z,
  repeat,
  strength = 0.55,
  mode = "parallel",
) {
  if (!Number.isFinite(repeat) || repeat < 1)
    throw new RangeError("repeat must be at least one pixel");
  if (mode !== "parallel" && mode !== "cross")
    throw new RangeError("mode must be parallel or cross");
  return separation(unit(z), geometry(repeat, strength, mode));
}

function hash(x, y, seed) {
  let value =
    Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ seed;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function normaliseSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  let result = 2166136261;
  for (const character of String(seed))
    result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

function validateTexture(texture) {
  if (!texture) return null;
  const { width, height, data } = texture;
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    !data ||
    data.length < width * height * 4
  ) {
    throw new RangeError("texture must contain width × height RGBA samples");
  }
  return texture;
}

const textureCache = new Map();
const TEXTURE_CACHE_LIMIT = 12 * 1024 * 1024;
let textureCacheBytes = 0;
const wrap = (v, length) => ((v % length) + length) % length;
const smooth = (v) => v * v * (3 - 2 * v);

// Wrapped lattice noise is continuous at both tile boundaries. Tile generation
// never reads a depth sample: the subsequent equal-colour constraints alone
// carry the scene, for every texture family.
function periodicNoise(x, y, columns, rows, seed) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const tx = smooth(x - ix),
    ty = smooth(y - iy);
  const h = (a, b) => hash(wrap(a, columns), wrap(b, rows), seed) / 4294967295;
  const a = h(ix, iy) * (1 - tx) + h(ix + 1, iy) * tx;
  const b = h(ix, iy + 1) * (1 - tx) + h(ix + 1, iy + 1) * tx;
  return a * (1 - ty) + b * ty;
}

function proceduralTile(style, palette, repeat, grain, seed) {
  const width = repeat;
  const height = Math.max(32, Math.min(1024, Math.round(128 * grain)));
  const key = [style, palette, width, height, grain, seed].join("|");
  if (textureCache.has(key)) {
    const tile = textureCache.get(key);
    textureCache.delete(key);
    textureCache.set(key, tile);
    return tile;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const colours = RGB[palette];
  const columns = Math.max(2, Math.round(width / (grain * 4)));
  const rows = Math.max(2, Math.round(height / (grain * 4)));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width) * columns;
      const v = ((y + 0.5) / height) * rows;
      const random = hash(x, y, seed);
      let colour,
        lift = 0;
      if (style === "mineral") {
        // Irregular crystalline regions with granular inclusions.
        let nearest = Infinity,
          crystal = 0;
        const ix = Math.floor(u),
          iy = Math.floor(v);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const cell = hash(
              wrap(ix + dx, columns),
              wrap(iy + dy, rows),
              seed,
            );
            const px = ix + dx + 0.2 + ((cell & 1023) / 1023) * 0.6;
            const py = iy + dy + 0.2 + (((cell >>> 10) & 1023) / 1023) * 0.6;
            const distance = Math.abs(u - px) * 0.85 + Math.abs(v - py);
            if (distance < nearest) {
              nearest = distance;
              crystal = cell;
            }
          }
        colour = colours[(crystal >>> 20) & 7];
        lift = (random & 15) - 7;
        if ((random >>> 8) % 19 === 0) colour = colours[(random >>> 16) & 7];
      } else if (style === "paper") {
        const fibreColumns = Math.max(1, Math.round(columns / 2));
        const fibre = periodicNoise(
          ((x + 0.5) / width) * fibreColumns,
          v * 4,
          fibreColumns,
          rows * 4,
          seed,
        );
        const grainNoise = periodicNoise(
          u * 3,
          v * 3,
          columns * 3,
          rows * 3,
          seed ^ 7251,
        );
        const mark = fibre * 0.58 + grainNoise * 0.42;
        colour =
          colours[mark < 0.37 ? 1 : mark < 0.48 ? 3 : mark < 0.61 ? 6 : 5];
        lift = (random & 15) - 7;
      } else {
        const broad = periodicNoise(u, v, columns, rows, seed);
        const fine = periodicNoise(
          u * 3,
          v * 3,
          columns * 3,
          rows * 3,
          seed ^ 9187,
        );
        const mark = broad * 0.7 + fine * 0.3;
        colour =
          colours[
            mark < 0.32
              ? 0
              : mark < 0.44
                ? 2
                : mark < 0.52
                  ? 4
                  : mark < 0.6
                    ? 6
                    : 5
          ];
        lift = (random & 7) - 3;
      }
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[p + c] = colour[c] + lift;
      data[p + 3] = 255;
    }
  const tile = { width, height, data };
  while (
    textureCacheBytes + data.byteLength > TEXTURE_CACHE_LIMIT &&
    textureCache.size
  ) {
    const oldest = textureCache.keys().next().value;
    textureCacheBytes -= textureCache.get(oldest).data.byteLength;
    textureCache.delete(oldest);
  }
  if (data.byteLength <= TEXTURE_CACHE_LIMIT) {
    textureCache.set(key, tile);
    textureCacheBytes += data.byteLength;
  }
  return tile;
}

function textureSource(tile, x, y, repeat, height, zoom, repeatMode) {
  const u = ((x % repeat) / repeat - 0.5) / zoom + 0.5;
  const v =
    repeatMode === "horizontal"
      ? ((y + 0.5) / height - 0.5) / zoom + 0.5
      : (y * tile.width) / (repeat * zoom * tile.height);
  const tx = Math.min(tile.width - 1, Math.floor(wrap(u, 1) * tile.width));
  const ty =
    repeatMode === "horizontal"
      ? clamp(Math.floor(v * tile.height), 0, tile.height - 1)
      : Math.floor(wrap(v, 1) * tile.height);
  return (ty * tile.width + tx) * 4;
}

/** Pattern-only swatch; custom image controls have the same mapping as output. */
export function renderTextureSample({
  width = 120,
  height = 72,
  repeat = 90,
  ...options
} = {}) {
  const result = renderStereogram({
    ...options,
    width,
    height,
    repeat,
    depth: new Float32Array(width * height),
    strength: 0,
  });
  return { width, height, pixels: result.pixels };
}

/**
 * Resolution measurements, not a prediction of a person's ability to fuse.
 * Mask bit 1 marks adjacent depth changes >= threshold sharing one disparity.
 * Bit 2 marks a 2× reference block spanning more than one output disparity.
 * The latter measures within-pixel variation; it does not establish whether an
 * entire object is invisible. All comparisons use the requested output geometry.
 */
export function analyseDepth({
  depth,
  width,
  height,
  repeat,
  strength = 0.55,
  mode = "parallel",
  referenceDepth = null,
  depthThreshold = 1 / 255,
}) {
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    !depth ||
    depth.length !== width * height
  )
    throw new RangeError(
      "Diagnostic depth must contain width × height samples",
    );
  if (!Number.isFinite(repeat) || repeat < 1)
    throw new RangeError("repeat must be at least one pixel");
  if (mode !== "parallel" && mode !== "cross")
    throw new RangeError("mode must be parallel or cross");
  if (referenceDepth && referenceDepth.length !== width * height * 4)
    throw new RangeError(
      "Diagnostic reference must have twice the width and height",
    );
  const model = geometry(repeat, strength, mode);
  const diagnosticMask = new Uint8Array(depth.length);
  const encoded = new Uint32Array(depth.length);
  const used = new Set();
  let minSeparation = Infinity,
    maxSeparation = 0;
  let changingEdges = 0,
    collapsedEdges = 0;
  depthThreshold = Number.isFinite(depthThreshold)
    ? Math.max(1e-6, depthThreshold)
    : 1 / 255;
  for (let i = 0; i < depth.length; i++) {
    const value = separation(unit(depth[i]), model);
    encoded[i] = value;
    used.add(value);
    minSeparation = Math.min(minSeparation, value);
    maxSeparation = Math.max(maxSeparation, value);
    for (const neighbour of [
      i % width ? i - 1 : -1,
      i >= width ? i - width : -1,
    ]) {
      if (
        neighbour < 0 ||
        Math.abs(unit(depth[i]) - unit(depth[neighbour])) < depthThreshold
      )
        continue;
      changingEdges++;
      if (encoded[neighbour] === value) {
        collapsedEdges++;
        diagnosticMask[i] |= 1;
        diagnosticMask[neighbour] |= 1;
      }
    }
  }
  let collapsedPixels = 0,
    subpixelPixels = referenceDepth ? 0 : null;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (diagnosticMask[i] & 1) collapsedPixels++;
      if (!referenceDepth) continue;
      const top = y * 4 * width + x * 2;
      const samples = [top, top + 1, top + width * 2, top + width * 2 + 1];
      let lo = Infinity,
        hi = 0;
      for (const p of samples) {
        const value = separation(unit(referenceDepth[p]), model);
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
      if (hi > lo) {
        diagnosticMask[i] |= 2;
        subpixelPixels++;
      }
    }
  return {
    diagnosticMask,
    diagnostics: {
      width,
      height,
      depthLevelsUsed: used.size,
      depthLevelsAvailable:
        Math.abs(separation(1, model) - separation(0, model)) + 1,
      minSeparation,
      maxSeparation,
      changingEdges,
      collapsedEdges,
      collapsedPixels,
      subpixelPixels,
      referenceScale: referenceDepth ? 2 : 1,
      depthThreshold,
    },
  };
}

/**
 * @param {object} options
 * @param {Float32Array|number[]} options.depth Row-major samples, 0 far to 1 near.
 * @param {number} options.width Output width in pixels.
 * @param {number} options.height Output height in pixels.
 * @param {number} options.repeat Background repeat width in output pixels.
 * @param {number} options.strength Depth amount, clamped to 0…1.
 * @param {'parallel'|'cross'} [options.mode='parallel'] Viewing convention.
 * @param {number|string} [options.seed=1] Repeatable pattern seed.
 * @param {'verdigris'|'mineral'|'ink'|'ochre'} [options.palette='verdigris']
 * @param {number} [options.grain=2] Approximate dot size in output pixels.
 * @param {{data:Uint8ClampedArray,width:number,height:number}|null} [options.texture]
 * @returns {{pixels:Uint8ClampedArray,stats:object}} Opaque RGBA pixels and geometry.
 */
export function renderStereogram({
  depth,
  width,
  height,
  repeat,
  strength = 0.55,
  mode = "parallel",
  seed = 1,
  palette = "verdigris",
  grain = 2,
  texture = null,
  textureStyle = "stipple",
  textureRepeat = "both",
  textureScale = 100,
}) {
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    width * height > 64_000_000
  ) {
    throw new RangeError(
      "width and height must be positive integers (at most 64 million pixels)",
    );
  }
  if (!depth || depth.length !== width * height)
    throw new RangeError("depth must contain width × height samples");
  if (!Number.isFinite(repeat) || repeat < 1)
    throw new RangeError("repeat must be at least one pixel");
  if (mode !== "parallel" && mode !== "cross")
    throw new RangeError("mode must be parallel or cross");
  if (!RGB[palette]) throw new RangeError(`Unknown palette: ${palette}`);
  if (!textureStyleNames.includes(textureStyle))
    throw new RangeError(`Unknown texture style: ${textureStyle}`);

  const model = geometry(repeat, strength, mode);
  const tile = validateTexture(texture);
  const colours = RGB[palette];
  // Export scales the preview grain with resolution (up to 9 px in this UI).
  const dotSize = Number.isFinite(grain) ? clamp(grain, 1, 32) : 2;
  // Fit a whole number of pattern cells into the background repeat. Otherwise
  // cutting a cell at each repeat produces a vertical line of extra contrast.
  const cellsPerRepeat = Math.max(1, Math.round(model.repeat / dotSize));
  const cellWidth = model.repeat / cellsPerRepeat;
  const patternSeed = normaliseSeed(seed);
  const generatedTile =
    !tile && textureStyle !== "stipple"
      ? proceduralTile(
          textureStyle,
          palette,
          model.repeat,
          dotSize,
          patternSeed,
        )
      : null;
  const zoom =
    clamp(Number.isFinite(textureScale) ? textureScale : 100, 100, 200) / 100;
  const pixels = new Uint8ClampedArray(width * height * 4);
  // Equal-colour constraints copy a complete RGBA word, independent of native
  // byte order. Most pixels are linked, so this is the main output hot path.
  const packedPixels = new Uint32Array(pixels.buffer);
  const links = new Int32Array(width);
  const scanline = new Float32Array(width);
  let constraints = 0;
  let occluded = 0;
  let candidates = 0;
  let freePixels = 0;
  let minSeparation = Infinity;
  let maxSeparation = -Infinity;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      links[x] = x;
      scanline[x] = unit(depth[row + x]);
    }

    for (let x = 0; x < width; x++) {
      const z = scanline[x];
      const distance = separation(z, model);
      minSeparation = Math.min(minSeparation, distance);
      maxSeparation = Math.max(maxSeparation, distance);
      // Alternate half-pixel rounding on odd scanlines: neither eye is favoured.
      let left = x - Math.floor((distance + (distance & y & 1)) / 2);
      let right = left + distance;
      if (left < 0 || right >= width) continue;
      candidates++;

      // Follow both lines of sight toward the viewer. If a nearer depth sample
      // meets either ray, this point must not contribute a binocular constraint.
      // For cross viewing the scene is in front of the screen; the same ray
      // equation follows from q/D=(1+mu*z)/3 (see RENDERER.md).
      let visible = true;
      if (model.mu > 0) {
        const rise = (2 - model.mu * z) / (model.mu * model.repeat);
        for (let offset = 1; z + rise * offset <= 1; offset++) {
          const rayDepth = z + rise * offset;
          if (
            (x - offset >= 0 && scanline[x - offset] >= rayDepth) ||
            (x + offset < width && scanline[x + offset] >= rayDepth)
          ) {
            visible = false;
            break;
          }
        }
      }
      if (!visible) {
        occluded++;
        continue;
      }

      // Merge sorted chains of equal-colour pixels. Every link points right,
      // allowing the final pass to assign colours without recursion or cycles.
      let next = links[left];
      while (next !== left && next !== right) {
        if (next < right) left = next;
        else {
          left = right;
          right = next;
        }
        next = links[left];
      }
      links[left] = right;
      constraints++;
    }

    const band = Math.floor(y / dotSize);
    const patternOffset = (hash(0, band, patternSeed) & 255) / 256;
    for (let x = width - 1; x >= 0; x--) {
      const pixelIndex = row + x;
      const destination = pixelIndex * 4;
      if (links[x] !== x) {
        packedPixels[pixelIndex] = packedPixels[row + links[x]];
        continue;
      } else if (tile) {
        // A tile spans one background repeat, preserving its aspect ratio.
        // Transparency is composited onto the lightest palette colour.
        const source = textureSource(
          tile,
          x,
          y,
          model.repeat,
          height,
          zoom,
          textureRepeat,
        );
        const alpha = tile.data[source + 3] / 255;
        for (let channel = 0; channel < 3; channel++) {
          pixels[destination + channel] =
            tile.data[source + channel] * alpha +
            colours[5][channel] * (1 - alpha);
        }
        freePixels++;
      } else if (generatedTile) {
        const source =
          ((y % generatedTile.height) * generatedTile.width +
            (x % model.repeat)) *
          4;
        for (let channel = 0; channel < 3; channel++)
          pixels[destination + channel] = generatedTile.data[source + channel];
        freePixels++;
      } else {
        // Tiny deterministic irregular cells make a richly textured random-dot
        // field. This coordinate-only pattern never reads the scene depth.
        const cell =
          Math.floor((x % model.repeat) / cellWidth + patternOffset) %
          cellsPerRepeat;
        const random = hash(cell, band, patternSeed);
        const colour = colours[random & 7];
        const variation = ((random >>> 8) & 7) - 3;
        for (let channel = 0; channel < 3; channel++)
          pixels[destination + channel] = colour[channel] + variation;
        freePixels++;
      }
      pixels[destination + 3] = 255;
    }
  }

  return {
    pixels,
    stats: {
      width,
      height,
      repeat: model.repeat,
      strength: unit(strength),
      mode,
      farSeparation: separation(0, model),
      nearSeparation: separation(1, model),
      minSeparation,
      maxSeparation,
      depthLevels: Math.abs(separation(1, model) - separation(0, model)) + 1,
      constraints,
      occluded,
      candidates,
      freePixels,
    },
  };
}
