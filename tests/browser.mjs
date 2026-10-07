import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { parseProject, serialiseProject } from "../src/editor.js";
const standalone = process.argv.includes("--standalone");
const output = path.resolve(
  "test-results",
  standalone ? "v2-standalone" : "v2-browser",
);
await mkdir(output, { recursive: true });
const url =
  process.env.STUDIO_URL ||
  (standalone
    ? pathToFileURL(path.resolve("dist/autostereogram-studio.html")).href
    : "http://127.0.0.1:5173");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const report = {
  url,
  workflows: [],
  layout: [],
  accessibility: [],
  exports: [],
  consoleErrors: [],
};
function monitor(p) {
  p.on("pageerror", (e) => report.consoleErrors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error") report.consoleErrors.push(m.text());
  });
}
monitor(page);
let serial = 0;
let started = !process.env.STUDIO_TEST_FROM;
async function settle(p = page) {
  await p.waitForTimeout(180);
  await expect(p.locator("#rendering")).toBeHidden({ timeout: 15000 });
  await expect(p.locator("main")).not.toHaveAttribute("inert", "");
}
async function ready(p = page) {
  await expect(p.locator("main")).not.toHaveAttribute("inert", "", {
    timeout: 15000,
  });
  await expect
    .poll(
      () =>
        p
          .locator("#main-canvas")
          .evaluate((c) => c.getContext("2d").getImageData(0, 0, 1, 1).data[3]),
      { timeout: 15000 },
    )
    .toBe(255);
  await settle(p);
}
async function digest(p = page) {
  return p.locator("#main-canvas").evaluate((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let hash = 2166136261,
      opaque = 0;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 388) {
      for (let k = 0; k < 3; k++) hash = Math.imul(hash ^ d[i + k], 16777619);
      opaque += d[i + 3] === 255;
      colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    }
    return {
      width: c.width,
      height: c.height,
      hash: hash >>> 0,
      colors: colors.size,
      opaque,
    };
  });
}
async function point(x, y, p = page) {
  const r = await p.locator("#artboard").boundingBox();
  return { x: r.x + r.width * x, y: r.y + r.height * y };
}
async function pixel(x = 0.5, y = 0.5) {
  return page
    .locator("#main-canvas")
    .evaluate(
      (c, p) => [
        ...c
          .getContext("2d")
          .getImageData(
            Math.floor(p.x * c.width),
            Math.floor(p.y * c.height),
            1,
            1,
          ).data,
      ],
      { x, y },
    );
}
async function key(k) {
  await page.locator("#stage").focus();
  await page.keyboard.press(k);
  await settle();
}
async function drag(from, to) {
  await page.waitForTimeout(70);
  const a = await point(...from),
    b = await point(...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await settle();
}
async function preset(name = "blank", count = 0, aspect = "1100,660") {
  await page.locator("#tab-relief").click();
  await page
    .locator(".document-commands .menu")
    .first()
    .locator("summary")
    .click();
  await page
    .locator(`[data-command="${name === "blank" ? "new" : "examples"}"]`)
    .click();
  if (["orbital", "whale", "terraces", "type"].includes(name))
    await page.locator(".more-designs").evaluate((el) => (el.open = true));
  if (name !== "blank") await page.locator(`[data-example="${name}"]`).click();
  await page.locator("#new-aspect").selectOption(aspect);
  await page.locator("#create-document").click();
  await expect(page.locator("#layers .layer")).toHaveCount(count);
  await settle();
}
async function shape(type) {
  await page.locator(".shape-menu>summary").click();
  await page.locator(`[data-shape=${type}]`).click();
  await settle();
}
async function number(id, value) {
  if (
    await page
      .locator(`#${id}`)
      .evaluate((el) => !!el.closest("details") && !el.closest("details").open)
  )
    await page.locator("#transform-options > summary").click();
  await page.locator(`#${id}`).fill(String(value));
  await page.locator(`#${id}`).press("Tab");
  await settle();
}
async function range(id, value) {
  await page.locator(`#${id}`).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await settle();
}
async function save(name = `state-${++serial}.json`) {
  const waiting = page.waitForEvent("download");
  await page.locator("#stage").focus();
  await page.keyboard.press("Control+s");
  const download = await waiting,
    filename = path.join(output, name);
  await download.saveAs(filename);
  return { filename, project: JSON.parse(await readFile(filename, "utf8")) };
}
async function step(name, fn) {
  if (!started) {
    if (!name.includes(process.env.STUDIO_TEST_FROM)) return;
    started = true;
  }
  const start = Date.now();
  await fn();
  report.workflows.push({ name, duration: Date.now() - start });
  console.log("PASS " + name);
}
async function layout(label, width, height, p = page, whole = false) {
  await p.setViewportSize({ width, height });
  await p.locator("#fit").click();
  await p.evaluate(() => scrollTo(0, 0));
  await settle(p);
  const r = await p.evaluate(() => {
    const a = document.querySelector("#artboard").getBoundingClientRect(),
      s = document.querySelector("#stage").getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
      artboard: { left: a.left, right: a.right, top: a.top, bottom: a.bottom },
      stage: { left: s.left, right: s.right, top: s.top, bottom: s.bottom },
    };
  });
  report.layout.push({ label, ...r });
  assert.ok(
    r.body <= width + 1 && r.document <= width + 1,
    `${label}: horizontal overflow`,
  );
  assert.ok(
    r.artboard.left >= r.stage.left - 1 &&
      r.artboard.right <= r.stage.right + 1 &&
      r.artboard.top >= r.stage.top - 1 &&
      r.artboard.bottom <= r.stage.bottom + 1,
    `${label}: fitted canvas clipped`,
  );
  if (whole)
    assert.ok(
      r.artboard.top >= 0 && r.artboard.bottom <= height,
      `${label}: desktop canvas below fold`,
    );
  await p.screenshot({
    path: path.join(output, label + ".png"),
    fullPage: true,
  });
  const axe = await new AxeBuilder({ page: p })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  report.accessibility.push({
    label,
    violations: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  });
  assert.equal(
    axe.violations.filter((v) => ["serious", "critical"].includes(v.impact))
      .length,
    0,
    `${label}: accessibility violations`,
  );
}
async function exportPNG(kind, width, height, dots = false) {
  await page.locator("#export").click();
  await page.locator("#export-kind").selectOption(kind);
  await page.locator("#export-width").fill(String(width));
  if (kind === "stereo") await page.locator("#export-dots").setChecked(dots);
  const waiting = page.waitForEvent("download", { timeout: 30000 });
  await page.locator("#download-image").click();
  const download = await waiting,
    filename = path.join(output, `${kind}-${width}${dots ? "-dots" : ""}.png`);
  await download.saveAs(filename);
  const bytes = await readFile(filename);
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
  assert.ok(bytes.length > 5000);
  report.exports.push({ kind, width, height, bytes: bytes.length });
  await page.locator("#export-dialog [value=cancel]").click();
  return bytes;
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await ready();
  await step("Initial relief and all presets", async () => {
    const first = await digest();
    assert.equal(first.width, 1100);
    assert.equal(first.height, 660);
    assert.ok(first.opaque > 7000);
    const hashes = new Set();
    for (const [n, c] of [
      ["whale", 4],
      ["terraces", 3],
      ["type", 1],
      ["blank", 0],
      ["orbital", 3],
    ]) {
      await preset(n, c);
      hashes.add((await digest()).hash);
    }
    assert.equal(hashes.size, 5);
  });
  await step("Keyboard tabs change focus without nudging objects", async () => {
    await page.locator("#layers .layer").first().click();
    const before = (await save()).project;
    await page.locator("#tab-relief").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#tab-stereo")).toBeFocused();
    await expect(page.locator("#stage")).toHaveAttribute(
      "aria-labelledby",
      "tab-stereo",
    );
    await page.keyboard.press("End");
    await expect(page.locator("#tab-depth")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator("#tab-relief")).toBeFocused();
    assert.deepEqual((await save()).project.scene, before.scene);
    await page.locator("#tab-relief").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#pattern-panel")).toBeVisible();
    await page.keyboard.press("Home");
    await expect(page.locator("#scene-panel")).toBeVisible();
  });
  await step(
    "Primitives and native delete, clipboard, duplicate, undo and redo",
    async () => {
      await preset();
      for (const type of [
        "cone",
        "pyramid",
        "cylinder",
        "ellipsoid",
        "star",
        "terrain",
      ])
        await shape(type);
      await expect(page.locator("#layers .layer")).toHaveCount(6);
      assert.deepEqual(
        (await save()).project.scene.layers.map((l) => l.type),
        ["cone", "pyramid", "cylinder", "ellipsoid", "star", "terrain"],
      );
      await key("Delete");
      await expect(page.locator("#layers .layer")).toHaveCount(5);
      await key("Control+z");
      await expect(page.locator("#layers .layer")).toHaveCount(6);
      await key("Control+Shift+z");
      await expect(page.locator("#layers .layer")).toHaveCount(5);
      await key("Control+z");
      await key("Control+c");
      await key("Control+v");
      await expect(page.locator("#layers .layer")).toHaveCount(7);
      await key("Control+d");
      await expect(page.locator("#layers .layer")).toHaveCount(8);
      await key("Control+x");
      await expect(page.locator("#layers .layer")).toHaveCount(7);
      await key("Control+v");
      await expect(page.locator("#layers .layer")).toHaveCount(8);
      await page.locator("#object-name").fill("Rename me");
      await page.locator("#object-name").press("Control+a");
      await page.locator("#object-name").press("Delete");
      await page.locator("#object-name").fill("Renamed");
      await page.locator("#object-name").press("Tab");
      await expect(page.locator("#layers .layer")).toHaveCount(8);
    },
  );

  await step(
    "Canvas drag, resize, rotation, cancellation, pan and zoom",
    async () => {
      await preset();
      await shape("box");
      await drag([0.5, 0.5], [0.6, 0.58]);
      await expect(page.locator("#object-x")).toHaveValue("60");
      await expect(page.locator("#object-y")).toHaveValue("58");
      await key("Control+z");
      await expect(page.locator("#object-x")).toHaveValue("50");
      const h = await page.locator(".selection-handle").nth(4).boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + 55, h.y + h.height / 2 + 30, {
        steps: 6,
      });
      await page.mouse.up();
      await settle();
      let l = (await save()).project.scene.layers[0];
      assert.ok(l.scaleX > 1.1 && l.scaleY > 1.05);
      await key("Control+z");
      const r = await page.locator(".selection-rotate").boundingBox(),
        c = await point(0.5, 0.5);
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.keyboard.down("Shift");
      await page.mouse.move(c.x + 180, c.y, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await settle();
      await expect(page.locator("#object-rotation")).toHaveValue("90");
      await key("Control+z");
      const p = await point(0.5, 0.5);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + 50, p.y + 30, { steps: 4 });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(page.locator("#object-x")).toHaveValue("50");
      const before = await page.locator("#artboard").boundingBox();
      await page.locator("#stage").focus();
      await page.keyboard.down("Space");
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + 60, p.y + 30);
      await page.mouse.up();
      await page.keyboard.up("Space");
      const after = await page.locator("#artboard").boundingBox();
      assert.ok(Math.abs(after.x - before.x - 60) < 2);
      await page.locator("#zoom-in").click();
      assert.ok(
        (await page.locator("#artboard").boundingBox()).width >
          after.width * 1.2,
      );
      await page.locator("#fit").click();
    },
  );
  await step("Shift selection, marquee and groups", async () => {
    await preset();
    await shape("sphere");
    await number("object-x", 28);
    await shape("box");
    await number("object-x", 72);
    let p = await point(0.28, 0.5);
    await page.mouse.click(p.x, p.y);
    p = await point(0.72, 0.5);
    await page.keyboard.down("Shift");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Shift");
    await expect(
      page.locator("#layers .layer[aria-selected=true]"),
    ).toHaveCount(2);
    await key("Control+g");
    const grouped = (await save()).project.scene.layers;
    assert.ok(grouped[0].groupId && grouped[0].groupId === grouped[1].groupId);
    await key("Escape");
    p = await point(0.28, 0.5);
    await page.mouse.click(p.x, p.y);
    await expect(
      page.locator("#layers .layer[aria-selected=true]"),
    ).toHaveCount(2);
    await key("Control+Shift+g");
    assert.ok((await save()).project.scene.layers.every((l) => !l.groupId));
    await key("Escape");
    await drag([0.04, 0.08], [0.96, 0.92]);
    await expect(
      page.locator("#layers .layer[aria-selected=true]"),
    ).toHaveCount(2);
    await key("Control+a");
    await key("Delete");
    await expect(page.locator("#layers .layer")).toHaveCount(0);
    await key("Control+z");
    await expect(page.locator("#layers .layer")).toHaveCount(2);
  });
  await step(
    "Double click and Enter edit text; Escape restores it",
    async () => {
      await preset();
      await page.locator(".shape-menu>summary").click();
      await page.locator("#add-text").click();
      let p;
      await expect(page.locator("#inline-text")).toBeVisible();
      await page.locator("#inline-text").fill("VISION");
      await page.locator("#inline-text").press("Enter");
      await settle();
      await expect(page.locator("#inline-text")).toBeHidden();
      await expect(page.locator("#object-text")).toHaveValue("VISION");
      p = await point(0.5, 0.5);
      await page.mouse.dblclick(p.x, p.y);
      await expect(page.locator("#inline-text")).toBeVisible();
      await page.locator("#inline-text").fill("CANCELLED");
      await page.locator("#inline-text").press("Escape");
      await settle();
      await expect(page.locator("#object-text")).toHaveValue("VISION");
      await key("Enter");
      await expect(page.locator("#inline-text")).toBeVisible();
      await page.locator("#inline-text").fill("SPACE");
      await page.locator("#inline-text").press("Enter");
      await page.locator("#font-family").selectOption("sans");
      await settle();
      assert.equal((await save()).project.scene.layers[0].fontFamily, "sans");
    },
  );
  await step(
    "Grouped numeric transforms, alignment and keyboard selection",
    async () => {
      await preset();
      await shape("sphere");
      await number("object-x", 28);
      await number("object-y", 40);
      await shape("box");
      await number("object-x", 52);
      await number("object-y", 60);
      await key("Control+a");
      await key("Control+g");
      const first = (await save()).project.scene.layers;
      const vector = (layers) => ({
        x: (layers[1].x - layers[0].x) * 1100,
        y: (layers[1].y - layers[0].y) * 660,
      });
      const before = vector(first);
      await number("object-rotation", 90);
      const turned = (await save()).project.scene.layers,
        after = vector(turned);
      assert.ok(
        Math.abs(after.x + before.y) < 0.1 &&
          Math.abs(after.y - before.x) < 0.1,
        "Numeric rotation must rotate group centers",
      );
      await number("object-size", 96);
      const larger = (await save()).project.scene.layers,
        scaled = vector(larger);
      assert.ok(
        Math.abs(scaled.x - after.x * 2) < 0.1 &&
          Math.abs(scaled.y - after.y * 2) < 0.1,
        "Numeric size must scale group spacing",
      );
      await shape("cone");
      await number("object-x", 88);
      await number("object-y", 70);
      await key("Control+a");
      await page.locator("[data-align=left]").click();
      const aligned = (await save()).project.scene.layers;
      assert.ok(
        Math.abs(vector(aligned).x - scaled.x) < 0.1 &&
          Math.abs(vector(aligned).y - scaled.y) < 0.1,
        "Alignment must preserve group offsets",
      );
      await page.locator("#layers .layer").first().click();
      await page.locator("#layers .layer").first().focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.locator("#layers .layer[aria-selected=true]"),
      ).toHaveCount(2);
    },
  );
  await step(
    "Paint is an editable layer and each stroke has one undo",
    async () => {
      await preset();
      await page.locator("button[data-tool=brush]").click();
      await drag([0.3, 0.5], [0.7, 0.5]);
      await expect(page.locator("#layers .layer")).toHaveCount(1);
      let p = (await save()).project;
      assert.equal(p.scene.layers[0].type, "paint");
      assert.ok(p.scene.layers[0].field.data.length > 1000);
      await key("Control+z");
      await expect(page.locator("#layers .layer")).toHaveCount(0);
      await key("Control+Shift+z");
      await expect(page.locator("#layers .layer")).toHaveCount(1);
      await page.locator("button[data-tool=select]").click();
      await drag([0.5, 0.5], [0.5, 0.65]);
      p = (await save()).project;
      assert.ok(p.scene.layers[0].y > 0.6);
    },
  );
  await step(
    "Eraser cuts analytic objects; undo and locks protect surfaces",
    async () => {
      await preset();
      await shape("sphere");
      await page.locator("#tab-depth").click();
      await settle();
      assert.ok((await pixel())[0] > 180);
      await page.locator("button[data-tool=erase]").click();
      await range("brush-size", 12);
      await drag([0.49, 0.5], [0.51, 0.5]);
      await page.locator("#tab-depth").click();
      await settle();
      assert.ok((await pixel())[0] < 3, "Eraser must cut the sphere itself");
      assert.ok((await save()).project.scene.layers[0].mask);
      await key("Control+z");
      assert.ok((await pixel())[0] > 180);
      await page.locator("#layer-actions [data-command=lock]").click();
      await key("Delete");
      await key("Control+d");
      await expect(page.locator("#layers .layer")).toHaveCount(1);
      await page.locator("button[data-tool=erase]").click();
      await drag([0.49, 0.5], [0.51, 0.5]);
      await page.locator("#tab-depth").click();
      await settle();
      assert.ok((await pixel())[0] > 180);
      await page.locator("#layer-actions [data-command=lock]").click();
    },
  );
  await step(
    "Image relief, custom texture, renderer controls and saved project roundtrip",
    async () => {
      const png = Buffer.from(
        await page.evaluate(() => {
          const c = document.createElement("canvas");
          c.width = 240;
          c.height = 120;
          const ctx = c.getContext("2d"),
            g = ctx.createLinearGradient(0, 0, 240, 120);
          g.addColorStop(0, "#001020");
          g.addColorStop(1, "white");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 240, 120);
          ctx.fillStyle = "white";
          ctx.fillRect(70, 20, 100, 80);
          return c.toDataURL("image/png").split(",")[1];
        }),
        "base64",
      );
      await page.locator("#depth-file").setInputFiles({
        name: "test-relief.png",
        mimeType: "image/png",
        buffer: png,
      });
      await page.locator("#use-depth-image").click();
      await expect(page.locator("#layers .layer")).toHaveCount(2);
      await settle();
      await number("object-rotation", 23);
      await page.locator("#texture-file").setInputFiles({
        name: "test-texture.png",
        mimeType: "image/png",
        buffer: png,
      });
      await settle();
      await page.locator("#tab-stereo").click();
      await expect(page.locator("#palette")).toHaveValue("custom");
      await page.locator("#mode").selectOption("cross");
      await page.locator("#pattern-panel details > summary").click();
      await page.locator("#grain").selectOption("3");
      await page.locator("#levels").selectOption("5");
      await page.locator("#invert").check();
      await range("strength", 60);
      await page.locator("#tab-stereo").click();
      await settle();
      assert.ok((await digest()).colors > 10);
      const saved = await save("roundtrip-project.json");
      assert.ok(saved.project.textureURL?.startsWith("data:image/png"));
      assert.ok(saved.project.scene.layers.some((l) => l.imageURL));
      await preset();
      await page.locator("#project-file").setInputFiles(saved.filename);
      await expect(page.locator("#layers .layer")).toHaveCount(2);
      await settle();
      const reopened = await save("roundtrip-reopened.json");
      assert.deepEqual(
        serialiseProject(parseProject(reopened.project)),
        serialiseProject(parseProject(saved.project)),
      );
      await expect(page.locator("#saved-indicator")).toHaveText(
        "Saved locally",
        { timeout: 10000 },
      );
      await page.reload();
      await ready();
      await expect(page.locator("#layers .layer")).toHaveCount(2);
    },
  );

  await step(
    "Version 1 projects migrate and invalid files leave the scene intact",
    async () => {
      await page
        .locator("#project-file")
        .setInputFiles(path.resolve("test-results/roundtrip-project.json"));
      await expect(page.locator("#layers .layer")).toHaveCount(2);
      await settle();
      const p = (await save("migrated-v1.json")).project;
      assert.equal(p.version, 2);
      assert.ok(p.scene.layers.some((l) => l.type === "paint" && l.field));
      await page.locator("#project-file").setInputFiles({
        name: "bad.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            format: "autostereogram-studio",
            version: 2,
            scene: { layers: [{ type: "unknown" }] },
          }),
        ),
      });
      await expect(page.locator("#notice.error")).toBeVisible();
      await expect(page.locator("#layers .layer")).toHaveCount(2);
      await page.locator("#dismiss-notice").click();
    },
  );
  await step(
    "High resolution, relief, square depth and portrait PNG export",
    async () => {
      await preset("orbital", 3);
      await exportPNG("stereo", 3300, 1980);
      await exportPNG("stereo", 1100, 695, true);
      await exportPNG("relief", 1100, 660);
      await preset("orbital", 3, "1000,1000");
      const bytes = await exportPNG("depth", 1000, 1000);
      assert.ok(
        await page.evaluate(
          async (url) => {
            const blob = await (await fetch(url)).blob(),
              image = await createImageBitmap(blob),
              c = document.createElement("canvas");
            c.width = image.width;
            c.height = image.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(image, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < d.length; i += 388)
              if (d[i] !== d[i + 1] || d[i] !== d[i + 2] || d[i + 3] !== 255)
                return false;
            return true;
          },
          `data:image/png;base64,${bytes.toString("base64")}`,
        ),
      );
      await preset("orbital", 3, "800,1100");
      await exportPNG("stereo", 800, 1100);
      const d = await digest();
      assert.deepEqual([d.width, d.height], [800, 1100]);
      await preset("orbital", 3);
    },
  );
  await step("Responsive layouts and keyboard-accessible help", async () => {
    await page.locator("#layers .layer").first().click();
    for (const [label, w, h, whole] of [
      ["desktop-1440", 1440, 900, true],
      ["desktop-1280", 1280, 720, true],
      ["tablet-820", 820, 1000, false],
      ["zoom-200-equivalent", 640, 450, false],
      ["narrow-320", 320, 800, false],
    ])
      await layout(label, w, h, page, whole);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#help").click();
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    report.accessibility.push({
      label: "help-dialog",
      violations: axe.violations,
    });
    assert.equal(
      axe.violations.filter((v) => ["serious", "critical"].includes(v.impact))
        .length,
      0,
    );
    await page.locator("#help-dialog [value=cancel]").click();
  });
  await step("390px touch and reduced-motion painting", async () => {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      }),
      p = await ctx.newPage();
    monitor(p);
    await p.goto(url, { waitUntil: "networkidle" });
    await ready(p);
    await layout("mobile-390-reduced-motion", 390, 844, p);
    await p.locator("button[data-tool=brush]").tap();
    const at = await point(0.5, 0.5, p);
    await p.touchscreen.tap(at.x, at.y);
    await settle(p);
    await expect(p.locator("#layers .layer")).toHaveCount(1);
    await ctx.close();
  });
  assert.deepEqual(report.consoleErrors, [], "No browser errors");
  console.log(
    `PASS ${report.workflows.length} workflows; ${report.layout.length} layouts; ${report.exports.length} exports`,
  );
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await page
    .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(output, "browser-report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
