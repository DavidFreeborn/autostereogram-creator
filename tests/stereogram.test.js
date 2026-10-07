import test from "node:test";
import assert from "node:assert/strict";
import {
  renderStereogram,
  separationForDepth,
  paletteNames,
} from "../src/stereogram.js";

const width = 320;
const height = 40;
const defaults = {
  width,
  height,
  repeat: 40,
  strength: 1,
  grain: 2,
  seed: 145,
};
const flat = (z) => new Float32Array(width * height).fill(z);
const pixel = (pixels, x, y) =>
  pixels.subarray((y * width + x) * 4, (y * width + x + 1) * 4);

test("flat depth has exact horizontal repeat at the geometric separation", () => {
  for (const mode of ["parallel", "cross"]) {
    for (const z of [0, 0.25, 0.6, 1]) {
      const { pixels, stats } = renderStereogram({
        ...defaults,
        depth: flat(z),
        mode,
      });
      const distance = separationForDepth(z, defaults.repeat, 1, mode);
      assert.equal(stats.occluded, 0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width - distance; x++) {
          assert.deepEqual(pixel(pixels, x, y), pixel(pixels, x + distance, y));
        }
      }
    }
  }
});

test("near plateau carries its own correspondence and occludes background at edges", () => {
  const depth = flat(0);
  for (let y = 0; y < height; y++) {
    depth.fill(1, y * width + 110, y * width + 210);
  }
  for (const mode of ["parallel", "cross"]) {
    const { pixels, stats } = renderStereogram({ ...defaults, depth, mode });
    const distance = separationForDepth(1, defaults.repeat, 1, mode);
    assert.ok(stats.occluded > 0, "hidden background constraints are removed");
    for (let y = 0; y < height; y++) {
      for (let x = 110; x < 210; x++) {
        const left = x - Math.floor((distance + (distance & y & 1)) / 2);
        assert.deepEqual(
          pixel(pixels, left, y),
          pixel(pixels, left + distance, y),
        );
      }
    }
  }
});

test("a rectangular foreground removes the analytically expected background interval", () => {
  const depth = flat(0);
  for (let y = 0; y < height; y++)
    depth.fill(1, y * width + 110, y * width + 210);
  // A far-plane ray reaches z=1 at horizontal offset mu*r/2. A plateau
  // therefore occludes floor(mu*r/2) background samples on each side.
  for (const [mode, mu] of [
    ["parallel", 1 / 3],
    ["cross", 1 / 8],
  ]) {
    const { pixels, stats } = renderStereogram({ ...defaults, depth, mode });
    const hiddenOnEachSide = Math.floor((mu * defaults.repeat) / 2);
    assert.equal(stats.occluded, 2 * hiddenOnEachSide * height);
    let distinguishable = 0;
    for (let y = 0; y < height; y++) {
      // The immediately hidden background point is no longer forced to match.
      const x = 109;
      const left = x - defaults.repeat / 2;
      if (
        !pixel(pixels, left, y).every(
          (value, i) => value === pixel(pixels, left + defaults.repeat, y)[i],
        )
      )
        distinguishable++;
    }
    assert.ok(
      distinguishable > height * 0.7,
      "occluded correspondences are actually released",
    );
  }
});

test("overlapping constraint chains retain every visible surface correspondence", () => {
  const depth = flat(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const wave = 0.5 + 0.25 * Math.sin(x / 9 + y / 7) + 0.2 * Math.sin(x / 3);
      depth[y * width + x] = x > 90 && x < 220 ? wave : 0;
    }
  }
  for (const [mode, mu] of [
    ["parallel", 1 / 3],
    ["cross", 1 / 8],
  ]) {
    const { pixels } = renderStereogram({ ...defaults, depth, mode, grain: 1 });
    let checked = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const z = depth[y * width + x];
        const distance = separationForDepth(z, defaults.repeat, 1, mode);
        const left = x - Math.floor((distance + (distance & y & 1)) / 2);
        const right = left + distance;
        if (left < 0 || right >= width) continue;
        // Reference ray parameterisation: the eye lies at z=2/mu and
        // horizontal distance r from the point in the model's local geometry.
        const eyeDepth = 2 / mu;
        let visible = true;
        for (let t = 1; t < defaults.repeat; t++) {
          const rayZ = z + ((eyeDepth - z) * t) / defaults.repeat;
          if (rayZ > 1) break;
          if (
            (x >= t && depth[y * width + x - t] >= rayZ) ||
            (x + t < width && depth[y * width + x + t] >= rayZ)
          ) {
            visible = false;
            break;
          }
        }
        if (visible) {
          assert.deepEqual(pixel(pixels, left, y), pixel(pixels, right, y));
          checked++;
        }
      }
    }
    assert.ok(checked > (width * height) / 2);
  }
});

test("a seed deterministically reproduces a texture while a different seed changes it", () => {
  const options = { ...defaults, depth: flat(0.4) };
  const first = renderStereogram(options);
  assert.deepEqual(first, renderStereogram(options));
  assert.notDeepEqual(
    first.pixels,
    renderStereogram({ ...options, seed: 146 }).pixels,
  );
});

