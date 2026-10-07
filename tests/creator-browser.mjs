import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
const standalone = process.argv.includes("--standalone"),
  ai = process.argv.includes("--ai");
const url = standalone
  ? pathToFileURL(path.resolve("dist/autostereogram-studio.html")).href
  : "http://127.0.0.1:5173";
const out = path.resolve(
  "test-results",
  standalone ? "creator-offline" : "creator-browser",
);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const hash = () => page.locator("#main-canvas").evaluate((c) => c.toDataURL());
async function settle() {
  await page.waitForTimeout(250);
  await expect(page.locator("#rendering")).toBeHidden({ timeout: 20000 });
}
const reports = [];
try {
  await page.goto(url);
  await expect(page.locator("main")).not.toHaveAttribute("inert", "", {
    timeout: 20000,
  });
  await expect(page.locator("h1")).toHaveText("Autostereogram Creator");
  assert.equal(await page.locator(".document-title").count(), 0);
  await page.locator("#tab-stereo").click();
  await settle();
  await expect(page.locator("#pattern-panel")).toBeVisible();
  await expect(page.locator(".creation-toolbar")).toBeHidden();
  const original = await hash();
  await page.locator("#reveal").focus();
  await page.keyboard.down("Space");
  assert.notEqual(await hash(), original);
  await page.keyboard.up("Space");
  assert.equal(await hash(), original);
  for (const style of ["mineral", "paper", "organic", "stipple"]) {
    const before = await hash();
    await page.locator(`[data-texture-style=${style}]`).click();
    if (style !== "stipple") await expect.poll(hash).not.toBe(before);
  }
  await page.locator("#viewing-help").click();
  await expect(page.locator("#guide-count")).toHaveText("1 of 3");
  const strength = await page.locator("#strength").inputValue();
  await page.locator("#guide-gentler").click();
  assert.ok(
    Number(await page.locator("#strength").inputValue()) < Number(strength),
  );
  await page.locator("#guide-restore").click();
  await expect(page.locator("#strength")).toHaveValue(strength);
  await page.locator("#guide-next").click();
  await settle();
  await expect(page.locator("#guide-count")).toHaveText("2 of 3");
  await page.locator("#guide-next").click();
  await settle();
  await page.locator("#guide-next").click();
  await expect(page.locator("#viewing-assistant")).toBeHidden();
  await page.locator("#check-detail").click();
  await expect(page.locator("#detail-status")).toContainText("1,100", {
    timeout: 20000,
  });
  assert.equal(await page.locator("#detail-results dd").count(), 3);
  await page.screenshot({ path: path.join(out, "diagnostics.png") });
  await page.locator("#detail-dialog [value=cancel]").click();
  await page.locator("#tab-relief").click();
  await page
    .locator(".document-commands .menu")
    .first()
    .locator("summary")
    .click();
  await page.locator('[data-command="examples"]').click();
  await expect(page.locator("[data-example]")).toHaveCount(9);
  await page.screenshot({ path: path.join(out, "examples.png") });
  for (const id of ["typography", "architecture", "landscape", "sculpture"]) {
    await page.locator(`[data-example=${id}]`).click();
    await page.locator("#create-document").click();
    await settle();
    assert.ok((await page.locator("#layers .layer").count()) > 1);
    await page.screenshot({ path: path.join(out, id + ".png") });
    await page
      .locator(".document-commands .menu")
      .first()
      .locator("summary")
      .click();
    await page.locator('[data-command="examples"]').click();
  }
  await page.locator("#new-dialog [value=cancel]").click();
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 60;
      c.height = 120;
      const x = c.getContext("2d");
      x.fillStyle = "red";
      x.fillRect(0, 0, 60, 60);
      x.fillStyle = "blue";
      x.fillRect(0, 60, 60, 60);
      return c.toDataURL().split(",")[1];
    }),
    "base64",
  );
  await page
    .locator("#texture-file")
    .setInputFiles({ name: "strip.png", mimeType: "image/png", buffer: png });
  await settle();
  const both = await hash();
  await page.locator("#texture-repeat").selectOption("horizontal");
  await expect.poll(hash).not.toBe(both);

  await page
    .locator("#depth-file")
    .setInputFiles({ name: "depth.png", mimeType: "image/png", buffer: png });
  await expect(page.locator("#image-dialog")).toBeVisible();
  await page.locator("#use-depth-image").click();
  await expect(page.locator("#image-dialog")).not.toBeVisible();
  for (const [width, height] of [
    [1280, 720],
    [820, 1000],
    [390, 844],
    [640, 360],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator("#fit").click();
    await settle();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    reports.push({
      width,
      violations: result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    });
    await page.screenshot({
      path: path.join(out, `layout-${width}.png`),
      fullPage: true,
    });
  }
  if (ai) {
    await page.setViewportSize({ width: 1280, height: 850 });
    const response = await page.request.get(
      "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg",
    );
    assert.ok(response.ok());
    await page.locator("#depth-file").setInputFiles({
      name: "cats.jpg",
      mimeType: "image/jpeg",
      buffer: await response.body(),
    });
    await page.locator("#estimate-photo").click();
    await expect(page.locator("#photo-status")).toContainText(
      "Depth estimated.",
      { timeout: 180000 },
    );
    await page.screenshot({ path: path.join(out, "estimated-depth.png") });
    await page.locator("#add-photo-depth").click();
    await expect(page.locator("#image-dialog")).toBeHidden();
    await settle();
    await page.screenshot({ path: path.join(out, "estimated-relief.png") });
  }
  assert.deepEqual(errors, []);
  assert.ok(
    reports.every((r) => !r.violations.length),
    JSON.stringify(reports),
  );
  console.log(
    "PASS Creator workflows, 4 layouts, zero accessibility violations" +
      (ai ? ", real photo inference" : ""),
  );
} finally {
  await fs.writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ errors, reports }, null, 2),
  );
  await browser.close();
}
