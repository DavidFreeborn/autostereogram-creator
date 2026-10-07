# Renderer and scene-engine upgrade

The stereogram correspondence algorithm, viewing geometry, occlusion rejection,
seeded colour pattern, palette values, and export units remain intact. The final
pixel-copy loop now copies RGBA words, and pattern-row hashes are computed once
per scanline. Existing mathematical tests still verify exact visible
correspondences, occlusion intervals, repeat spacing, disparity direction,
repeat-seam contrast, and deterministic output.

## Object model

All objects support rotation in degrees and independent scaleX / scaleY. The
frontmost depth wins. Layers may use rounded or flat profiles. Added primitives
are ellipsoid, cone, pyramid and cylinder; paint is an ordinary editable object.
Existing text, image, star, whale, terrain, sphere, torus, plateau and arch
surfaces remain available. Text supports serif/sans and up to 80 characters.

A layer's mask is {width,height,data:Float32Array}, in normalized object-local
coordinates. Zero is intact; one is erased. Erasing modifies the object's depth
coverage after its geometry is evaluated, so erased regions reveal surfaces
behind it. Masks follow translations, rotation and resizing. Paint fields use
the same layout, with samples from zero to one multiplied by layer.depth.
Legacy scene.paint remains supported.

Decoded image data uses {width,height,data:Uint8ClampedArray}, RGBA. Native image
aspect is preserved unless an explicit aspect is present. Both contain and
cover modes preserve source aspect; transparency remains transparent when
inverting luminance. Imported-image luminance is cached independently of DOM.

layerBounds returns unrotated normalized bounds including aspect and scales.
layerLocalPoint maps normalized scene coordinates to normalized local u/v.
sampleLayerDepth evaluates actual transformed and erased geometry for hit
testing without rendering a canvas. Picking and compositing share the same
compiled sampler; antialiasing stays inside physical bounds under extreme
aspect transforms.

## Worker protocol

- `{kind:'asset', key, imageData}` registers reusable decoded RGBA data.
- `{kind:'prune', keys:[...]}` retains only the specified assets.
- `{id, kind:'frame', scene, width, height, settings, texture?, textureKey?}`
  composes depth, applies invert/levels/soften, generates the stereogram, and
  shades relief entirely in the worker. Layers can reference `imageKey`.
- A frame returns `{id,width,height,depth,pixels,relief,stats,timing}`, with typed
  arrays transferred to the caller. Timing fields are compose, stereogram,
  relief and total, measured in milliseconds.
- An optional `output:'stereo'|'depth'|'relief'` skips unused render passes for exports. Omit it for full preview frames; only existing buffers are transferred.
- Asset eviction notices contain `{kind:'assets-evicted',keys}`. Missing-asset errors include `missingAssets`; the coordinator prunes unused assets and registers the active set before each frame.
- Existing `{id,options}` stereogram-only messages remain supported.

Settings use the existing UI units: strength is a percentage; repeat, grain and
soften scale from a reference width of 1100 pixels. The main coordinator owns
coalescing and cancellation of obsolete frame requests.

Canvas-dependent silhouettes work with OffscreenCanvas in the worker and a
DOM canvas fallback. Shape rasters have a 32 MB LRU cache; imported assets have
a 128 MB LRU cache. A separate 64 MB LRU stores cropped layer-depth tiles at
at most two resolutions per object. It is enabled only for explicit `_cacheKey`
identities supplied by the worker coordinator. Geometry and field/mask buffer
identity plus revision invalidate tiles; repeated pattern changes reuse depth
without resampling paint and masks. Compositing scans each transformed bounding
region; blur is
a linear-time separable pass. Pixel dimensions are limited to 64 million.

## Verification and measurement

Fifteen scene/pipeline tests cover transformed picking, extreme aspect ratios,
masks, paint, image transparency, depth filtering, cache invalidation and
output-specific export. The full Node suite currently has 51 passing tests,
including the original twelve stereogram geometry tests and document/storage
regressions.

Headless Edge additionally rendered rotated lettering, a star and a whale in
an actual module worker: worker depth matched main-thread depth byte-for-byte;
sampled picking differed from Float32 composition by at most 3e-8. The browser
suite in tests/browser.mjs exercises UI workflows, project migration, downloads,
keyboard editing, touch input, responsive layouts and accessibility. Reports
are written under test-results/v2-browser and test-results/v2-standalone.

The final browser performance measurements are generated separately by the
performance harness against the preserved test-results/v1-baseline.html.
They include input-to-draw latency and dense paint/mask scenes; preliminary
Node timing estimates have been removed in favour of those reproducible
end-to-end measurements. Browser, hardware, scene complexity, rasterization
and export size affect performance. Human stereo fusion remains perceptual
and cannot be established by automated correspondence tests alone.
