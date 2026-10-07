import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, serialiseProject } from "../src/editor.js";

let moduleId = 0;
const files = () => import(`../src/files.js?test=${++moduleId}`);
const state = (name = "Draft") => ({
  document: { width: 1100, height: 660 },
  settings: { ...defaultSettings },
  scene: {
    name,
    layers: [
      {
        id: "paint",
        type: "paint",
        name: "Paint",
        x: 0.5,
        y: 0.5,
        size: 1,
        depth: 1,
        field: { width: 2, height: 1, data: new Float32Array([0, 1]) },
      },
    ],
  },
});

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
    t.after(() =>
      original
        ? Object.defineProperty(globalThis, key, original)
        : delete globalThis[key],
    );
  }
}

function localStore() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

function indexedStore() {
  const data = new Map();
  const controls = { failWrites: false, writes: 0 };
  const db = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction() {
      const transaction = {
        objectStore() {
          return {
            get(key) {
              const request = {};
              setTimeout(() => {
                request.result = structuredClone(data.get(key));
                transaction.oncomplete?.();
              }, 0);
              return request;
            },
            put(value, key) {
              const request = {};
              const snapshot = structuredClone(value);
              controls.writes++;
              setTimeout(() => {
                if (controls.failWrites) {
                  transaction.error = new Error("Quota reached");
                  transaction.onabort?.();
                } else {
                  data.set(key, snapshot);
                  request.result = key;
                  transaction.oncomplete?.();
                }
              }, 0);
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
  return {
    data,
    controls,
    open() {
      const request = {};
      setTimeout(() => {
        request.result = db;
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

test("drafts snapshot typed buffers immediately and queue later saves in order", async (t) => {
  const indexedDB = indexedStore();
  const localStorage = localStore();
  globals(t, { indexedDB, localStorage });
  const io = await files();
  const original = state("First");
  original.scene.layers[0].field.data[0] = 0.123456;
  const exactDepth = original.scene.layers[0].field.data[0];
  const save = io.saveDraft(original);
  original.scene.name = "Mutated later";
  original.scene.layers[0].field.data[0] = 1;
  await save;
  const record = indexedDB.data.get("current");
  assert.equal(record.state.scene.name, "First");
  assert.ok(record.state.scene.layers[0].field.data instanceof Float32Array);
  assert.equal(record.state.scene.layers[0].field.data[0], exactDepth);
  assert.equal(
    (await io.loadDraft()).scene.layers[0].field.data[0],
    exactDepth,
    "IndexedDB reload preserves full floating point paint precision",
  );
  assert.equal(
    localStorage.data.size,
    0,
    "normal saves do not create base64 JSON copies",
  );
  await Promise.all([
    io.saveDraft(state("Second")),
    io.saveDraft(state("Third")),
  ]);
  assert.equal((await io.loadDraft()).scene.name, "Third");
  assert.equal(indexedDB.controls.writes, 3);
});

test("a newer local fallback wins over an older IndexedDB draft after a quota failure", async (t) => {
  const indexedDB = indexedStore();
  globals(t, { indexedDB, localStorage: localStore() });
  const io = await files();
  await io.saveDraft(state("Before quota"));
  indexedDB.controls.failWrites = true;
  await io.saveDraft(state("After quota"));
  assert.equal((await io.loadDraft()).scene.name, "After quota");
  indexedDB.controls.failWrites = false;
  await io.saveDraft(state("Database recovered"));
  assert.equal((await io.loadDraft()).scene.name, "Database recovered");
});

test("a corrupt newer fallback does not hide a valid IndexedDB draft", async (t) => {
  const indexedDB = indexedStore();
  const localStorage = localStore();
  globals(t, { indexedDB, localStorage });
  const io = await files();
  await io.saveDraft(state("Recoverable"));
  indexedDB.controls.failWrites = true;
  await io.saveDraft(state("Broken"));
  const key = [...localStorage.data.keys()][0];
  const record = JSON.parse(localStorage.getItem(key));
  record.project = { invalid: true };
  localStorage.setItem(key, JSON.stringify(record));
  assert.equal((await io.loadDraft()).scene.name, "Recoverable");
});

test("local storage fallback preserves painted depth and can read a version 1 draft", async (t) => {
  const localStorage = localStore();
  globals(t, { indexedDB: undefined, localStorage });
  const io = await files();
  assert.equal(await io.loadDraft(), null);
  await io.saveDraft(state());
  const loaded = await io.loadDraft();
  assert.deepEqual([...loaded.scene.layers[0].field.data], [0, 1]);
  localStorage.data.clear();
  const legacy = serialiseProject(state("Legacy"));
  legacy.version = 1;
  legacy.scene.layers = [];
  legacy.scene.paint = { width: 2, height: 1, data: "AP8=" };
  localStorage.setItem("stereogram-draft-v1", JSON.stringify(legacy));
  const migrated = await io.loadDraft();
  assert.equal(migrated.scene.name, "Legacy");
  assert.equal(migrated.scene.layers[0].type, "paint");
});

test("storage failures reject without poisoning subsequent saves", async (t) => {
  const localStorage = localStore();
  const setItem = localStorage.setItem;
  localStorage.setItem = () => {
    throw new Error("Quota exceeded");
  };
  globals(t, { indexedDB: undefined, localStorage });
  const io = await files();
  await assert.rejects(io.saveDraft(state()), /could not save/);
  localStorage.setItem = setItem;
  await io.saveDraft(state("Recovered"));
  assert.equal((await io.loadDraft()).scene.name, "Recovered");
  localStorage.getItem = () => {
    throw new Error("Storage disabled");
  };
  await assert.rejects(io.loadDraft(), /could not be opened/);
});

test("invalid image formats and oversized files are rejected before decoding", async () => {
  const io = await files();
  await assert.rejects(
    io.readImage({ type: "image/svg+xml", size: 20 }),
    /PNG, JPEG or WebP/,
  );
  await assert.rejects(
    io.readImage({ type: "image/png", size: 21 * 1024 * 1024 }),
    /20 MB/,
  );
  await assert.rejects(io.readImage({ type: "image/png", size: 0 }), /20 MB/);
});

test("image import resizes proportionally, emits PNG and releases its decoded bitmap", async (t) => {
  let closed = false;
  let drawSize;
  const bitmap = {
    width: 4000,
    height: 2000,
    close() {
      closed = true;
    },
  };
  const context = {
    drawImage(_image, _x, _y, width, height) {
      drawSize = [width, height];
    },
    getImageData(_x, _y, width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
  };
  const canvas = {
    getContext: () => context,
    toDataURL: (mime) => `data:${mime};base64,AAAA`,
  };
  globals(t, {
    createImageBitmap: async () => bitmap,
    document: { createElement: () => canvas },
  });
  const io = await files();
  const imported = await io.readImage({
    type: "image/webp",
    size: 1000,
    name: "Depth scene.webp",
  });
  assert.deepEqual(drawSize, [1600, 800]);
  assert.equal(imported.name, "Depth scene");
  assert.equal(imported.imageURL, "data:image/png;base64,AAAA");
  assert.equal(imported.imageData.width, 1600);
  assert.equal(imported.imageData.height, 800);
  assert.equal(context.imageSmoothingQuality, "high");
  assert.equal(closed, true);
  bitmap.width = 20000;
  await assert.rejects(
    io.readImage({ type: "image/png", size: 100 }),
    /20 million pixels/,
  );
});

test("hydration rejects external URLs and removes obsolete image references", async (t) => {
  globals(t, { Image: class {} });
  const io = await files();
  const imported = state();
  imported.scene.layers[0].image = { obsolete: true };
  await io.hydrateState(imported);
  assert.equal(imported.scene.layers[0].image, undefined);
  imported.scene.layers = [
    { type: "image", imageURL: "https://example.com/depth.png" },
  ];
  await assert.rejects(io.hydrateState(imported), /embedded image/);
});
