import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { chromium } from "@playwright/test";

// Use a new context: never read or overwrite a user's browser draft.
const baseURL = process.env.STUDIO_URL || "http://127.0.0.1:5173";
const output = "test-results/performance-v2.json";
const sourceFiles = [
  "index.html",
  "src/style.css",
  "src/app.js",
  "src/precision-controls.js",
  "src/creator-tools.js",
  "src/depth-estimator.js",
  "src/editor.js",
  "src/files.js",
  "src/scene.js",
  "src/viewport.js",
  "src/worker.js",
  "src/stereogram.js",
];
async function sourceHash() {
  const hash = createHash("sha256");
  for (const file of sourceFiles) hash.update(await readFile(file));
  return hash.digest("hex");
}
const beforeHash = await sourceHash();
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.addInitScript(() => {
  const perf = (window.__studioPerformance = {
    draws: [],
    requests: [],
    responses: [],
    longTasks: [],
    downloads: [],
  });
  const markDraw = (method) => {
    const original = CanvasRenderingContext2D.prototype[method];
    CanvasRenderingContext2D.prototype[method] = function (...args) {
      const result = original.apply(this, args);
      if (this.canvas.id === "main-canvas")
        perf.draws.push({
          time: performance.now(),
          width: this.canvas.width,
          height: this.canvas.height,
        });
      return result;
    };
  };
  markDraw("putImageData");
  markDraw("drawImage");
  const NativeWorker = Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", ({ data }) =>
        perf.responses.push({
          time: performance.now(),
          id: data.id,
          kind: data.kind,
          width: data.width,
          timing: data.timing,
          error: data.error,
        }),
      );
    }
    postMessage(data, ...args) {
      const start = performance.now();
      const result = super.postMessage(data, ...args);
      perf.requests.push({
        time: start,
        id: data.id,
        kind: data.kind,
        width: data.width ?? data.options?.width,
        postMessageMs: performance.now() - start,
      });
      return result;
    }
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (this.download.endsWith(".png"))
      perf.downloads.push({ time: performance.now(), name: this.download });
    return click.apply(this, args);
  };
  new PerformanceObserver((list) => {
    for (const item of list.getEntries())
      perf.longTasks.push({ start: item.startTime, duration: item.duration });
  }).observe({ type: "longtask", buffered: true });
});

