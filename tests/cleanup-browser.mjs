import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
const offline = process.argv.includes("--standalone");
const out = path.resolve(
  "test-results",
  offline ? "simple-offline" : "simple-ui",
);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 850 },
  acceptDownloads: true,
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [],
  audits = [];
page.on("pageerror", (e) => errors.push(e.message));
async function audit(name) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  audits.push({
    name,
    violations: r.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  });
  await page.screenshot({
    path: path.join(out, name + ".png"),
    fullPage: true,
  });
}
async function menu(command) {
  await page
    .locator(".document-commands .menu")
    .first()
    .locator("summary")
    .click();
  await page.locator(`[data-command=${command}]`).click();
}
async function snapshot() {
  await page.locator("#stage").focus();
  const d = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const chunks = [];
  for await (const c of await (await d).createReadStream()) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}
try {
  await page.goto(
    offline
      ? pathToFileURL(path.resolve("dist/autostereogram-studio.html")).href
      : "http://127.0.0.1:5173",
  );
  await expect(page.locator("main")).not.toHaveAttribute("inert", "", {
    timeout: 20000,
  });
  await expect(page.locator("#layers .layer")).toHaveCount(0);
  assert.equal(await page.locator("#suggest-design").count(), 0);
  assert.equal(await page.locator(".inspector-tabs").count(), 0);
  await audit("blank");
  await menu("new");
  await expect(page.locator("#starter-designs")).toBeHidden();
  await audit("new");
  await page.locator("#create-document").click();
  assert.equal((await snapshot()).settings.soften, 0);
  await page.locator("button[data-tool=brush]").click();
  await expect(page.locator("#inspector-title")).toHaveText("Paint");
  await expect(page.locator("#scene-panel")).toBeHidden();
  await expect(page.locator("#brush-depth")).toBeVisible();
  await audit("paint");
  await page.locator("button[data-tool=erase]").click();
  await expect(page.locator("#inspector-title")).toHaveText("Erase");
  await expect(page.locator("#brush-depth")).toBeHidden();
  await audit("erase");
  await page.locator("#finish-tool").click();
  await expect(page.locator("button[data-tool=select]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator(".shape-menu summary").click();
  await audit("add");
  await page.locator("#add-text").click();
  await expect(page.locator("#inline-text")).toBeVisible();
  await page.locator("#inline-text").fill("PRECISION");
  await page.locator("#inline-text").press("Enter");
  await expect(page.locator("#object-operation")).toBeHidden();
  await audit("text");
  await page.locator("#stage").focus();
  await page.keyboard.press("t");
  await expect(page.locator("#inline-text")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#layers .layer")).toHaveCount(1);
  if (!offline) {
    const result = await page.evaluate(async () => {
      const { createLayer, composeDepth } = await import("/src/scene.js");
      const base = {
        ...createLayer("text"),
        text: "Fine glyphs",
        size: 0.35,
        scaleX: 3,
        scaleY: 3,
      };
      const a = composeDepth({ layers: [base] }, 550, 330);
      const b = composeDepth(
        {
          layers: [
            { ...base, id: "equivalent", size: 1.05, scaleX: 1, scaleY: 1 },
          ],
        },
        550,
        330,
      );
      let err = 0,
        ink = 0;
      for (let i = 0; i < a.length; i++) {
        err += (a[i] - b[i]) ** 2;
        if (a[i] > 0.1) ink++;
      }
      return { rms: Math.sqrt(err / a.length), ink };
    });
    assert.ok(result.rms < 0.002, JSON.stringify(result));
    assert.ok(result.ink > 100);
  }
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 128;
      const x = c.getContext("2d");
      x.fillStyle = "#476a62";
      x.fillRect(0, 0, 128, 128);
      x.fillStyle = "#b0bdab";
      x.fillRect(0, 30, 128, 40);
      return c.toDataURL().split(",")[1];
    }),
    "base64",
  );
  await page
    .locator("#texture-file")
    .setInputFiles({ name: "texture.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#texture-depth")).toHaveCount(0);
  await audit("texture");
  for (const [width, height, label] of [
    [820, 1000, "tablet"],
    [390, 844, "mobile"],
    [640, 425, "zoom-200-equivalent"],
  ]) {
    await page.setViewportSize({ width, height });
    await audit("texture-" + label);
    await menu("new");
    await audit("new-" + label);
    await page.keyboard.press("Escape");
    await page.locator("#tab-relief").click();
    await page.locator("button[data-tool=brush]").click();
    await audit("paint-" + label);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.locator("#finish-tool").click();
    await page.locator("#tab-stereo").click();
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  assert.deepEqual(errors, []);
  assert.ok(
    audits.every((a) => a.violations.length === 0),
    JSON.stringify(audits),
  );
  console.log(
    "PASS simple creation, drawing modes, immediate text editing, scale-aware glyphs and " +
      audits.length +
      " accessible states",
  );
} finally {
  await fs.writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ errors, audits }, null, 2),
  );
  await browser.close();
}
