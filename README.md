# Autostereogram Creator 3

[Website](https://www.davidpeterwallisfreeborn.com/fun/autostereogram-creator/) · [GitHub Pages](https://davidfreeborn.github.io/autostereogram-creator/)

The published editor uses the website's shared tool shell and bundled EB Garamond (licence: `EB-GARAMOND-OFL.txt`). `node scripts/sync-site-shell.mjs <website-checkout>` refreshes that layer from the site's authoritative CSS. Rebuild afterwards. GitHub Actions tests and builds the editor before deploying `dist/index.html` to Pages. The website imports the same standalone release with `scripts/sync-autostereogram.js`, preserving application scripts byte-for-byte.



A local editor for single-image stereograms. The canvas occupies the main workspace; the Objects and Texture inspectors show controls for the current task. Help contains a short introduction and essential controls.



## Open the studio



Open **`dist/autostereogram-studio.html`** in a modern browser for the self-contained offline version. Its scripts, styles and rendering worker are embedded. The editor works offline without an account. Optional photo depth estimation downloads a model and runtime on first use.



For development, use Node.js 22 or newer:



```sh

npm install

npm start

```



Open [the local studio](http://127.0.0.1:5173). The server listens only on this computer; the `PORT` environment variable changes its port.



## Create and edit



Start from the editable typography, architecture, landscape or sculpture gallery, or choose orbital forms, a whale above sunken arches, terraces, lettering or a blank document. The Add menu contains text, images and shapes. Paint and Erase are separate editing modes.



- **Select:** click an object or its layer. Shift-click adds or removes a selection; drag empty canvas to select a region. Resize with the bounding handles and rotate with the rotation handle. Shift constrains movement, preserves proportions when resizing, and snaps rotation to 15° increments. Alt-drag duplicates a selection.

- **Shapes:** sphere, torus, plate, star, cylinder, cone, pyramid, ellipsoid, terrain and whale. The inspector provides depth, position, size, rotation and horizontal/vertical scale; surface controls include directional gradients, text bevel and torus thickness.

- **Text:** choose Add > Text to begin typing. Double-click existing text or press Enter with a text object selected to edit it in place. Enter commits; Escape cancels. Serif and sans-serif lettering are available, up to 80 characters.

- **Paint:** draw a depth surface with adjustable size, softness and depth. Painting uses a selected paint layer or creates one. Pen pressure affects strokes. Paint remains editable after moving, scaling or rotating its layer.

- **Erase:** erase all visible unlocked surfaces or only the selected surfaces, including shapes, text and imported depth images. Erasing uses reversible object masks. **Edit → Restore erased depth** removes the selected masks.

- **Images:** import, drop or paste a PNG, JPEG or WebP depth image. Luminance becomes depth; alpha preserves transparent regions. Choose **Use as depth map** for literal luminance, or **Estimate depth** for a photograph. Review the estimated map before adding it as editable paint.



Use the Objects inspector to rename layers, hide or lock them, reorder the list, group selections, align objects, or set transforms numerically. **Edit → Convert to paint** combines the selected surfaces into one paint layer. This conversion is undoable.



Layers combine from bottom to top. **Add** keeps the nearer surface, **Carve** subtracts depth, and **Keep overlap** intersects with the surface below. Order matters for carving and intersection. The scene represents one front surface at each pixel; it does not model transparent volumes or hidden overhangs.



## Depth from an imported texture

Import a texture, then choose **Estimate depth from texture** directly below its preview. This runs the same local photo-depth model on the imported pixels, without a second file picker. Preview and add the estimated map as editable paint; the texture remains unchanged. Undo removes the added surface. The model estimates relative geometry and can be unreliable for abstract or repeating patterns.

**File > New document** creates a blank canvas. Examples are separate under **File > Examples**. The Add menu inserts objects immediately; Select, Paint and Erase are distinct modes. Paint and Erase display their own controls in the inspector. Done returns to selection. Numeric transforms, surface shape and compositing share one Shape and position disclosure.

The former procedural Suggest a design feature has been removed.

## Canvas, pattern and export



**Design** shows shaded relief for authoring. **Stereogram** shows the hidden-depth image, and **Depth map** shows its grayscale depth map. Zoom with the controls, Ctrl/Cmd-wheel or a two-finger pinch. Use Pan, hold Space over the canvas, or drag with the middle mouse button. **Fit** restores the full canvas.



The Texture inspector offers stipple, mineral, paper and organic textures, colour palettes, imported textures, repeat spacing, depth strength, viewing method and alignment dots. Depth options contains grain, edge smoothing, depth quantization and inversion. **Reshuffle** changes the generated texture seed. Imported textures can repeat **Across and down**, or **Across only**, which fits one image height to the canvas. Texture zoom crops around the centre.



Parallel viewing is the default: look through the image and try merging the alignment dots into a third central dot. Cross-eyed viewing reverses the correspondence for convergence in front of the image. The Design and Depth map views reveal the intended surface directly.



**File → Canvas size** changes the document dimensions. **Export** saves a stereogram, shaded relief or depth map as PNG, with optional alignment dots above a stereogram. Repeat spacing and grain scale with the export width. Analytic shapes render at the output resolution; painted fields and imported images retain their underlying raster detail when enlarged.



## Keyboard controls



Use Cmd in place of Ctrl on macOS. Text fields keep their normal text-selection, clipboard and editing behavior.



| Action                              | Shortcut                              |

| ----------------------------------- | ------------------------------------- |

| Select / Text / Paint / Erase / Pan | V / T / B / E / H                     |

| Cut / Copy / Paste                  | Ctrl X / Ctrl C / Ctrl V              |

| Duplicate                           | Ctrl D, or Alt-drag                   |

| Delete selection                    | Delete or Backspace                   |

| Select visible unlocked objects     | Ctrl A                                |

| Undo / Redo                         | Ctrl Z / Ctrl Shift Z or Ctrl Y       |

| Group / Ungroup                     | Ctrl G / Ctrl Shift G                 |

| Move selection                      | Arrow keys; Shift for ten-pixel steps |

| Edit selected text                  | Enter                                 |

| Cancel an active gesture            | Escape                                |

| Fit canvas                          | 0                                     |

| New / Open / Save project           | Ctrl N / Ctrl O / Ctrl S              |



Copy and paste preserve editable objects, masks, paint and image assets. Repeated pastes are offset; copied groups receive independent identities. Plain text and supported clipboard images can also be pasted onto the canvas. The Edit menu provides the same commands.



## Saving and limits



All processing takes place in the browser. Imported files are not uploaded. The latest draft is saved to IndexedDB, with localStorage as a fallback. IndexedDB keeps full-precision paint fields and decoded image data; save status is announced to assistive technology.



**Save project** downloads a portable JSON document. **Open project** restores its objects, groups, transforms, masks, paint, imported assets and pattern settings. Version 1 projects migrate automatically, including their original image framing and fixed canvas painting. Version 2 project files encode paint and masks at 8-bit precision to keep files compact.



Save project files for backups and for moving between browsers or between the local-server and standalone versions, which use separate storage contexts. Undo history belongs to the current session.



| Limit                                       | Value                                                         |

| ------------------------------------------- | ------------------------------------------------------------- |

| Objects per document                        | 100                                                           |

| Undo/redo history                           | Up to 60 operations within a 64 MiB history budget            |

| Imported file                               | PNG, JPEG or WebP; up to 20 MiB and 20 million decoded pixels |

| Imported image resolution                   | Longest side resampled to at most 1,600 pixels                |

| New paint field                             | 700 pixels on the longest side                                |

| Project file                                | 32 MiB                                                        |

| Canvas dimensions                           | 320–6,000 pixels per side, up to 20 million pixels            |

| PNG export                                  | Width up to 6,000 pixels, with the same pixel-area limit      |

| Active decoded image assets in the renderer | 128 MiB                                                       |



History snapshots share unchanged pixel buffers. Pixel edits replace the affected buffers; older history is released when its memory budget is reached. A pointer gesture produces one undo step.



## Rendering and performance



The stereogram renderer follows Thimbleby, Inglis and Witten’s symmetric constraint method: it establishes horizontal pixel correspondences, rejects hidden-surface constraints, and assigns matching colours along linked scanline chains. Generated texture wraps at the background repeat. [RENDERER.md](RENDERER.md) documents the geometry, derivation, references and cross-view adaptation.



Depth composition, stereogram generation and relief rendering run in a worker. Pointer gestures use a smaller preview before the settled image. Imported image assets are registered separately from frame requests, deduplicated and pruned when no longer needed. A bounded 64 MiB cache reuses unchanged layer surfaces; geometry and raster revisions invalidate it. Export computes only the requested image. Render results return as transferred pixel buffers.



The reproducible benchmark compares 20 committed slider changes, six drags, six paint strokes and five 3,300-pixel PNG exports with the saved version 1 baseline. It also measures a scene with eight large paint fields and eraser masks. The verified comparison is in [the performance audit](docs/PERFORMANCE.md); rerunning the harness writes fresh reports under `test-results/`. Treat a report marked **PROVISIONAL** as a development measurement; it means source files changed during that run.



Integer-pixel disparity limits resolvable depth levels. Apparent depth also depends on the display, viewing distance and observer. **Check detail** reports encoded depth levels, depth changes lost to pixel rounding and variation below the output pixel scale. These are rendering measurements, not a prediction of an individual’s ability to see the image.



**Hold to reveal** (or hold R) shows the intended surface. **Viewing help** provides alignment guidance, a temporary practice shape and gentler settings that can be restored.



## Photo depth estimation



The optional estimator uses [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small), an Apache-2.0 model, through Transformers.js 3.8.1. The quantized model is about 27 MB, plus its runtime. Inference runs locally in a separate worker; photographs are not uploaded. The browser may cache downloads, but a fresh installation needs internet access. Cancel stops the inference worker.



The estimate describes relative depth, not calibrated distances. Reflective, transparent and ambiguous surfaces can be inaccurate. Preview the result, then adjust or paint it after adding it. Existing depth maps can always be imported without the model.



## Verification and build



```sh

npm test

npm run test:browser       # Run npm start in another terminal first.

npm run test:interactions  # Focus, grouped transforms and cancellation regressions.

npm run test:performance   # Same local server; isolated browser context.

npm run build

npm run test:standalone    # Opens the built offline file directly.

npm run test:creator       # New creator workflows and accessibility checks.

npm run test:creator:standalone
npm run test:cleanup       # Drawing modes, glyph precision and UI-state audits.
npm run test:cleanup:standalone

node tests/creator-browser.mjs --standalone --ai # Real model inference.

```



Unit tests cover stereogram correspondences, occlusion, transformed surfaces, erasing, editing transactions, clipboard independence, groups, memory-bounded history, project migration and browser-storage fallback. Browser checks exercise the actual editing, file, export and keyboard workflows, responsive layouts and automated accessibility checks. Browser tests use installed Microsoft Edge through Playwright; performance measurements do not use CPU throttling.



`npm run build` creates `dist/autostereogram-studio.html`. The core application embeds its runtime code. Photo estimation loads its pinned external runtime and model only when requested.



## Source layout



| File                | Responsibility                                                          |

| ------------------- | ----------------------------------------------------------------------- |

| `src/app.js`        | UI coordination, tools, property editing and export                     |

| `src/creator-tools.js` | Reveal, viewing guidance, textures, diagnostics, gallery and image workflow |

| `src/depth-estimator.js` | Lazy local inference, normalization, cancellation and model lifecycle |

| `src/editor.js`     | Document state, transactions, clipboard, history and project validation |

| `src/viewport.js`   | Selection, transform handles, gestures, zoom and pan                    |

| `src/files.js`      | Local image import, hydration, downloads and draft persistence          |

| `src/scene.js`      | Analytic surfaces, masks, depth composition and relief rendering        |

| `src/stereogram.js` | Deterministic correspondence renderer                                   |

| `src/worker.js`     | Background rendering and image-asset management                         |

| `src/style.css`     | Responsive typography, controls and layout                              |

| `index.html`        | Interface, keyboard reference and viewing help                          |


## Text precision

Text masks use twice the nominal sampling density and account for object scaling, within a four-million-sample ceiling. New lettering uses a narrow bevel and sans-serif type; new documents start without global depth blur. Existing saved settings remain intact. The stereogram encoder still uses integer-pixel disparity: this change improves source glyph precision, not continuous subpixel stereogram encoding.

## Editing polish

The main sliders also accept typed values. Enter commits a value; Escape restores the preceding value. Adding and typing new text is one undo action, and Escape cancels a new text object. Edit → Snap to alignment optionally aligns moving objects with canvas and object edges or centres. Temporary guides appear during the drag; snapping starts disabled. Touch and pen have larger transform-handle hit areas.

Draft failures produce a visible recovery message. Leaving the page with unprotected edits triggers the browser's unsaved-changes prompt; downloading a project protects that revision. When a newer fallback draft is corrupt, recovery tries the other stored candidate. Export starts with the current view, holds its settings while rendering, and suppresses unfinished downloads when the dialog closes.

Validation for this pass: 62 unit tests; 12 interaction regressions; main browser workflows and simplified UI accessibility checks in both served and standalone builds. The performance report is in `test-results/performance-v2.json`. First-use usability with an unfamiliar person remains to be tested.
