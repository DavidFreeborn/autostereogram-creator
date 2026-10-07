# Current simplified UI

## Editing reliability pass

- Main slider readouts are compact numeric inputs with bounds, Enter to commit and Escape to cancel. No additional inspector section is introduced.
- New text and its contents share one undo transaction. Escape removes a newly created text object. Property edits can be cancelled before commitment.
- Optional alignment snapping lives in Edit. Canvas and visible object edges/centres supply snap targets, with guides only during movement. Touch and pen receive larger handle hit areas.
- Failed draft saves are visible. Pending saves flush on page hiding; unprotected revisions receive the browser's leave-page warning. Recovery tries remaining stored candidates when the newest cannot be decoded.
- Export uses the active view initially, disables settings while busy, and prevents late downloads after closing. Both sequence identity and the dialog's open state are checked because its close event is asynchronous.
- Validation: 62 unit tests, 12 interaction regressions, 14 main editing workflows, six layouts and five exports in served and portable builds, plus 16 simplified UI accessibility states in both builds. Creator checks pass at four layouts. Actual AI inference was verified in the preceding pass; it was not rerun for these unrelated changes.
- Current machine performance: median slider-to-draw 45.4 ms, first drag draw 26.8 ms, 3300-pixel export 617.6 ms. Eight painted surfaces: median slider-to-draw 72.1 ms. No page or worker errors. These measurements are not guarantees on other hardware.
- Automated tests and visual inspection cannot establish first-use intuitiveness. An unfamiliar human tester is still needed.

The earlier picker and suggestion redesign below has been superseded by this pass.

- New documents start blank. The new-document dialog contains canvas format and Create only. The examples gallery is available separately under File.
- Add inserts text, images or shapes. Select, Paint and Erase have strongly marked active states. The inspector switches to brush controls while painting, with Done to return to selection. Duplicate inspector tabs and persistent explanatory copy were removed.
- Text insertion starts inline editing immediately. Shape, compositing and transform controls share one secondary disclosure.
- Suggest a design was removed. The texture-depth estimation shortcut was removed at the user’s request. Photo depth estimation remains available through image import.
- Text masks are sampled at double density with transform scaling and bounded memory. New text uses a narrower bevel. Global depth blur defaults to zero for new documents. Source glyph precision is improved; integer-pixel stereogram disparity remains a limitation.

Verification: 61 unit tests, 14 browser editing workflows, six layouts, five exports, eight interaction regressions, 17 simplified UI states with no automated accessibility violations, actual texture-depth inference in source and portable builds, immediate text editing, blank creation, mode transitions, undo and texture preservation. Scale-equivalent glyph rasters are compared numerically. Responsive and automated accessibility checks cover desktop, tablet, 390px and a half-size viewport for 200% zoom reflow. No claim is made that automated checks establish intuitive usability.

## Superseded implementation record

# UI and texture-design work

Preserve all drawing tools, object types, native editing shortcuts, groups, masks, transforms, imports, local AI depth, viewing assistance, diagnostics, gallery presets, project migration, undo and exports.

Audit decisions:
- Replace the duplicate starting-design select with a single thumbnail picker. Keep older designs in a secondary visual collection; every design gets a preview.
- Keep canvas format beside the create action, without pixel dimensions in its labels.
- Remove duplicate property-panel Delete/Duplicate actions; preserve Edit commands and native shortcuts.
- Put the object list before selection properties, with one Layers label and no repeated Examples shortcut.
- Keep texture choice and colour controls together; hide inapplicable controls for imported textures and offer an explicit return to generated textures.
- Group viewing settings and depth settings without adding another menu hierarchy.
- Shorten import and diagnostic copy; make photo-result controls conditional.
- Add an on-demand texture-design chooser with three previews, regeneration and one undoable apply action. Analyse texture structure locally; do not imply semantic image recognition.


Implementation and verification:
- All nine starting designs remain available as thumbnails. Five are visible initially; the four older examples are secondary. The duplicate preset dropdown is gone.
- Object selection appears above properties; Duplicate/Delete remain in Edit and their native shortcuts. Imported textures show repeat, zoom, replacement, return to generated texture and design suggestions; inactive colour/reshuffle controls are hidden.
- Photo import shows Original/Depth comparison after estimation and removes redundant setup copy from the result state.
- Texture suggestions use bounded 128-by-128 structural analysis and six procedural design families, with three worker-rendered previews at a time. Generated compositions are fitted within the canvas, and use continuous depth. Applying is one undo step and preserves texture and document size. No photo upload or model download is needed for suggestions.
- 63 unit tests pass; eight focus/interaction regressions pass. The main browser suite passes 14 workflows, six layouts and five exports in the portable build. Creator workflows and real photo inference also pass in the portable build.
- The cleanup suite verifies generated/imported texture suggestions, regeneration, both preview modes, keyboard selection, texture preservation and undo/redo. It audits desktop, tablet, 390px and a half-size viewport equivalent to 200% layout zoom, with reduced motion enabled. Automated checks do not establish human viewing comfort or replace assistive-technology testing.
