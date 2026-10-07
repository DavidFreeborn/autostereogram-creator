import test from "node:test";
import assert from "node:assert/strict";
import {
  createLayer,
  createPreset,
  layerBounds,
  layerLocalPoint,
  sampleLayerDepth,
  composeDepth,
  blurDepth,
  transformDepth,
  renderRelief,
  sceneCacheStats,
  clearSceneCache,
} from "../src/scene.js";
import { renderFrame } from "../src/worker.js";
import { renderStereogram } from "../src/stereogram.js";

const W = 200,
  H = 120;
const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} should equal ${expected}`,
  );
const at = (layer, x, y) => sampleLayerDepth(layer, x, y, W, H);
const plate = (overrides = {}) => ({
  ...createLayer("box"),
  size: 0.8,
  aspect: 0.3,
  depth: 0.8,
  profile: "flat",
  roundness: 0,
  ...overrides,
});

test("rotation uses physical scene coordinates and preserves non-square shapes", () => {
  const layer = plate();
  close(at(layer, 0.68, 0.5), 0.8);
  close(at(layer, 0.5, 0.8), 0);
  layer.rotation = 90;
  close(at(layer, 0.68, 0.5), 0);
  close(at(layer, 0.5, 0.8), 0.8);
  const b = layerBounds(layer, W, H);
  close(b.halfWidth, 48 / W);
  close(b.halfHeight, 14.4 / H);
  const local = layerLocalPoint(layer, 0.5, 0.8, W, H);
  close(local.u, 0.875);
  close(local.v, 0.5);
});

test("mask erasing reveals the lower surface and follows rotation and resizing", () => {
  const back = plate({ aspect: 1, depth: 0.3, size: 1.3 });
  const front = plate({
    aspect: 1,
    mask: { width: 2, height: 2, data: new Float32Array([1, 0, 1, 0]) },
  });
  close(at(front, 0.38, 0.5), 0);
  close(at(front, 0.62, 0.5), 0.8);
  const depth = composeDepth({ layers: [back, front] }, W, H);
  close(depth[60 * W + 75], 0.3);
  close(depth[60 * W + 124], 0.8);
  front.rotation = 90;
  front.scaleX = 1.5;
  close(at(front, 0.5, 0.2), 0);
  close(at(front, 0.5, 0.8), 0.8);
  // Editing existing mask data does not require replacing the layer or mask.
  front.mask.data.fill(1);
  close(at(front, 0.5, 0.8), 0);
});

test("inverse transforms include independent scales and reflected local fields", () => {
  const layer = plate({ aspect: 1, scaleX: 2, scaleY: 0.5 });
  close(at(layer, 0.9, 0.5), 0.8);
  close(at(layer, 0.5, 0.75), 0);
  layer.scaleX = -2;
  const { u, v } = layerLocalPoint(layer, 0.74, 0.5, W, H);
  close(u, 0.25);
  close(v, 0.5);
  layer.scaleX = 0;
  close(at(layer, 0.5, 0.5), 0);
  assert.ok(
    composeDepth({ layers: [layer] }, W, H).every((value) => value === 0),
  );
});

test("depth picking agrees with composed front surfaces for transformed geometry", () => {
  const types = [
    "sphere",
    "ellipsoid",
    "torus",
    "box",
    "cone",
    "pyramid",
    "cylinder",
    "terrain",
  ];
  for (const type of types) {
    const layer = {
      ...createLayer(type),
      x: 0.46,
      y: 0.53,
      rotation: 31,
      scaleX: 1.2,
      scaleY: 0.8,
    };
    const depth = composeDepth({ layers: [layer] }, W, H);
    assert.ok(
      depth.some((value) => value > 0.2),
      `${type} should render`,
    );
    for (let y = 0; y < H; y += 7)
      for (let x = 0; x < W; x += 7)
        close(depth[y * W + x], at(layer, (x + 0.5) / W, (y + 0.5) / H), 2e-6);
    assert.ok(
      depth.every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      ),
    );
  }
});

test("holes and hidden layers cannot be selected by their bounding rectangle", () => {
  const ring = createLayer("torus");
  close(at(ring, 0.5, 0.5), 0);
  assert.ok(at(ring, 0.5 + (0.69 * ring.size * H) / (2 * W), 0.5) > 0.65);
  ring.visible = false;
  close(at(ring, 0.5 + (0.69 * ring.size * H) / (2 * W), 0.5), 0);
});

test("extreme aspect transforms keep antialiasing and picking within physical bounds", () => {
  for (const type of ["sphere", "torus", "box", "cylinder"]) {
    const layer = {
      ...createLayer(type),
      scaleX: 3,
      scaleY: 0.05,
      rotation: 37,
    };
    const depth = composeDepth({ layers: [layer] }, W, H);
    for (let y = 0; y < H; y += 2)
      for (let x = 0; x < W; x += 2)
        close(depth[y * W + x], at(layer, (x + 0.5) / W, (y + 0.5) / H), 2e-6);
  }
});

test("new primitive profiles have predictable physical depth surfaces", () => {
  for (const type of ["cone", "pyramid", "cylinder", "ellipsoid"]) {
    const layer = { ...createLayer(type), size: 0.8, aspect: 1, depth: 0.9 };
    close(at(layer, 0.5, 0.5), 0.9);
    assert.ok(at(layer, 0.62, 0.5) < 0.9);
    layer.profile = "flat";
    close(at(layer, 0.62, 0.5), 0.9);
  }
});

test("explicit rounded profiles override legacy flat flags and presets report their profile", () => {
  const terraces = createPreset("terraces");
  assert.ok(terraces.layers.every((layer) => layer.profile === "flat"));
  const layer = plate({ flat: true, aspect: 1 });
  const nearEdge = at(layer, 0.72, 0.5);
  layer.profile = "rounded";
  assert.ok(at(layer, 0.72, 0.5) < nearEdge);
});

test("decoded image sources retain their aspect, transparency, inversion and fit", () => {
  const rgba = new Uint8ClampedArray(4 * 2 * 4).fill(255);
  // First source column is transparent.
  rgba[3] = rgba[19] = 0;
  const layer = {
    ...createLayer("image"),
    size: 1,
    depth: 0.8,
    imageData: { width: 4, height: 2, data: rgba },
  };
  close(layerBounds(layer, W, H).halfHeight, 0.25);
  close(at(layer, 0.65, 0.5), 0.8);
  close(at(layer, 0.24, 0.5), 0);
  layer.invert = true;
  close(at(layer, 0.65, 0.5), 0);
  layer.invert = false;
  layer.aspect = 1;
  close(at(layer, 0.6, 0.85), 0, 1e-6);
  layer.fit = "cover";
  close(at(layer, 0.6, 0.85), 0.8, 1e-6);
});

test("paint is a movable depth layer with masks and resolution independent sampling", () => {
  const layer = {
    ...createLayer("paint"),
    size: 1,
    depth: 0.8,
    field: {
      width: 3,
      height: 2,
      data: new Float32Array([0, 0.5, 1, 0, 0.5, 1]),
    },
  };
  close(at(layer, 0.5, 0.5), 0.4);
  close(sampleLayerDepth(layer, 0.5, 0.5, W * 3, H * 3), 0.4);
  layer.x = 0.6;
  close(at(layer, 0.6, 0.5), 0.4);
  layer.mask = { width: 1, height: 1, data: new Float32Array([0.5]) };
  close(at(layer, 0.6, 0.5), 0.2);
  layer.field.data.fill(1);
  close(at(layer, 0.6, 0.5), 0.4);
});

test("max-depth composition is independent of layer order and preserves legacy paint", () => {
  const layers = [
    plate({ aspect: 1, depth: 0.3 }),
    { ...createLayer("sphere"), depth: 0.9 },
  ];
  assert.deepEqual(
    composeDepth({ layers }, W, H),
    composeDepth({ layers: layers.slice().reverse() }, W, H),
  );
  const depth = composeDepth(
    { layers, paint: { width: 1, height: 1, data: new Float32Array([0.4]) } },
    W,
    H,
  );
  close(depth[0], 0.4);
  assert.ok(depth[60 * W + 100] > 0.8);
});

test("linear-time blur preserves constant fields and matches a reference filter", () => {
  const width = 9,
    height = 7,
    radius = 2;
  const data = Float32Array.from(
    { length: width * height },
    (_, i) => (i % 11) / 10,
  );
  const result = blurDepth(data, width, height, radius);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++)
          sum +=
            data[
              Math.min(height - 1, Math.max(0, y + dy)) * width +
                Math.min(width - 1, Math.max(0, x + dx))
            ];
      close(result[y * width + x], sum / 25);
    }
  assert.ok(
    blurDepth(new Float32Array(4).fill(0.5), 2, 2, 8).every(
      (value) => value === 0.5,
    ),
  );
});

test("frame pipeline reproduces serial composition and stereo settings", () => {
  const width = 220,
    height = 132,
    scene = createPreset();
  const settings = {
    invert: true,
    levels: 5,
    soften: 5,
    strength: 63,
    repeat: 95,
    grain: 3,
    palette: "mineral",
    mode: "cross",
    seed: 48,
  };
  const result = renderFrame({ width, height, scene, settings });
  const depth = transformDepth(
    composeDepth(scene, width, height),
    width,
    height,
    settings,
  );
  assert.deepEqual(result.depth, depth);
  const stereo = renderStereogram({
    width,
    height,
    depth,
    strength: 0.63,
    repeat: 19,
    grain: 0.6,
    palette: "mineral",
    mode: "cross",
    seed: 48,
  });
  assert.deepEqual(result.pixels, stereo.pixels);
  assert.deepEqual(result.stats, stereo.stats);
  assert.deepEqual(result.relief, renderRelief(depth, width, height));
  assert.ok(result.timing.total >= 0);
  for (let i = 3; i < result.relief.length; i += 4)
    assert.equal(result.relief[i], 255);
  assert.throws(() => renderFrame({ width: 0, height, scene }), /dimensions/);
});

test("worker raster cache reuses surfaces but invalidates changed masks and transforms", () => {
  clearSceneCache();
  const layer = {
    ...plate({ aspect: 1 }),
    _cacheKey: "field-1|mask-1:0",
    mask: { width: 2, height: 2, data: new Float32Array(4) },
  };
  const scene = { layers: [layer] };
  const first = composeDepth(scene, W, H);
  assert.equal(sceneCacheStats().misses, 1);
  assert.deepEqual(composeDepth(structuredClone(scene), W, H), first);
  assert.equal(sceneCacheStats().hits, 1);
  layer.mask.data.fill(1);
  layer._cacheKey = "field-1|mask-1:1";
  assert.ok(composeDepth(scene, W, H).every((z) => z === 0));
  assert.equal(sceneCacheStats().misses, 2);
  layer.mask.data.fill(0);
  layer._cacheKey = "field-1|mask-1:2";
  layer.x = 0.65;
  layer.rotation = 25;
  const cached = composeDepth(scene, W, H);
  const uncachedLayer = { ...layer };
  delete uncachedLayer._cacheKey;
  assert.deepEqual(cached, composeDepth({ layers: [uncachedLayer] }, W, H));
  composeDepth(scene, W * 2, H * 2);
  composeDepth(scene, W * 3, H * 3);
  assert.equal(sceneCacheStats().entries, 2);
  assert.ok(sceneCacheStats().bytes <= 64 * 1024 * 1024);
  clearSceneCache();
});

test("output-specific export skips unused rendering without changing requested pixels", () => {
  const request = {
    scene: createPreset(),
    width: 220,
    height: 132,
    settings: { soften: 1 },
  };
  const all = renderFrame(request);
  for (const output of ["stereo", "depth", "relief"]) {
    const frame = renderFrame({ ...request, output });
    assert.deepEqual(frame.depth, all.depth);
    assert.deepEqual(
      frame.pixels,
      output === "stereo" ? all.pixels : undefined,
    );
    assert.deepEqual(
      frame.relief,
      output === "relief" ? all.relief : undefined,
    );
  }
  assert.throws(() => renderFrame({ ...request, output: "unknown" }), /output/);
});
