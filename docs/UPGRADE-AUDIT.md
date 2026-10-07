# Studio upgrade audit

## Baseline

The first version rendered mathematically constrained stereograms and supported analytic scenes, text, image depths, painting, texture import, undo, persistence and PNG export. The presentation was an illustrated article with an editor attached. Creation controls were split across the page; selection was single-object; editing lacked standard document shortcuts and direct text editing; the eraser could only modify paint. Rendering, shading, autosave and composition shared the main thread with interaction.

## Design references

The current Ink in Water and Kac Ring tools were inspected alongside David Freeborn's visualisation and website guides. Adopt the compact instrument structure: serif title, dominant visual field, one unified creation toolbar, one contextual inspector, rectangular controls and restrained blue state indication. Remove invented branding, standfirsts, companion thumbnails, numbered essay sections and persistent explanatory paragraphs. Guidance belongs in Help.

## Required preservation

- Deterministic correspondence-based stereograms with binocular occlusion.
- All five original scenes and all existing shape types.
- Parallel and cross-eyed viewing, depth inversion, quantisation and smoothing.
- Generated palettes and imported textures.
- Imported depth maps with transparency; no claim of semantic depth inference.
- Paint, project files, local persistence, undo and PNG/depth/relief export.
- Original version-one projects remain importable.

## Editor acceptance

- Unified selection, shapes, text, brush, eraser and image insertion.
- Delete/Backspace; Ctrl/Cmd C/X/V/D/A/Z; redo; arrow nudging; safe text-entry guards.
- Shift selection and marquee; grouped transforms; numeric properties.
- Resize/rotation handles; zoom/fit/pan; direct text editing.
- Undoable erase masks on visible unlocked object and paint surfaces.
- Layer locking, visibility, naming, selection and ordering; group transforms and alignment.
- Contextual brush settings and object geometry; accessible equivalents for pointer operations.
- Adjustable document proportions and high-resolution image export.

## Architecture and performance

- Separate document/history, geometry/rendering, viewport interaction and UI.
- Move composition, shading and correspondence rendering to a worker.
- Coalesce pending requests, keep asset transfers out of repeated frames and avoid rendering for selection-only changes.
- Use copy-on-write raster assets and bounded history.
- Cache unchanged cropped surfaces within 64 MiB; invalidate by geometry, buffer identity and raster revision. Limit retained tiles to two resolutions per object.
- Skip unused stereogram or relief passes during export and conversion to paint.
- Persist asynchronously; report unavailable storage rather than claiming a save.
- Measure baseline and final browser interaction; retain renderer correctness tests.

## Verification

Verified on 26 September 2026 using installed Microsoft Edge through Playwright, in isolated browser contexts.

- 51 Node tests pass: mathematical correspondences and occlusion, transformed scene sampling, image alpha, masking, cache invalidation, selective output, history, group boundaries, project round-trips, migration and storage fallback.
- 14 browser workflow groups exercise all presets, standard shortcuts, pointer and numeric transforms, grouping, text, painting, erasing, locks, image/texture import, project save/open/autosave and version-one migration.
- Eight additional interaction regressions cover circular group rotation, grouped layer keyboard navigation, Save from focused fields, Undo from a focused range, locked text, modal validation, cancelling an active drag and collective group boundaries.
- Five PNG exports are checked for actual dimensions, including a 3,300-pixel stereogram, an alignment-dot strip, portrait output and a square depth map.
- Desktop, tablet, 390px mobile, reduced-motion and touch layouts have no horizontal overflow. A 640×360 viewport tests the layout space equivalent to 200% zoom at 1280×720; this is a reflow check rather than a claim to have automated the browser's zoom control.
- Automated accessibility checks report zero violations in sampled editing, Help, Export and responsive states. Screenshots were inspected for canvas prominence, control spacing, contextual properties and legibility; coarse-pointer creation and zoom controls meet 44×44px.

Source and offline browser reports and screenshots are under `test-results/v2-browser`, `test-results/v2-standalone` and `test-results/design`. The final performance comparison and its limits are recorded in [PERFORMANCE.md](PERFORMANCE.md).

## Deliberate limits

The editor is local and deterministic. Image imports interpret luminance as depth; no AI inference, physical display calibration or perceptual quality score is claimed. Analytic surfaces render at export resolution; painted fields and imported images retain their underlying raster detail. Project files quantise paint and erase masks to eight bits; in-session history and IndexedDB drafts retain floating-point fields. Automated tests verify the encoding, not an individual's ability to fuse the image.
