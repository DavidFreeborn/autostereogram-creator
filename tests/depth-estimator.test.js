import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDepth,
  validateDepthInput,
  DEPTH_MODEL,
} from "../src/depth-estimator.js";

test("relative depth preserves ordering and clamps rare extremes", () => {
  const input = Float32Array.from({ length: 1001 }, (_, i) => i);
  input[1000] = 1_000_000;
  const result = normalizeDepth(input);
  assert.equal(result.low, 10);
  assert.equal(result.high, 990);
  assert.equal(result.data[0], 0);
  assert.equal(result.data[1000], 1);
  assert.ok(Math.abs(result.data[500] - 0.5) < 1e-6);
  assert.equal(input[1000], 1_000_000, "input is unchanged");
});

test("flat and partially invalid predictions produce finite, bounded depths", () => {
  assert.deepEqual(
    [...normalizeDepth(new Float32Array([8, 8, 8])).data],
    [0.5, 0.5, 0.5],
  );
  const result = normalizeDepth(new Float32Array([NaN, 2, Infinity, 4]));
  assert.equal(result.invalid, 2);
  assert.deepEqual([...result.data], [0, 0, 0, 1]);
  assert.throws(
    () => normalizeDepth(new Float32Array([NaN, Infinity])),
    /finite/,
  );
  assert.throws(() => normalizeDepth(new Float32Array()), /empty/);
  assert.throws(
    () => normalizeDepth(new Float32Array([1]), { lower: 0.8, upper: 0.2 }),
    /quantiles/,
  );
});

test("photographs must have bounded, complete RGBA pixel buffers", () => {
  assert.doesNotThrow(() =>
    validateDepthInput({
      width: 100,
      height: 100,
      data: new Uint8ClampedArray(40_000),
    }),
  );
  assert.throws(
    () =>
      validateDepthInput({ width: 100, height: 100, data: new Uint8Array(4) }),
    /photograph/,
  );
  assert.throws(
    () =>
      validateDepthInput({
        width: 900,
        height: 100,
        data: new Uint8Array(360_000),
      }),
    /aspect ratio/,
  );
  assert.throws(
    () =>
      validateDepthInput({
        width: 5000,
        height: 5000,
        data: new Uint8Array(4),
      }),
    /photograph/,
  );
});

test("optional model and runtime use immutable, publicly licensed versions", () => {
  assert.match(DEPTH_MODEL.revision, /^[a-f0-9]{40}$/);
  assert.equal(DEPTH_MODEL.license, "Apache-2.0");
  assert.match(DEPTH_MODEL.runtime, /@3\.8\.1\/dist\/transformers\.min\.js$/);
});
