# Autostereogram renderer

`src/stereogram.js` is a dependency-free ES module. It uses the symmetric constraint method and hidden-surface ray tests described by Harold Thimbleby, Ian Witten and Stuart Inglis. The implementation keeps all valid pairwise colour constraints; it does not shade or superimpose the depth map.

Primary references:

- [Author-hosted paper, Figure 3 and geometry/occlusion derivation](https://harold.thimbleby.net/sirds/ieee3d.pdf).
- [University of Waikato record of the 1994 IEEE Computer article](https://researchcommons.waikato.ac.nz/entities/publication/0deacc2b-e333-4e6d-9d19-a5ad8d28598f).

## API

```js
import {
  renderStereogram,
  separationForDepth,
  paletteNames,
} from "./src/stereogram.js";

const { pixels, stats } = renderStereogram({
  depth, // width × height row-major values; 0 far, 1 near
  width,
  height, // integer pixel dimensions
  repeat: 100, // far-plane separation, in output pixels
  strength: 0.55, // 0…1
  mode: "parallel", // or 'cross'
  seed: 1, // number or string
  palette: "verdigris", // mineral, ink, ochre
  grain: 2, // approximate pattern-cell size in output pixels
  texture: null, // optional {width,height,data}, with RGBA data
});
```

`pixels` is an opaque `Uint8ClampedArray`, suitable for `new ImageData(pixels, width, height)`. `stats` provides `farSeparation`, `nearSeparation`, `minSeparation`, `maxSeparation`, `depthLevels`, `constraints`, `occluded`, `candidates`, `freePixels` and the normalised dimensions/parameters. `separationForDepth(z, repeat, strength, mode)` returns the rounded separation for annotations or diagnostics.

All scene depths are clamped to 0…1, with nonfinite samples treated as background. A fixed seed produces identical pixels. Palette and texture samples are functions only of pattern coordinates; depth determines equality constraints, never brightness. Generated noise uses a whole number of grain cells per background repeat and wraps the cells across the tile boundary. This avoids a fixed vertical line of excess contrast from cutting a grain cell in half at every repeat. An uploaded tile is scaled to one background repeat with its aspect ratio intact, and transparency is composited onto a light palette colour; non-seamless uploaded images can still show their own tile edges.

## Geometry

Let the baseline repeat be `r`, the notional eye separation be `E = 2r`, and the slider amplitude be `a = 0.2 × strength`.

For **parallel viewing**, use the paper's geometry with `mu = 2a / (1+a)`:

`s(z) = E(1−mu z)/(2−mu z)`.

Thus far separation is `r`, and near separation is `r(1−a)`. At maximum strength, the full depth range reduces separation by 20%.

For **cross viewing**, the virtual object is between the viewer and the screen. With eye-to-screen distance `D` and virtual point's distance `q` forward from the screen, set `q/D = (1+mu z)/3`, with `mu = 2a/(3+a)`. Similar triangles give:

`s(z) = E q/(D−q) = E(1+mu z)/(2−mu z)`.

Far separation is again `r`, and near separation is `r(1+a)`. The cross-view extension is derived here; the cited paper presents the parallel geometry.

In either geometry, tracing from a point toward either eye increases depth along a ray according to `z_ray(t) = z + (2−mu z)t/(mu r)`. For the cross case specifically, eye-to-object distance is `(2−mu z)D/3`, while the physical distance per unit of model depth is `mu D/3`. Their ratio is `(2−mu z)/mu`; the factor of one-third cancels. The corresponding parallel distances are `(2−mu z)D` and `mu D`, giving the same ratio. With local horizontal eye offset `r = E/2`, the ray rises by `(2−mu z)/(mu r)` depth units per horizontal pixel.

A nearer sample at or above that ray occludes the point. These constraints are omitted before the remaining equal-colour chains are joined. Alternating half-pixel rounding reduces bias between the two eyes. As in the paper, the scanline geometry is a local centred-eye approximation: it does not ray trace a full camera model calibrated to the viewer's position, and has the paper's slight lateral/vertical projection distortion away from the viewing centre.

Integer display pixels quantise depth. `depthLevels` reports the number of possible integer separations, not a measurement of physical visual depth. Small height differences that round to the same separation cannot be represented as different depth planes: increasing grain detail does not recover them. Around the far plane, one pixel of disparity corresponds approximately to `2/(r*mu)` depth units in parallel mode and `2/(3*r*mu)` in cross mode. A change smaller than half that interval may disappear altogether, depending on which side of a rounding boundary it falls. Increasing output resolution and scaling the repeat proportionally gives finer disparity steps, provided the displayed image preserves that detail; very narrow features can also be lost to sampling or occlusion. The application should therefore use reasonably broad, pronounced depth features.

The geometry is an educational model, without individual eye-spacing or monitor-size calibration. Automated tests establish geometry, occlusion intervals, and exact pixel correspondences; they cannot establish any particular viewer's perception or subjective ease of fusion. Low contrast, a repetitive uploaded texture, extreme depth edges, scaling by the display, and grain comparable to fine scene features can all reduce perceptual clarity.

## Verification

Run `node --test tests/stereogram.test.js`. Tests check exact periodic correspondences; analytical occlusion intervals around a foreground plateau; overlapping constraint chains on a corrugated surface; reproducible seeds; absence of depth shading, including subpixel disparities; absence of excess contrast at generated background tile seams; bounded monotonic separations in both viewing modes; uploaded textures; palette output; and input validation.
