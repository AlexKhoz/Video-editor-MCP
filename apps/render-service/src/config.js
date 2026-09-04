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

  /** SQLite database file (server-side projects, media and component metadata). */
  dbPath: process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(REPO_ROOT, "storage", "video-editor.sqlite"),

  /** Where headless project exports land. */
  exportDir: process.env.EXPORT_DIR
    ? path.resolve(process.env.EXPORT_DIR)
    : path.join(REPO_ROOT, "storage", "exports"),

  /** Where uploaded media bytes live, server-side. */
  mediaDir: process.env.MEDIA_DIR
    ? path.resolve(process.env.MEDIA_DIR)
    : path.join(REPO_ROOT, "storage", "media"),

  /** Per-upload ceiling. Fastify's default 1 MB body limit is far too small for video. */
  uploadLimitBytes: Number(process.env.UPLOAD_LIMIT_BYTES ?? 2 * 1024 * 1024 * 1024),

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

  /** Headless project exports run on their own queue and worker (Stage 10). */
  exportQueueName: process.env.EXPORT_QUEUE_NAME ?? "project-exports",

  /** The editor the export worker drives in headless Chrome. */
  editorUrl: process.env.EDITOR_URL ?? "http://localhost:5173",

  /** Browser used for headless export; falls back to the usual install locations. */
  chromePath: process.env.CHROME_PATH ?? null,

  /** Hard ceiling on one export, in ms. Export runs at roughly real time. */
  exportTimeoutMs: Number(process.env.EXPORT_TIMEOUT_MS ?? 20 * 60_000),

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
