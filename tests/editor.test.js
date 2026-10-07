import test from "node:test";
import assert from "node:assert/strict";
import {
  createEditor,
  serialiseProject,
  parseProject,
  defaultSettings,
  MAX_LAYERS,
} from "../src/editor.js";

const sphere = (id, props = {}) => ({
  id,
  type: "sphere",
  name: id,
  x: 0.5,
  y: 0.5,
  size: 0.4,
  depth: 0.8,
  visible: true,
  locked: false,
  ...props,
});
const document = (layers = [sphere("a"), sphere("b")]) => ({
  scene: { name: "Test", layers },
  settings: { ...defaultSettings },
  document: { width: 1100, height: 660 },
});

test("selection filters invalid IDs, supports toggles, and does not create history", () => {
  const editor = createEditor(document());
  const changes = [];
  const unsubscribe = editor.subscribe((event) => changes.push(event.kind));
  editor.select(["a", "a", "missing"]);
  editor.select("b", { add: true });
  editor.select("a", { toggle: true });
  assert.deepEqual(editor.selectedIds, ["b"]);
  assert.equal(editor.canUndo(), false);
  assert.deepEqual(changes, ["selection", "selection", "selection"]);
  editor.selectedIds.push("a");
  assert.deepEqual(
    editor.selectedIds,
    ["b"],
    "selection getter cannot be mutated externally",
  );
  unsubscribe();
  editor.select("a");
  assert.equal(changes.length, 3);
});

test("transactions restore object state and selection through undo and redo", () => {
  const editor = createEditor(document());
  editor.select("a");
  const events = [];
  editor.subscribe((event) => events.push(event.kind));
  editor.removeSelected();
  assert.deepEqual(
    editor.state.scene.layers.map((layer) => layer.id),
    ["b"],
  );
  assert.deepEqual(editor.selectedIds, []);
  assert.deepEqual(events, ["selection", "scene", "history"]);
  editor.undo();
  assert.deepEqual(
    editor.state.scene.layers.map((layer) => layer.id),
    ["a", "b"],
  );
  assert.deepEqual(editor.selectedIds, ["a"]);
  editor.redo();
  assert.deepEqual(
    editor.state.scene.layers.map((layer) => layer.id),
    ["b"],
  );
  assert.deepEqual(editor.selectedIds, []);
});

test("a gesture records one undo step and unchanged transactions record none", () => {
  const editor = createEditor(document());
  editor.begin("Drag");
  for (let i = 0; i < 20; i++) editor.state.scene.layers[0].x += 0.01;
  editor.commit();
  editor.undo();
  assert.equal(editor.state.scene.layers[0].x, 0.5);
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.canRedo(), true);
  editor.transact("No change", () => {});
  assert.equal(editor.canRedo(), true, "a no-op must preserve redo");
  editor.transact("New edit", (state) => {
    state.scene.layers[0].depth = 0.2;
  });
  assert.equal(editor.canRedo(), false);
});

test("stroke buffers use copy-on-write and undo restores the exact prior pixels", () => {
  const field = {
    width: 2,
    height: 2,
    data: new Float32Array([0, 0.25, 0.5, 1]),
  };
  const editor = createEditor(document([sphere("a", { mask: field })]));
  const original = editor.state.scene.layers[0].mask.data;
  editor.begin("Erase stroke");
  editor.state.scene.layers[0].mask.data = original.slice();
  editor.state.scene.layers[0].mask.data[0] = 0.75;
  editor.state.scene.layers[0].mask.data[1] = 1;
  editor.commit();
  editor.undo();
  assert.equal(editor.state.scene.layers[0].mask.data, original);
  assert.deepEqual([...original], [0, 0.25, 0.5, 1]);
  editor.redo();
  assert.deepEqual(
    [...editor.state.scene.layers[0].mask.data],
    [0.75, 1, 0.5, 1],
  );
});

test("cancel and exceptions roll back a partially edited transaction", () => {
  const editor = createEditor(document());
  editor.begin("Drag");
  editor.state.scene.layers[0].x = 0.9;
  editor.select("b");
  editor.cancel();
  assert.equal(editor.state.scene.layers[0].x, 0.5);
  assert.deepEqual(editor.selectedIds, []);
  assert.throws(
    () =>
      editor.transact("Broken edit", (state) => {
        state.scene.layers.length = 0;
        throw new Error("cancel this");
      }),
    /cancel this/,
  );
  assert.equal(editor.state.scene.layers.length, 2);
  assert.equal(editor.canUndo(), false);
});

