import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, composeDepth, sampleLayerDepth } from "../src/scene.js";
import {
  renderStereogram,
  renderTextureSample,
  analyseDepth,
} from "../src/stereogram.js";
import {
  defaultSettings,
  serialiseProject,
  parseProject,
} from "../src/editor.js";
test("carving is ordered and intersection removes the exterior", () => {
  const base = { ...createLayer("box"), size: 1, depth: 0.8, profile: "flat" };
  const cut = {
    ...createLayer("box"),
    size: 0.4,
    depth: 0.3,
    profile: "flat",
    operation: "subtract",
  };
  const depth = composeDepth({ layers: [base, cut] }, 100, 100);
  assert.ok(Math.abs(depth[5050] - 0.5) < 1e-6);
  assert.ok(
    Math.abs(composeDepth({ layers: [cut, base] }, 100, 100)[5050] - 0.8) <
      1e-6,
  );
  const intersect = composeDepth(
    { layers: [base, { ...cut, operation: "intersect" }] },
    100,
    100,
  );
  assert.ok(Math.abs(intersect[5050] - 0.3) < 1e-6);
  assert.equal(intersect[1010], 0);
});
test("sloping surfaces follow their direction and lower edge setting", () => {
  const shape = {
    ...createLayer("box"),
    size: 1,
    depth: 1,
    profile: "gradient",
    gradientAngle: 0,
    gradientFloor: 0.2,
  };
  assert.ok(
    sampleLayerDepth(shape, 0.8, 0.5, 100, 100) >
      sampleLayerDepth(shape, 0.2, 0.5, 100, 100),
  );
  assert.ok(
    sampleLayerDepth({ ...shape, gradientAngle: 180 }, 0.8, 0.5, 100, 100) <
      sampleLayerDepth({ ...shape, gradientAngle: 180 }, 0.2, 0.5, 100, 100),
  );
});
test("all generated texture families retain exact flat-plane correspondences", () => {
  const fingerprints = new Set();
  for (const textureStyle of ["stipple", "mineral", "paper", "organic"]) {
    const options = {
      width: 180,
      height: 60,
      repeat: 30,
      depth: new Float32Array(180 * 60),
      textureStyle,
      seed: 12,
    };
    const { pixels } = renderStereogram(options);
    assert.deepEqual(pixels, renderStereogram(options).pixels);
    for (let y = 0; y < 60; y++)
      for (let x = 0; x < 150; x++)
        assert.deepEqual(
          pixels.slice((y * 180 + x) * 4, (y * 180 + x) * 4 + 4),
          pixels.slice((y * 180 + x + 30) * 4, (y * 180 + x + 30) * 4 + 4),
        );
    fingerprints.add(Buffer.from(pixels).toString("base64"));
  }
  assert.equal(fingerprints.size, 4);
});
test("horizontal-only texture mapping retains one vertical extent", () => {
  const texture = {
    width: 2,
    height: 2,
    data: Uint8ClampedArray.from([
      255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    ]),
  };
  const a = renderTextureSample({
    texture,
    width: 80,
    height: 80,
    repeat: 20,
    textureRepeat: "horizontal",
  }).pixels;
  const b = renderTextureSample({
    texture,
    width: 80,
    height: 80,
    repeat: 20,
    textureRepeat: "both",
  }).pixels;
  assert.deepEqual([...a.slice(10 * 80 * 4, 10 * 80 * 4 + 3)], [255, 0, 0]);
  assert.deepEqual([...a.slice(70 * 80 * 4, 70 * 80 * 4 + 3)], [0, 0, 255]);
  assert.notDeepEqual(a, b);
});
test("diagnostics count actual encoded levels and collapsed depth edges", () => {
  const flat = analyseDepth({
    width: 10,
    height: 10,
    depth: new Float32Array(100).fill(0.5),
    repeat: 90,
    strength: 0.5,
  });
  assert.equal(flat.diagnostics.depthLevelsUsed, 1);
  assert.equal(flat.diagnostics.collapsedEdges, 0);
  const depth = Float32Array.from({ length: 100 }, (_, i) =>
    i % 2 ? 0.504 : 0.5,
  );
  const data = analyseDepth({
    width: 10,
    height: 10,
    depth,
    repeat: 90,
    strength: 0,
  });
  assert.equal(data.diagnostics.depthLevelsUsed, 1);
  assert.ok(data.diagnostics.collapsedEdges > 0);
});
test("new texture and surface properties survive a project roundtrip", () => {
  const state = {
    scene: {
      name: "New controls",
      layers: [
        {
          ...createLayer("text"),
          text: "CUT",
          operation: "subtract",
          bevel: 0.06,
          profile: "gradient",
          gradientAngle: 35,
          gradientFloor: 0.3,
        },
      ],
    },
    settings: {
      ...defaultSettings,
      textureStyle: "organic",
      textureRepeat: "horizontal",
      textureScale: 145,
    },
    document: { width: 1100, height: 660 },
  };
  const next = parseProject(serialiseProject(state));
  for (const key of [
    "operation",
    "bevel",
    "profile",
    "gradientAngle",
    "gradientFloor",
  ])
    assert.equal(next.scene.layers[0][key], state.scene.layers[0][key]);
  for (const key of ["textureStyle", "textureRepeat", "textureScale"])
    assert.equal(next.settings[key], state.settings[key]);
});
