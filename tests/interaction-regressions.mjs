import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { defaultSettings, serialiseProject } from "../src/editor.js";
import { createLayer } from "../src/scene.js";

// These checks exercise the browser's actual focus, keyboard and pointer paths.
// Each context has its own local draft; project downloads are read in memory.
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
const passed = [];
page.on("pageerror", (error) => errors.push(error.message));

async function loadFixture(layers, name = "Interaction regression") {
  const project = serialiseProject({
    document: { width: 1100, height: 660 },
    settings: { ...defaultSettings },
    scene: { name, layers },
    texture: null,
    textureURL: null,
  });
  await page.locator("#project-file").setInputFiles({
    name: "interaction-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator("#document-name")).toHaveValue(name);
  await expect(page.locator(".layer")).toHaveCount(layers.length);
  await page.waitForTimeout(100);
}

async function saveFromFocus() {
  const waiting = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const download = await waiting;
  assert.match(download.suggestedFilename(), /-project\.json$/);
  const chunks = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function snapshot() {
  await page.locator("#stage").focus();
  return saveFromFocus();
}

async function setNumber(id, value) {
  await page.locator(`#${id}`).evaluate((el) => {
    const details = el.closest("details");
    if (details) details.open = true;
  });
  await page.locator(`#${id}`).fill(String(value));
  await page.locator(`#${id}`).press("Tab");
}

async function selectAll() {
  await page.locator("#stage").focus();
  await page.keyboard.press("Control+a");
}

function near(actual, expected, label, tolerance = 1e-8) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

try {
  await page.goto(process.env.STUDIO_URL || "http://127.0.0.1:5173");
  await expect(page.locator("main")).not.toHaveAttribute("inert", "", {
    timeout: 15000,
  });

  await loadFixture([
    { ...createLayer("sphere"), name: "A", x: 0.35, rotation: 350 },
    { ...createLayer("sphere"), name: "B", x: 0.65, rotation: 20 },
  ]);
  await selectAll();
  await expect(page.locator("#object-rotation")).toHaveValue("5");
  await setNumber("object-rotation", 200);
  await expect(page.locator("#object-rotation")).toHaveValue("200");
  const rotated = (await snapshot()).scene.layers;
  near(rotated.find((l) => l.name === "A").rotation, 185, "A rotation");
  near(rotated.find((l) => l.name === "B").rotation, 215, "B rotation");
  near(rotated[1].rotation - rotated[0].rotation, 30, "Angular offset");
  passed.push("Circular multiselect rotation preserves the 30° offset");

  await selectAll();
  await page.keyboard.press("Control+g");
  await expect(page.locator('.layer[aria-selected="true"]')).toHaveCount(2);
  await page.locator(".layer").first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('.layer[aria-selected="true"]')).toHaveCount(2);
  await page.keyboard.press("Home");
  await expect(page.locator('.layer[aria-selected="true"]')).toHaveCount(2);
  passed.push("Layer keyboard navigation preserves grouped selection");

  await loadFixture(
    [
      {
        ...createLayer("text"),
        name: "Editable text",
        text: "Initial",
        depth: 0.7,
      },
    ],
    "Text shortcuts",
  );
  await page
    .getByRole("option", { name: "Editable text", exact: true })
    .click();
  let saved;
  await page.locator("#object-text").fill("Saved while typing");
  saved = await saveFromFocus();
  assert.equal(saved.scene.layers[0].text, "Saved while typing");
  await page
    .locator(".document-commands .menu")
    .first()
    .locator("summary")
    .click();
  await page.locator('[data-command="document"]').click();
  await page.locator("#document-name").fill("Named while typing");
  saved = await saveFromFocus();
  assert.equal(saved.scene.name, "Named while typing");
  await page
    .locator("#document-dialog")
    .getByRole("button", { name: "Close" })
    .click();
  passed.push(
    "Ctrl S commits and downloads while object text or name has focus",
  );

  const depth = page.locator("#object-depth");
  await depth.focus();
  await depth.press("ArrowRight");
  await expect(depth).toHaveValue("71");
  await depth.press("Control+z");
  await expect(depth).toHaveValue("70");
  near((await snapshot()).scene.layers[0].depth, 0.7, "Undo with range focus");
  passed.push("Ctrl Z undoes an adjustment while its range remains focused");

  await page.locator('#layer-actions [data-command="lock"]').click();
  await expect(page.locator("#object-text")).toBeDisabled();
  passed.push("Locked text disables its property textarea");

  await page
    .locator(".document-commands .menu")
    .first()
    .locator("summary")
    .click();
  await page.locator('[data-command="document"]').click();
  await page.locator("#document-width").fill("6000");
  await page.locator("#document-height").fill("6000");
  await page.locator("#resize-document").click();
  await expect(page.locator("#document-dialog")).toBeVisible();
  const validation = await page
    .locator("#document-width")
    .evaluate((input) => ({
      valid: input.validity.valid,
      message: input.validationMessage,
      insideOpenDialog: !!input.closest("dialog[open]"),
    }));
  assert.equal(validation.valid, false);
  assert.equal(validation.insideOpenDialog, true);
  assert.match(validation.message, /20 million/);
  await page
    .locator("#document-dialog")
    .getByRole("button", { name: "Close" })
    .click();
  passed.push(
    "Oversized canvas reports native validity inside its open dialog",
  );

  await loadFixture(
    [
      {
        ...createLayer("sphere"),
        name: "Drag target",
        x: 0.5,
        y: 0.5,
        size: 0.4,
      },
    ],
    "Pointer cancellation",
  );
  const before = await snapshot();
  const artboard = await page.locator("#artboard").boundingBox();
  const start = {
    x: artboard.x + artboard.width * 0.5,
    y: artboard.y + artboard.height * 0.5,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const originalOutline = await page
    .locator(".selection-outline")
    .getAttribute("points");
  await page.mouse.move(start.x + 75, start.y + 20, { steps: 6 });
  await expect(page.locator(".selection-outline")).not.toHaveAttribute(
    "points",
    originalOutline,
  );
  await page.keyboard.press("Control+z");
  await page.mouse.move(start.x + 145, start.y + 50, { steps: 6 });
  await page.mouse.up();
  const after = await snapshot();
  assert.deepEqual(after.scene.layers, before.scene.layers);
  assert.equal(after.scene.name, before.scene.name);
  assert.deepEqual(after.document, before.document);
  passed.push(
    "Undo cancels an active drag; subsequent pointer motion is inert",
  );

  await loadFixture(
    [
      {
        ...createLayer("sphere"),
        name: "Group left",
        x: 0.3,
        y: 0.5,
        size: 0.22,
        groupId: "bounds-group",
      },
      {
        ...createLayer("sphere"),
        name: "Group right",
        x: 0.7,
        y: 0.5,
        size: 0.22,
        groupId: "bounds-group",
      },
    ],
    "Group bounds",
  );
  const groupBoard = await page.locator("#artboard").boundingBox();
  await page.mouse.move(
    groupBoard.x + groupBoard.width * 0.3,
    groupBoard.y + groupBoard.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(1275, groupBoard.y + groupBoard.height * 0.5, {
    steps: 10,
  });
  await page.mouse.up();
  const bounded = (await snapshot()).scene.layers;
  near(bounded[1].x - bounded[0].x, 0.4, "Group spacing at position limit");
  near(bounded[1].x, 1.5, "Group's rightmost position limit");
  near(bounded[0].y, 0.5, "Group left vertical position");
  near(bounded[1].y, 0.5, "Group right vertical position");
  passed.push(
    "Pointer movement clamps a group together without changing its spacing",
  );

  await loadFixture([], "Text transactions");
  await page.locator("#stage").focus();
  await page.keyboard.press("t");
  await page.locator("#inline-text").fill("One action");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer")).toHaveCount(1);
  await page.locator("#undo").click();
  await expect(page.locator(".layer")).toHaveCount(0);
  await page.locator("#stage").focus();
  await page.keyboard.press("Control+Shift+z");
  assert.equal((await snapshot()).scene.layers[0].text, "One action");
  await page.keyboard.press("t");
  await page.keyboard.press("Escape");
  await expect(page.locator(".layer")).toHaveCount(1);
  passed.push(
    "Text insertion and typing undo together; Escape cancels new text",
  );

  await loadFixture([{ ...createLayer("sphere"), depth: 0.7 }], "Precision");
  await selectAll();
  await setNumber("object-depth-number", 83);
  near((await snapshot()).scene.layers[0].depth, 0.83, "Typed depth");
  await page.locator("#object-depth-number").fill("42");
  await page.locator("#object-depth-number").press("Escape");
  await expect(page.locator("#object-depth-number")).toHaveValue("83");
  near((await snapshot()).scene.layers[0].depth, 0.83, "Cancelled depth");
  await setNumber("object-depth-number", 999);
  await expect(page.locator("#object-depth-number")).toHaveValue("83");
  await page.locator("#undo").click();
  await expect(page.locator("#object-depth-number")).toHaveValue("70");
  passed.push(
    "Exact numeric depth supports cancellation, bounds and single-step undo",
  );

  await loadFixture(
    [{ ...createLayer("sphere"), x: 0.3, y: 0.5, size: 0.2 }],
    "Snapping",
  );
  await page.locator("#snap-alignment").evaluate((el) => {
    el.closest("details").open = true;
  });
  await page.locator("#snap-alignment").check();
  await page.locator("#stage").click({ position: { x: 3, y: 3 } });
  const snapBoard = await page.locator("#artboard").boundingBox();
  await page.mouse.move(
    snapBoard.x + snapBoard.width * 0.3,
    snapBoard.y + snapBoard.height * 0.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    snapBoard.x + snapBoard.width * 0.5 + 3,
    snapBoard.y + snapBoard.height * 0.5,
    { steps: 5 },
  );
  assert.ok((await page.locator(".alignment-guide").count()) > 0);
  await page.mouse.up();
  await expect(page.locator(".alignment-guide")).toHaveCount(0);
  near((await snapshot()).scene.layers[0].x, 0.5, "Snapped center");
  passed.push(
    "Optional snapping aligns the object center and clears temporary guides",
  );

  await page.locator("#tab-depth").click();
  await page.locator("#export").click();
  await expect(page.locator("#export-kind")).toHaveValue("depth");
  await page.locator("#export-width").fill("640");
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      original.call(
        this,
        (blob) => {
          window.finishTestExport = () => callback(blob);
        },
        ...args,
      );
    };
    window.restoreTestExport = () => {
      HTMLCanvasElement.prototype.toBlob = original;
    };
  });
  const cancelledDownloads = [];
  const recordDownload = (download) => cancelledDownloads.push(download);
  page.on("download", recordDownload);
  await page.locator("#download-image").click();
  await page.waitForFunction(() => Boolean(window.finishTestExport));
  await expect(page.locator("#export-width")).toBeDisabled();
  await expect(page.locator("#download-image")).toBeDisabled();
  await page
    .locator("#export-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator("#export-dialog")).not.toBeVisible();
  await page.evaluate(() => {
    window.finishTestExport();
    window.restoreTestExport();
  });
  await page.waitForTimeout(100);
  assert.equal(cancelledDownloads.length, 0);
  page.off("download", recordDownload);
  await page.locator("#export").click();
  await expect(page.locator("#download-image")).toBeEnabled();
  await page
    .locator("#export-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  passed.push(
    "Export follows the active view, freezes its settings and cancels late downloads",
  );

  assert.deepEqual(errors, [], "Unexpected page errors");
  console.log(
    JSON.stringify(
      { passed: passed.length, checks: passed, pageErrors: errors },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