test("locks protect delete, duplicate, cut and nudge; select all omits locked or hidden layers", () => {
  const editor = createEditor(
    document([
      sphere("a"),
      sphere("b", { locked: true }),
      sphere("c", { visible: false }),
    ]),
  );
  editor.selectAll();
  assert.deepEqual(editor.selectedIds, ["a"]);
  editor.select(["a", "b"]);
  editor.nudge(0.1, -0.1);
  assert.equal(editor.state.scene.layers[0].x, 0.6);
  assert.equal(editor.state.scene.layers[1].x, 0.5);
  assert.equal(editor.duplicateSelected().length, 1);
  editor.undo();
  const cut = editor.cut();
  assert.equal(cut.layers.length, 1);
  assert.equal(cut.layers[0].id, "a");
  assert.equal(
    editor.state.scene.layers.some((layer) => layer.id === "b"),
    true,
  );
  editor.select("b");
  assert.equal(editor.removeSelected(), 0);
  assert.equal(editor.nudge(0.1, 0.1), false);
  assert.equal(editor.cut(), null);
});

test("clipboard copies multiple objects, regenerates IDs, increments offset and owns its pixels", () => {
  const imageData = {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([25, 50, 100, 255]),
  };
  const editor = createEditor(
    document([
      sphere("a", {
        mask: { width: 1, height: 1, data: new Float32Array([0.5]) },
      }),
      sphere("b", { type: "image", imageData }),
    ]),
  );
  editor.selectAll();
  const payload = editor.copy();
  const first = editor.paste();
  const firstLayer = editor.state.scene.layers.find(
    (layer) => layer.id === first[0],
  );
  assert.equal(first.length, 2);
  assert.equal(firstLayer.x, 0.525);
  assert.notEqual(firstLayer.mask.data, editor.state.scene.layers[0].mask.data);
  firstLayer.mask.data[0] = 1;
  const second = editor.paste();
  const secondLayer = editor.state.scene.layers.find(
    (layer) => layer.id === second[0],
  );
  assert.equal(secondLayer.x, 0.55);
  assert.equal(secondLayer.mask.data[0], 0.5);
  assert.equal(
    new Set(editor.state.scene.layers.map((layer) => layer.id)).size,
    6,
  );
  const other = createEditor(document([]));
  other.paste(JSON.stringify(payload));
  assert.deepEqual(
    [...other.state.scene.layers[1].imageData.data],
    [25, 50, 100, 255],
  );
  other.paste(JSON.stringify(payload));
  assert.equal(other.state.scene.layers[2].x, 0.55);
});

test("adding and duplicating are each one history operation and respect document capacity", () => {
  const editor = createEditor(document([]));
  editor.add([sphere("a"), sphere("a")]);
  assert.notEqual(
    editor.state.scene.layers[0].id,
    editor.state.scene.layers[1].id,
  );
  assert.equal(editor.selectedIds.length, 2);
  editor.duplicateSelected();
  assert.equal(editor.state.scene.layers.length, 4);
  editor.undo();
  assert.equal(editor.state.scene.layers.length, 2);
  editor.undo();
  assert.equal(editor.state.scene.layers.length, 0);
  assert.equal(editor.canUndo(), false);
  assert.throws(
    () =>
      editor.add(
        Array.from({ length: MAX_LAYERS + 1 }, (_, i) => sphere(String(i))),
      ),
    /100 objects/,
  );
});

test("history bounds its number of operations", () => {
  const editor = createEditor(document());
  editor.select("a");
  for (let i = 0; i < 75; i++) editor.nudge(0.001, 0);
  let count = 0;
  while (editor.undo()) count++;
  assert.equal(count, 60);
});

