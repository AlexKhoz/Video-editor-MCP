import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SERVICE_ROOT, "..", "..");

export const config = {
  serviceRoot: SERVICE_ROOT,
  repoRoot: REPO_ROOT,

  /** Where rendered files land. Local filesystem only — no object storage at this stage. */
  storageDir: process.env.RENDER_STORAGE_DIR
    ? path.resolve(process.env.RENDER_STORAGE_DIR)
    : path.join(REPO_ROOT, "storage", "rendered"),

  /** The standalone Motion Canvas project from Stage 2. */
  componentLibraryDir: process.env.COMPONENT_LIBRARY_DIR
    ? path.resolve(process.env.COMPONENT_LIBRARY_DIR)
    : path.join(REPO_ROOT, "packages", "component-library"),

  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),

  redis: {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
  },

  queueName: process.env.QUEUE_NAME ?? "component-renders",

  /** Chrome + ffmpeg are heavy; one render at a time keeps the box usable. */
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),

  /** Hard ceiling on a single render, in ms. */
  renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 10 * 60_000),

  /** Defaults for the rendered frame; overridable per request. */
  defaultFps: Number(process.env.RENDER_FPS ?? 30),
  defaultWidth: Number(process.env.RENDER_WIDTH ?? 1920),
  defaultHeight: Number(process.env.RENDER_HEIGHT ?? 1080),
};

export const componentsDir = path.join(config.componentLibraryDir, "components");
export const renderScript = path.join(config.componentLibraryDir, "scripts", "render.mjs");
