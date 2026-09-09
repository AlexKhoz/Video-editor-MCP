import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Thin HTTP client for render-service.
 *
 * This is the only thing the MCP server knows about the rest of the system: it talks to
 * the public API, never to render-service's internals or to project-kit directly.
 */

export const SERVICE_URL = process.env.RENDER_SERVICE_URL ?? "http://127.0.0.1:3001";

export class ServiceError extends Error {
  constructor(status, body, route) {
    const detail =
      typeof body === "object" && body
        ? body.error ?? JSON.stringify(body)
        : String(body ?? "");
    super(`${route} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "ServiceError";
    this.status = status;
    this.body = body;
    this.route = route;
  }
}

async function request(method, route, { body, headers } = {}) {
  let response;
  try {
    response = await fetch(`${SERVICE_URL}${route}`, {
      method,
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          }
        : headers
          ? { headers }
          : {}),
    });
  } catch (error) {
    throw new Error(
      `Could not reach render-service at ${SERVICE_URL} (${error.message}). ` +
        `Start it with: cd apps/render-service && npm start`,
    );
  }

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) throw new ServiceError(response.status, parsed, `${method} ${route}`);
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const service = {
  health: () => request("GET", "/health"),
  listComponents: () => request("GET", "/components"),
  listProjects: (folder) =>
    request(
      "GET",
      folder ? `/projects?folder=${encodeURIComponent(folder)}` : "/projects",
    ),
  listProjectFolders: () => request("GET", "/projects/folders"),
  getProject: (id) => request("GET", `/projects/${encodeURIComponent(id)}`),
  createProject: (body) => request("POST", "/projects/new", { body }),
  applyOps: (id, body) => request("POST", `/projects/${encodeURIComponent(id)}/ops`, { body }),
  startRender: (body) => request("POST", "/render", { body }),
  renderStatus: (jobId) => request("GET", `/render/${encodeURIComponent(jobId)}`),
  startExport: (id, body) => request("POST", `/projects/${encodeURIComponent(id)}/export`, { body }),
  exportStatus: (jobId) => request("GET", `/export/${encodeURIComponent(jobId)}`),
  startFrame: (id, body) => request("POST", `/projects/${encodeURIComponent(id)}/frame`, { body }),

  /** Uploads a local file's bytes. Returns { id, filename, size, url }. */
  async uploadMedia({ filePath, mediaId, mimeType }) {
    const absolute = path.resolve(filePath);
    const bytes = await fs.readFile(absolute);
    const response = await fetch(`${SERVICE_URL}/media`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": path.basename(absolute),
        ...(mediaId ? { "x-media-id": mediaId } : {}),
        "x-mime-type": mimeType ?? guessMimeType(absolute),
      },
      body: bytes,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ServiceError(response.status, parsed, "POST /media");
    return parsed;
  },

  async downloadToFile(route, destination) {
    const response = await fetch(`${SERVICE_URL}${route}`);
    if (!response.ok) throw new ServiceError(response.status, null, `GET ${route}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, buffer);
    return { path: destination, bytes: buffer.length };
  },

  /**
   * Polls a job to completion so the caller never has to. Throws on failure or timeout.
   */
  async waitForJob(fetchStatus, { timeoutMs, intervalMs = 2000, label }) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await fetchStatus();
      if (last.status === "done") return last;
      if (last.status === "failed") {
        throw new Error(`${label} failed: ${last.error ?? "unknown error"}`);
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `${label} did not finish within ${Math.round(timeoutMs / 1000)}s ` +
        `(last status: ${last?.status ?? "unknown"}, progress ${last?.progress ?? 0})`,
    );
  },
};

function guessMimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
    }[ext] ?? "application/octet-stream"
  );
}

/** ffprobe-free metadata is not possible, so media metadata comes from the service. */
export async function probeViaService(mediaId) {
  const { media } = await request("GET", "/media");
  return media.find((item) => item.id === mediaId) ?? null;
}