test("nudging, duplicating and pasting preserve relative geometry at translation bounds", () => {
  const initial = [
    sphere("a", { x: 1.49, y: -0.49, groupId: "edge" }),
    sphere("b", { x: 0.75, y: 0.5, groupId: "edge" }),
  ];
  const checkOffsets = (layers) => {
    assert.ok(Math.abs(layers[0].x - layers[1].x - 0.74) < 1e-12);
    assert.ok(Math.abs(layers[1].y - layers[0].y - 0.99) < 1e-12);
    for (const layer of layers) {
      assert.ok(layer.x >= -0.5 && layer.x <= 1.5);
      assert.ok(layer.y >= -0.5 && layer.y <= 1.5);
    }
  };
  for (const operation of ["nudge", "duplicate", "paste"]) {
    const editor = createEditor(document(initial));
    editor.selectAll();
    if (operation === "nudge") {
      assert.equal(editor.nudge(0.1, -0.1), true);
      assert.equal(
        editor.nudge(0.1, -0.1),
        false,
        "a blocked group cannot compress at its boundary",
      );
    } else if (operation === "duplicate") editor.duplicateSelected();
    else {
      const payload = editor.copy();
      editor.paste(payload);
    }
    const result = editor.state.scene.layers.filter((layer) =>
      editor.selectedIds.includes(layer.id),
    );
    checkOffsets(result);
    assert.equal(result[0].x, 1.5);
    editor.undo();
    assert.equal(editor.state.scene.layers.length, 2);
    assert.equal(editor.state.scene.layers[0].x, 1.49);
    assert.equal(editor.canUndo(), false, "one action remains one undo step");
  }
  const editor = createEditor(document(initial));
  editor.selectAll();
  editor.duplicateSelected({ offset: 0 });
  assert.deepEqual(
    editor.state.scene.layers.slice(2).map(({ x, y }) => ({ x, y })),
    initial.map(({ x, y }) => ({ x, y })),
    "Alt-drag clones start at their exact source positions",
  );
});

test("groups survive saves and are regenerated together for each pasted or duplicated set", () => {
  const editor = createEditor(
    document([
      sphere("a", { groupId: "group-original" }),
      sphere("b", { groupId: "group-original" }),
      sphere("c"),
    ]),
  );
  assert.equal(
    parseProject(serialiseProject(editor.state)).scene.layers[0].groupId,
    "group-original",
  );
  editor.select(["a", "b", "c"]);
  const payload = editor.copy();
  editor.paste(payload);
  const first = editor.state.scene.layers.slice(-3);
  assert.equal(first[0].groupId, first[1].groupId);
  assert.notEqual(first[0].groupId, "group-original");
  assert.equal(first[2].groupId, undefined);
  editor.duplicateSelected();
  const second = editor.state.scene.layers.slice(-3);
  assert.equal(second[0].groupId, second[1].groupId);
  assert.notEqual(second[0].groupId, first[0].groupId);
});

test("large immutable assets are shared across transform history and changed buffers obey the memory bound", () => {
  const editor = createEditor(
    document([
      sphere("a", {
        mask: {
          width: 1024,
          height: 1024,
          data: new Float32Array(1024 * 1024),
        },
      }),
    ]),
  );
  editor.select("a");
  for (let i = 0; i < 20; i++) editor.nudge(0.001, 0);
  let moves = 0;
  while (editor.undo()) moves++;
  assert.equal(
    moves,
    20,
    "a 4MiB asset is shared across every transform snapshot",
  );
  for (let i = 0; i < 20; i++) {
    editor.transact("Stroke", (state) => {
      const layer = state.scene.layers[0];
      layer.mask.data = layer.mask.data.slice();
      layer.mask.data[0] = (i + 1) / 20;
    });
  }
  let strokes = 0;
  while (editor.undo()) strokes++;
  assert.ok(
    strokes >= 10 && strokes <= 14,
    `expected retained strokes to fit 64MiB, got ${strokes}`,
  );
});

test("project roundtrip preserves transforms, paint, masks, text and an embedded image", () => {
  const state = document([
    sphere("a", {
      rotation: 43,
      scaleX: 0.7,
      scaleY: 1.8,
      locked: true,
      mask: { width: 2, height: 1, data: new Float32Array([0.2, 0.8]) },
    }),
    sphere("b", {
      type: "paint",
      field: { width: 2, height: 1, data: new Float32Array([0, 1]) },
      depth: 1,
    }),
    sphere("c", { type: "text", text: "A word", fontFamily: "sans" }),
    sphere("d", {
      type: "image",
      imageData: {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([32, 45, 12, 255]),
      },
    }),
  ]);
  const project = serialiseProject(state);
  assert.equal(project.version, 2);
  assert.equal(project.scene.layers[0].mask.encoding, "base64-u8");
  const restored = parseProject(JSON.stringify(project));
  assert.equal(restored.scene.layers[0].rotation, 43);
  assert.equal(restored.scene.layers[0].locked, true);
  assert.equal(restored.scene.layers[0].scaleY, 1.8);
  assert.deepEqual([...restored.scene.layers[1].field.data], [0, 1]);
  assert.equal(restored.scene.layers[2].fontFamily, "sans");
  assert.deepEqual(
    [...restored.scene.layers[3].imageData.data],
    [32, 45, 12, 255],
  );
  assert.ok(Math.abs(restored.scene.layers[0].mask.data[0] - 0.2) < 1 / 255);
});