const report = {
  kind: "v2 modular studio",
  date: new Date().toISOString(),
  sourceSha256: beforeHash,
  environment: {
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    browser: browser.version(),
    viewport: { width: 1440, height: 1100 },
    headless: true,
  },
  method:
    "Isolated Edge context at 1440×1100; no user draft; no CPU throttling. Same input values, normalized gesture paths, repetitions and in-page post-draw markers as v1 baseline. Slider events dispatch input then change synchronously, thus measuring committed 1100px previews. Gestures may show adaptive 660px previews before final 1100px output. Input-to-draw excludes automation round-trip; gesture input duration includes mouse event dispatch. Export completion is the PNG download anchor click. Worker request/response intervals include scheduling, transfers and rendering; separate worker timing records come from inside the worker. postMessageMs measures synchronous main-thread serialization only. Other agents may be active.",
  slider: [],
  drag: [],
  paint: [],
  export3300: [],
  stress: {},
  errors,
};
const now = () => page.evaluate(() => performance.now());
async function afterDraw(start) {
  await page.waitForFunction(
    (time) => window.__studioPerformance.draws.some((draw) => draw.time > time),
    start,
    { timeout: 30000 },
  );
}
async function samples(start, end = null) {
  return page.evaluate(
    ({ start, end }) => {
      const p = window.__studioPerformance;
      const draws = p.draws.filter((entry) => entry.time > start);
      return {
        durationMs: draws.length ? draws[0].time - start : null,
        ...(end === null
          ? {}
          : {
              inputDurationMs: end - start,
              firstPaintMs: draws.length ? draws[0].time - start : null,
              finalPaintAfterInputMs: draws.length
                ? draws.at(-1).time - end
                : null,
            }),
        draws,
        requests: p.requests.filter((entry) => entry.time >= start),
        responses: p.responses.filter((entry) => entry.time >= start),
        longTasks: p.longTasks.filter((entry) => entry.start >= start),
      };
    },
    { start, end },
  );
}
async function slider(value) {
  const start = await page.evaluate((next) => {
    const el = document.getElementById("strength"),
      t = performance.now();
    el.value = String(next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return t;
  }, value);
  await afterDraw(start);
  return samples(start);
}
async function resetOrbital() {
  await page
    .locator(".document-commands .menu")
    .first()
    .locator("summary")
    .click();
  await page.locator('[data-command="examples"]').click();
  await page.locator(".more-designs").evaluate((el) => (el.open = true));
  await page.locator('[data-example="orbital"]').click();
  await page.locator("#new-aspect").selectOption("1100,660");
  const start = await now();
  await page.locator("#create-document").click();
  await afterDraw(start);
  await page.waitForTimeout(400);
}
async function gesture(sx, sy, ex, ey, steps) {
  const rect = await page.locator("#main-canvas").boundingBox();
  const start = await now();
  await page.mouse.move(rect.x + rect.width * sx, rect.y + rect.height * sy);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * ex, rect.y + rect.height * ey, {
    steps,
  });
  await page.mouse.up();
  const end = await now();
  await page.waitForTimeout(300);
  return samples(start, end);
}
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    max: sorted.at(-1),
  };
}
function workerTimes(rows, width) {
  const values = [];
  for (const row of rows)
    for (const request of row.requests ?? []) {
      if (request.width !== width || request.kind !== "frame") continue;
      const response = row.responses?.find((entry) => entry.id === request.id);
      if (response) values.push(response.time - request.time);
    }
  return values;
}

