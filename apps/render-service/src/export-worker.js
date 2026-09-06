import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Worker } from "bullmq";
import puppeteer from "puppeteer-core";

import { config } from "./config.js";
import { redisConnection } from "./queue.js";

/**
 * Headless project export.
 *
 * Drives the editor in headless Chrome through `window.__openreelAutomation` — a hook we
 * own in apps/web/src — rather than scraping aria-labels or monkey-patching
 * `showSaveFilePicker`. The hook loads a project by id (rehydrating media from
 * `/media/:id`) and exports through the core export engine into an in-memory writable,
 * handing the bytes back as base64.
 *
 * Export runs at roughly real time (Canvas2D in headless, no WebGPU), so concurrency is 1.
 */

const CHROME_CANDIDATES = [
  config.chromePath,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // next
    }
  }
  throw new Error(`No Chrome/Chromium found. Set CHROME_PATH. Tried:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
}

async function waitForAutomation(page, timeoutMs = 90_000) {
  await page.waitForFunction(() => Boolean(window.__openreelAutomation?.ready), {
    timeout: timeoutMs,
    polling: 500,
  });
}

async function exportProject(job) {
  const { projectId, codec, bitrate, quality } = job.data;
  const isFrame = job.data.kind === "frame";
  await fs.mkdir(config.exportDir, { recursive: true });

  const executablePath = await findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
  });

  const startedAt = Date.now();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on("pageerror", (error) => console.error(`[export ${job.id}] page error:`, error.message));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`[export ${job.id}] console:`, message.text());
    });

    // `#/editor` mounts the editor straight away, skipping the welcome launcher — so the
    // automation hook (installed by EditorInterface) exists without clicking anything.
    const editorUrl = new URL(config.editorUrl);
    editorUrl.hash = "#/editor";
    await page.goto(editorUrl.href, { waitUntil: "load", timeout: 60_000 });
    await waitForAutomation(page);
    await job.updateProgress(10);

    const loaded = await page.evaluate(
      async (id) => window.__openreelAutomation.loadProjectById(id),
      projectId,
    );
    if (!loaded?.ok) throw new Error(`loadProjectById failed: ${loaded?.error ?? "unknown"}`);
    console.log(
      `[export ${job.id}] loaded "${loaded.name}" — ${loaded.clipCount} clips, ` +
        `${loaded.mediaRestored}/${loaded.mediaTotal} media restored, ${loaded.duration.toFixed(2)}s`,
    );
    await job.updateProgress(25);

    if (isFrame) {
      // One composited PNG: no encoder, no audio mix, no polling loop - it returns directly.
      const frame = await page.evaluate(
        async (options) =>
          window.__openreelAutomation.renderPreviewFrame(options.time, {
            width: options.width,
            height: options.height,
          }),
        { time: job.data.time, width: job.data.width, height: job.data.height },
      );
      if (!frame?.ok) throw new Error(`renderPreviewFrame failed: ${frame?.error ?? "unknown"}`);

      const frameName = `${job.id}.png`;
      const framePath = path.join(config.exportDir, frameName);
      await fs.writeFile(framePath, Buffer.from(frame.base64, "base64"));
      const { size: frameSize } = await fs.stat(framePath);
      if (frameSize === 0) throw new Error("frame wrote an empty file");

      await job.updateProgress(100);
      console.log(`[frame ${job.id}] ${frameName} at ${frame.time}s (${frame.width}x${frame.height}), ${frameSize} bytes`);
      return {
        fileName: frameName,
        filePath: framePath,
        bytes: frameSize,
        durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        width: frame.width,
        height: frame.height,
        time: frame.time,
      };
    }

    // Kick the export off, then poll its progress so a long export reports movement.
    await page.evaluate(
      (settings) => window.__openreelAutomation.startExport(settings),
      { codec, bitrate, quality },
    );

    const deadline = Date.now() + config.exportTimeoutMs;
    let state = null;
    while (Date.now() < deadline) {
      state = await page.evaluate(() => window.__openreelAutomation.getExportState());
      if (state.status === "done" || state.status === "failed") break;
      await job.updateProgress(25 + Math.round((state.progress ?? 0) * 70));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!state || state.status !== "done") {
      throw new Error(`export did not finish: ${JSON.stringify(state)}`);
    }

    const base64 = await page.evaluate(() => window.__openreelAutomation.takeExportBase64());
    if (!base64) throw new Error("export produced no bytes");

    const fileName = `${job.id}.mp4`;
    const filePath = path.join(config.exportDir, fileName);
    await fs.writeFile(filePath, Buffer.from(base64, "base64"));
    const { size } = await fs.stat(filePath);
    if (size === 0) throw new Error("export wrote an empty file");

    await job.updateProgress(100);
    return {
      fileName,
      filePath,
      bytes: size,
      durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      timelineDuration: loaded.duration,
    };
  } finally {
    await browser.close();
  }
}

const worker = new Worker(config.exportQueueName, exportProject, {
  connection: redisConnection,
  concurrency: 1,
});

worker.on("completed", (job, result) => {
  console.log(`[export] job ${job.id} done — ${result.fileName} (${result.bytes} bytes in ${result.durationSeconds}s)`);
});
worker.on("failed", (job, error) => {
  console.error(`[export] job ${job?.id} failed — ${error.message}`);
});

console.log(`[export] listening on queue "${config.exportQueueName}"`);
console.log(`[export] editor: ${config.editorUrl}`);
console.log(`[export] output: ${config.exportDir}`);

async function shutdown() {
  await worker.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