test("image URLs avoid redundant project buffers and remain available for UI hydration", () => {
  const url = "data:image/png;base64,AAAA";
  const project = serialiseProject(
    document([
      sphere("a", {
        type: "image",
        imageURL: url,
        imageData: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
      }),
    ]),
  );
  assert.equal(project.scene.layers[0].imageData, undefined);
  const restored = parseProject(project);
  assert.equal(restored.scene.layers[0].imageURL, url);
  assert.equal(restored.scene.layers[0].imageData, undefined);
});

test("version 1 paint migrates to a full-canvas editable paint object", () => {
  const restored = parseProject({
    format: "autostereogram-studio",
    version: 1,
    scene: {
      name: "Legacy",
      layers: [],
      paint: { width: 2, height: 1, data: "AP8=" },
    },
    settings: {},
  });
  const paint = restored.scene.layers[0];
  assert.equal(paint.type, "paint");
  assert.equal(paint.size, 1100 / 660);
  assert.equal(paint.aspect, 660 / 1100);
  assert.deepEqual([...paint.field.data], [0, 1]);
  assert.equal(restored.scene.paint, undefined);
  assert.equal(parseProject(serialiseProject(restored)).scene.layers.length, 1);
});

test("version 1 image framing retains square bounds while new images use their own aspect", () => {
  const project = serialiseProject(
    document([
      sphere("image", {
        type: "image",
        fit: "contain",
        imageURL: "data:image/png;base64,AAAA",
      }),
    ]),
  );
  assert.equal(parseProject(project).scene.layers[0].aspect, undefined);
  project.version = 1;
  assert.equal(parseProject(project).scene.layers[0].aspect, 1);
  project.scene.layers[0].aspect = 0.75;
  assert.equal(parseProject(project).scene.layers[0].aspect, 0.75);
});

test("malformed or oversized project structures are rejected, and unsafe values are normalized", () => {
  assert.throws(() => parseProject("<html>error</html>"), /valid project/);
  assert.throws(
    () => parseProject({ format: "other", version: 2, scene: { layers: [] } }),
    /supported/,
  );
  const base = serialiseProject(document());
  assert.throws(
    () =>
      parseProject({
        ...base,
        scene: { layers: [sphere("a", { type: "script" })] },
      }),
    /unsupported object/,
  );
  assert.throws(
    () =>
      parseProject({
        ...base,
        scene: {
          layers: [
            sphere("a", {
              type: "image",
              imageURL: "https://example.com/secret.png",
            }),
          ],
        },
      }),
    /image is invalid/,
  );
  assert.throws(
    () =>
      parseProject({
        ...base,
        scene: {
          layers: [
            sphere("a", { mask: { width: 2, height: 2, data: "AA==" } }),
          ],
        },
      }),
    /incomplete or invalid/,
  );
  assert.throws(
    () =>
      parseProject({
        ...base,
        scene: {
          layers: [
            sphere("a", { mask: { width: 9000000, height: 1, data: "" } }),
          ],
        },
      }),
    /invalid dimensions/,
  );
  assert.throws(
    () =>
      parseProject({
        ...base,
        scene: { layers: Array.from({ length: 101 }, () => sphere("a")) },
      }),
    /supported/,
  );
  const restored = parseProject({
    ...base,
    settings: { strength: 1000, mode: "evil", palette: "custom" },
    scene: {
      layers: [sphere("a", { scaleX: -10, x: 100, depth: 10 }), sphere("a")],
    },
  });
  assert.equal(restored.settings.strength, 100);
  assert.equal(restored.settings.mode, "parallel");
  assert.equal(restored.settings.palette, "verdigris");
  assert.equal(restored.scene.layers[0].scaleX, 0.1);
  assert.equal(restored.scene.layers[0].depth, 1);
  assert.notEqual(restored.scene.layers[0].id, restored.scene.layers[1].id);
});