try {
  await page.goto(baseURL);
  await page.waitForFunction(
    () =>
      window.__studioPerformance.draws.length &&
      !document.querySelector("main").inert,
  );
  await resetOrbital();
  await page.locator('[data-view="stereo"]').click();
  for (let i = 0; i < 20; i++) report.slider.push(await slider(25 + i * 3));

  await page.locator('[data-view="relief"]').click();
  await page.waitForTimeout(400);
  for (let i = 0; i < 6; i++) {
    const sx = 0.676 + (i % 2 ? 0.04 : 0);
    report.drag.push(
      await gesture(sx, 0.586, sx + (i % 2 ? -0.04 : 0.04), 0.586, 10),
    );
  }
  await page.locator('button[data-tool="brush"]').click();
  for (let i = 0; i < 6; i++)
    report.paint.push(
      await gesture(0.14, 0.35 + i * 0.04, 0.82, 0.39 + i * 0.04, 24),
    );

  await resetOrbital();
  await slider(82);
  await page.locator('[data-view="stereo"]').click();
  await page.locator("#export").click();
  await page.locator("#export-kind").selectOption("stereo");
  await page.locator("#export-width").fill("3300");
  await page.locator("#export-dots").uncheck();
  for (let i = 0; i < 5; i++) {
    const start = await now();
    const download = page.waitForEvent("download");
    await page.locator("#download-image").click();
    await download;
    await page.waitForFunction(
      () => !document.getElementById("download-image").disabled,
    );
    const sample = await samples(start);
    sample.durationMs = await page.evaluate(
      (t) =>
        window.__studioPerformance.downloads.find((entry) => entry.time > t)
          .time - t,
      start,
    );
    report.export3300.push(sample);
  }
  await page.locator("#export-dialog").evaluate((el) => el.close());

  // Main-thread serialization stress: eight full-canvas paint layers, each with
  // a 700×420 field and 384×384 eraser mask. Saved project remains under 32MB.
  const field = Buffer.alloc(700 * 420, 120).toString("base64");
  const mask = Buffer.alloc(384 * 384, 0).toString("base64");
  const project = {
    format: "autostereogram-studio",
    version: 2,
    document: { width: 1100, height: 660 },
    settings: { strength: 45, repeat: 90, soften: 1 },
    scene: {
      name: "Eight painted surfaces",
      layers: Array.from({ length: 8 }, (_, i) => ({
        id: `stress-${i}`,
        type: "paint",
        name: `Paint ${i + 1}`,
        x: 0.5,
        y: 0.5,
        size: 1100 / 660,
        aspect: 0.6,
        depth: 0.3 + i * 0.08,
        visible: true,
        field: { width: 700, height: 420, encoding: "base64-u8", data: field },
        mask: { width: 384, height: 384, encoding: "base64-u8", data: mask },
      })),
    },
  };
  const loadStart = await now();
  await page.locator("#project-file").setInputFiles({
    name: "performance-stress.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await page.waitForFunction(
    () =>
      document.getElementById("document-name").value ===
      "Eight painted surfaces",
  );
  await afterDraw(loadStart);
  await page.waitForTimeout(300);
  await page.locator('[data-view="stereo"]').click();
  report.stress.description =
    "Eight full-canvas paint fields (700×420 Float32 each) with 384×384 Float32 masks; 14,126,592 bytes of typed field data per frame before transport deduplication.";
  report.stress.slider = [];
  for (let i = 0; i < 10; i++)
    report.stress.slider.push(await slider(25 + i * 3));

  const rows = [
    ...report.slider,
    ...report.drag,
    ...report.paint,
    ...report.export3300,
  ];
  report.summary = {
    sliderInputToDrawMs: stats(report.slider.map((row) => row.durationMs)),
    dragFirstPaintMs: stats(report.drag.map((row) => row.firstPaintMs)),
    dragFinalPaintAfterInputMs: stats(
      report.drag.map((row) => row.finalPaintAfterInputMs),
    ),
    strokeFirstPaintMs: stats(report.paint.map((row) => row.firstPaintMs)),
    strokeFinalPaintAfterInputMs: stats(
      report.paint.map((row) => row.finalPaintAfterInputMs),
    ),
    export3300ReadyMs: stats(report.export3300.map((row) => row.durationMs)),
    worker1100Ms: stats(workerTimes(report.slider, 1100)),
    worker3300Ms: stats(workerTimes(report.export3300, 3300)),
    framePostMessageMs: stats(
      rows.flatMap((row) =>
        row.requests
          .filter((entry) => entry.kind === "frame")
          .map((entry) => entry.postMessageMs),
      ),
    ),
    stressInputToDrawMs: stats(
      report.stress.slider.map((row) => row.durationMs),
    ),
    stressFramePostMessageMs: stats(
      report.stress.slider.flatMap((row) =>
        row.requests
          .filter((entry) => entry.kind === "frame")
          .map((entry) => entry.postMessageMs),
      ),
    ),
  };
  report.longTasks = await page.evaluate(
    () => window.__studioPerformance.longTasks,
  );
  report.workerErrors = await page.evaluate(() =>
    window.__studioPerformance.responses.filter((entry) => entry.error),
  );
  try {
    const baseline = JSON.parse(
      await readFile("test-results/baseline-performance.json", "utf8"),
    );
    report.baselineComparison = Object.fromEntries(
      Object.entries(baseline.summary)
        .filter(([key]) => report.summary[key]?.n)
        .map(([key, old]) => [
          key,
          {
            baselineMedian: old.median,
            currentMedian: report.summary[key].median,
            percentChange: (report.summary[key].median / old.median - 1) * 100,
          },
        ]),
    );
  } catch {}
  report.sourceUnchangedDuringRun = beforeHash === (await sourceHash());
  await mkdir("test-results", { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  const comparisonLabels = {
    sliderInputToDrawMs: "Committed slider → full-resolution preview",
    dragFirstPaintMs: "Drag → first preview",
    dragFinalPaintAfterInputMs: "Drag release → final preview",
    strokeFirstPaintMs: "Brush → first preview",
    strokeFinalPaintAfterInputMs: "Brush release → final preview",
    export3300ReadyMs: "3,300 px PNG ready",
  };
  const comparisonRows = Object.entries(comparisonLabels).map(
    ([key, label]) => {
      const entry = report.baselineComparison?.[key];
      return `| ${label} | ${entry?.baselineMedian.toFixed(1) ?? "—"} ms | ${report.summary[key].median.toFixed(1)} ms | ${entry ? `${entry.percentChange > 0 ? "+" : ""}${entry.percentChange.toFixed(1)}%` : "—"} |`;
    },
  );
  const interactionLongTasks = [
    ...report.slider,
    ...report.drag,
    ...report.paint,
    ...report.stress.slider,
  ].flatMap((row) => row.longTasks).length;
  await writeFile(
    "test-results/performance-audit.md",
    [
      "# Autostereogram performance audit",
      "",
      `Measured ${report.date}. Source SHA-256: \`${report.sourceSha256}\`.`,
      "",
      report.sourceUnchangedDuringRun
        ? "Source files were unchanged throughout this run."
        : "PROVISIONAL: source files changed during this run; repeat before using these measurements as final results.",
      "",
      "| Measurement (median) | Original | Upgraded | Change |",
      "| --- | ---: | ---: | ---: |",
      ...comparisonRows,
      "",
      "## Method and limits",
      "",
      report.method,
      "",
      "Twenty slider changes, six object drags, six brush strokes and five PNG exports reproduce the original baseline sequence. Slider previews are 1,100 px in both versions. Gesture first previews may be 660 px in the upgraded version; final previews are 1,100 px. Export timings include PNG encoding and download preparation. Small timing differences should be treated as noise on this unthrottled development machine.",
      "",
      "## Main-thread and worker audit",
      "",
      `Normal frame postMessage: ${report.summary.framePostMessageMs.median.toFixed(2)} ms median / ${report.summary.framePostMessageMs.p95.toFixed(2)} ms p95. Eight painted layers containing 14,126,592 bytes of fields and masks: ${report.summary.stressFramePostMessageMs.median.toFixed(2)} ms median / ${report.summary.stressFramePostMessageMs.p95.toFixed(2)} ms p95. Heavy-scene input-to-draw: ${report.summary.stressInputToDrawMs.median.toFixed(1)} ms median.`,
      "",
      `${interactionLongTasks} long tasks (>50 ms) occurred within the measured slider, drag, brush and stress-slider intervals. ${report.longTasks.length} occurred across the full run, including setup, project opening and export. The raw JSON records all task timestamps and durations.`,
      "",
      "Worker timings are not directly comparable across versions: the upgraded worker also composes the depth scene and renders the relief, operations previously performed on the main thread. User-visible input and export timings are the appropriate comparison.",
      "",
      "Static review confirmed that the UI sends asset pruning, asset registration and each frame in FIFO order to a synchronous worker. The active-asset budget prevents eviction of assets required by the next frame; URL/dimension deduplication avoids uploading identical imported images repeatedly. Clipboard/history operations use independent asset buffers where needed and structurally shared immutable history buffers. A dedicated memory regression verifies the 64 MiB history cap.",
      "",
      `Browser errors: ${errors.length}. Worker errors: ${report.workerErrors.length}.`,
      "",
    ].join("\n"),
  );
  console.log(
    JSON.stringify(
      {
        output,
        summary: report.summary,
        comparison: report.baselineComparison,
        longTasks: report.longTasks.length,
        errors,
        workerErrors: report.workerErrors,
        sourceUnchangedDuringRun: report.sourceUnchangedDuringRun,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, [], "browser errors during performance run");
  assert.deepEqual(
    report.workerErrors,
    [],
    "worker errors during performance run",
  );
} finally {
  await browser.close();
}