test("depth is encoded only through correspondences", () => {
  const first = renderStereogram({ ...defaults, strength: 0, depth: flat(0) });
  const second = renderStereogram({ ...defaults, strength: 0, depth: flat(1) });
  assert.deepEqual(
    first.pixels,
    second.pixels,
    "zero disparity suppresses all scene information",
  );
});

test("subpixel disparity details quantise away rather than being painted into the texture", () => {
  const shallow = flat(0);
  for (let y = 0; y < height; y++)
    shallow.fill(0.01, y * width + 110, y * width + 210);
  for (const mode of ["parallel", "cross"]) {
    const background = renderStereogram({ ...defaults, depth: flat(0), mode });
    const detail = renderStereogram({ ...defaults, depth: shallow, mode });
    assert.equal(
      separationForDepth(0.01, defaults.repeat, 1, mode),
      defaults.repeat,
    );
    assert.deepEqual(background.pixels, detail.pixels);
  }
});

test("grain does not introduce a vertical contrast seam at background repeats", () => {
  const seamWidth = 400;
  const seamHeight = 1024;
  const repeat = 100;
  const { pixels } = renderStereogram({
    width: seamWidth,
    height: seamHeight,
    repeat,
    strength: 0.6,
    grain: 2,
    seed: 145,
    depth: new Float32Array(seamWidth * seamHeight),
  });
  const contrast = [];
  for (let x = repeat; x < 2 * repeat; x++) {
    let total = 0;
    for (let y = 0; y < seamHeight; y++) {
      const i = (y * seamWidth + x) * 4;
      total +=
        Math.abs(pixels[i] - pixels[i - 4]) +
        Math.abs(pixels[i + 1] - pixels[i - 3]) +
        Math.abs(pixels[i + 2] - pixels[i - 2]);
    }
    contrast.push(total / seamHeight);
  }
  const mean =
    contrast.reduce((sum, value) => sum + value, 0) / contrast.length;
  assert.ok(
    contrast[0] < mean * 1.3,
    "the tile boundary should have ordinary adjacent-column contrast",
  );
  assert.ok(
    Math.max(...contrast) < mean * 1.35,
    "no fixed column should form a high-contrast seam",
  );
});

test("separations are bounded, monotonic, and reverse for cross viewing", () => {
  for (const strength of [0, 0.1, 0.6, 1]) {
    let previousParallel = 100;
    let previousCross = 100;
    for (let index = 0; index <= 100; index++) {
      const z = index / 100;
      const parallel = separationForDepth(z, 100, strength, "parallel");
      const cross = separationForDepth(z, 100, strength, "cross");
      assert.ok(
        parallel >= 80 && parallel <= 100 && parallel <= previousParallel,
      );
      assert.ok(cross >= 100 && cross <= 120 && cross >= previousCross);
      previousParallel = parallel;
      previousCross = cross;
    }
    assert.equal(
      separationForDepth(1, 100, strength),
      Math.round(100 - 20 * strength),
    );
    assert.equal(
      separationForDepth(1, 100, strength, "cross"),
      Math.round(100 + 20 * strength),
    );
  }
});

test("all palettes produce finite opaque pixels with usable texture variation", () => {
  const depth = flat(0);
  for (let i = 0; i < depth.length; i++) depth[i] = (Math.sin(i / 17) + 1) / 2;
  depth[0] = NaN;
  depth[1] = Infinity;
  depth[2] = -2;
  depth[3] = 20;
  for (const palette of paletteNames) {
    const { pixels } = renderStereogram({ ...defaults, depth, palette });
    assert.equal(pixels.length, width * height * 4);
    const colours = new Set();
    for (let i = 0; i < pixels.length; i += 4) {
      assert.equal(pixels[i + 3], 255);
      assert.ok(Number.isFinite(pixels[i]));
      colours.add(pixels.subarray(i, i + 3).join(","));
    }
    assert.ok(colours.size > 8);
  }
});

test("custom texture colours obey the same exact correspondence", () => {
  const texture = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0,
    ]),
  };
  const { pixels } = renderStereogram({
    ...defaults,
    depth: flat(0.5),
    texture,
  });
  const distance = separationForDepth(0.5, defaults.repeat, defaults.strength);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - distance; x++) {
      assert.deepEqual(pixel(pixels, x, y), pixel(pixels, x + distance, y));
    }
  }
});

test("invalid dimensions and underspecified data fail with descriptive errors", () => {
  assert.throws(() => renderStereogram({ ...defaults, depth: [0] }), /samples/);
  assert.throws(
    () => renderStereogram({ ...defaults, width: 0, depth: [] }),
    /positive integers/,
  );
  assert.throws(
    () => renderStereogram({ ...defaults, depth: flat(0), repeat: NaN }),
    /repeat/,
  );
  assert.throws(
    () =>
      renderStereogram({
        ...defaults,
        depth: flat(0),
        texture: { width: 1, height: 1, data: [] },
      }),
    /RGBA/,
  );
});
