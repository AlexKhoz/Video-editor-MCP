#!/usr/bin/env node
/**
 * Renders one component to a transparent WebM.
 *
 *   node scripts/render.mjs --component stat-counter \
 *     --props '{"label":"Active users","targetNumber":1250,"durationInSeconds":3}' \
 *     --out ../../storage/rendered/demo.webm
 *
 * Pipeline: Vite dev server -> headless Chrome loads render-harness.html ->
 * Motion Canvas image-sequence exporter streams PNGs (with alpha) back over the HMR
 * channel, which the Vite plugin writes into ./output/<component>/ -> ffmpeg muxes
 * them into VP9 + yuva420p WebM, matching OpenReel's own "webm-alpha" export.
 *
 * Everything here is local: no cloud services, no API keys. The only external binary
 * is ffmpeg (on PATH) and an already-installed Chrome/Chromium.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "output");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function parseArgs(argv) {
  const args = { fps: 30, keepFrames: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--component":
        args.component = value;
        i += 1;
        break;
      case "--props":
        args.props = JSON.parse(value);
        i += 1;
        break;
      case "--out":
        args.out = value;
        i += 1;
        break;
      case "--fps":
        args.fps = Number(value);
        i += 1;
        break;
      case "--width":
        args.width = Number(value);
        i += 1;
        break;
      case "--height":
        args.height = Number(value);
        i += 1;
        break;
      case "--background":
        args.background = value;
        i += 1;
        break;
      case "--keep-frames":
        args.keepFrames = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.component) throw new Error("--component is required");
  if (!args.out) throw new Error("--out is required");
  if (args.background && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(args.background)) {
    throw new Error(`--background must be a hex colour such as #00ff00 (got "${args.background}")`);
  }
  return args;
}

/**
 * A component may declare its own frame size in meta.json — turbulent-background-Rep renders
 * 9:16. Explicit --width/--height still win; this only fills in what was not passed.
 */
async function componentDefaults(component) {
  const metaPath = path.join(ROOT, "components", component, "meta.json");
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    return {
      width: Number(meta.defaultWidth) || null,
      height: Number(meta.defaultHeight) || null,
    };
  } catch {
    return { width: null, height: null };
  }
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error(
    `No Chrome/Chromium found. Set CHROME_PATH. Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`,
  );
}

async function renderFrames({ component, props, fps, width, height, background }) {
  const framesDir = path.join(OUTPUT_DIR, component);
  await fs.rm(framesDir, { recursive: true, force: true });

  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    logLevel: "warn",
    server: { port: 0 },
  });
  await server.listen();

  const address = server.httpServer.address();
  const url = new URL(`http://localhost:${address.port}/render-harness.html`);
  url.searchParams.set("project", component);
  url.searchParams.set("fps", String(fps));
  url.searchParams.set("width", String(width));
  url.searchParams.set("height", String(height));
  if (props) url.searchParams.set("props", JSON.stringify(props));
  if (background) url.searchParams.set("bg", background);

  const browser = await puppeteer.launch({
    executablePath: await findChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
  });

  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error("[page error]", error.message));
    page.on("console", (message) => {
      const text = message.text();
      // Errors always; Motion Canvas's own diagnostics (forwarded by the harness as "[mc]")
      // because a swallowed scene error otherwise shows up only as "no frames were written".
      if (message.type() === "error") console.error("[page console]", text);
      else if (text.startsWith("[mc]")) console.log(text);
    });

    console.log(`[render] ${component} -> ${url.href}`);
    await page.goto(url.href, { waitUntil: "load", timeout: 60_000 });

    const report = await page.waitForFunction(
      () => (window.__mcRender?.status !== "working" ? window.__mcRender : null),
      { timeout: 10 * 60_000, polling: 500 },
    );
    const result = await report.jsonValue();
    if (result.status === "error") {
      throw new Error(`Render failed in the browser:\n${result.error}`);
    }
    console.log(`[render] browser reported ${result.frames} frames`);
  } finally {
    await browser.close();
    await server.close();
  }

  // The exporter writes asynchronously over HMR; give the last frames a moment to land.
  const frames = await waitForFrames(framesDir);
  console.log(`[render] ${frames.length} PNG frames in ${path.relative(ROOT, framesDir)}`);
  return { framesDir, frameCount: frames.length };
}

async function waitForFrames(framesDir, attempts = 20) {
  let previous = -1;
  for (let i = 0; i < attempts; i += 1) {
    const frames = (await fs.readdir(framesDir).catch(() => [])).filter((f) => f.endsWith(".png"));
    if (frames.length > 0 && frames.length === previous) return frames.sort();
    previous = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const frames = (await fs.readdir(framesDir).catch(() => [])).filter((f) => f.endsWith(".png"));
  if (frames.length === 0) throw new Error(`No frames were written to ${framesDir}`);
  return frames.sort();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}:\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Two modes:
 *
 *  - transparent (default): VP9 + yuva420p, the combination OpenReel itself exports as
 *    "webm-alpha" (apps/editor/apps/web/src/motion/export-motion-frame.ts). Portable, but
 *    OpenReel's own decoder drops the alpha channel.
 *  - chroma key (--background): the frames already carry a solid backdrop, so the alpha
 *    plane is pointless — plain yuv420p is smaller and decodes everywhere.
 */
async function encodeWebm({ framesDir, fps, out, background }) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  await runFfmpeg([
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(framesDir, "%06d.png"),
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    background ? "yuv420p" : "yuva420p",
    "-b:v",
    "0",
    // CRF 20, not the more usual 28. VP9 stores alpha as a separate full-resolution
    // greyscale stream that gets this same CRF, and quantising it visibly ripples glyph
    // contours: on a stem edge the renderer draws byte-identically for 159 rows, crf 28
    // wobbles the decoded alpha by +-12 (peak-to-peak 35), which reads as uneven, fuzzy
    // type at any zoom. crf 20 brings that to 8 for 1.4x the bytes. Chroma subsampling is
    // not the cause and 4:4:4 does not help - see Stage 18 in NOTES.md.
    "-crf",
    "20",
    "-row-mt",
    "1",
    "-auto-alt-ref",
    "0",
    out,
  ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(process.cwd(), args.out);

  // Frame size: explicit flags, else the component's own default, else 16:9.
  const defaults = await componentDefaults(args.component);
  args.width = args.width || defaults.width || 1920;
  args.height = args.height || defaults.height || 1080;
  console.log(`[render] frame ${args.width}x${args.height} @ ${args.fps}fps`);

  const { framesDir, frameCount } = await renderFrames(args);
  await encodeWebm({ framesDir, fps: args.fps, out, background: args.background });

  if (!args.keepFrames) {
    await fs.rm(framesDir, { recursive: true, force: true });
  }

  const { size } = await fs.stat(out);
  console.log(
    `[render] wrote ${out} (${size} bytes, ${frameCount} frames @ ${args.fps}fps, ` +
      `VP9/${args.background ? `yuv420p on ${args.background}` : "yuva420p transparent"})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
