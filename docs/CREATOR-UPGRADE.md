# Creator upgrade verification

Verified 7 October 2026 on Windows with installed Microsoft Edge.

## Delivered

- Design, Stereogram and Depth map views; contextual Objects and Texture controls.
- Autostereogram Creator title, quiet save status, concise Help and fewer persistent controls.
- Hold-to-reveal, three-step viewing assistance, practice surface and reversible gentler settings.
- Four generated texture families and imported-image repeat across both axes or horizontally only.
- Ordered carving and intersection, directional gradients and adjustable text bevel.
- Four editable gallery designs.
- On-demand depth encoding diagnostics with a bounded higher-resolution comparison.
- Optional local photo depth estimation, preview and editable paint import. Pinned model and runtime are downloaded only on demand; inference is cancellable and images stay in the browser.

## Checks

61 unit tests pass. The main browser suite passes 14 editing workflows, six responsive layouts and five exports, including the standalone HTML build. Eight interaction regressions pass for focus, keyboard commands, grouped transforms, validation and cancelled gestures.

The Creator suite passes new workflows at four viewport sizes with no automated WCAG A/AA violations. Real photo inference succeeds through the actual UI in both source and minified standalone builds. Estimated maps and gallery screenshots were visually inspected. Automated accessibility checks do not replace assistive-technology testing or human stereoscopic viewing.

## Performance

See PERFORMANCE.md for the current reproducible measurements and source hash. Median committed preview latency is 57.6 ms, first drag feedback 36.1 ms and a 3,300-pixel PNG 772.9 ms on this machine. Compared with the recorded original baseline, interactive feedback improves; brush completion and export do not improve in this run. Measurements span different dates and are not controlled hardware benchmarks.

Rendering remains worker-based with bounded geometry and texture caches, transferred output buffers and smaller previews during gestures. Texture swatches avoid serializing embedded image URLs during edits. The photo model is isolated from the rendering worker and does not load during ordinary editing.

## Practical limits

Photo depth is a relative estimate and can misinterpret reflective or ambiguous surfaces. A fresh browser needs a network connection for the optional model; the core editor and literal depth-map import work offline. Diagnostic counts measure encoding loss, not viewing comfort. The higher-resolution diagnostic reference is capped to bound memory use. Carved subsets must be selected with the whole design before flattening, because their result depends on surfaces below them.
