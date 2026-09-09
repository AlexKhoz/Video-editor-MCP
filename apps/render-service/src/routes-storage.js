import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import { probeMedia } from "./probe.js";
import { sweepAll, sweepOrphanedMedia } from "./sweep.js";
import {
  deleteProject,
  getComponentMetadata,
  getMedia,
  getProject,
  getProjectUpdatedAt,
  insertMedia,
  listComponentMetadata,
  listMedia,
  listProjectFolders,
  listProjects,
  upsertComponentMetadata,
  upsertProject,
} from "./db.js";

const SAFE_EXT = /^\.[A-Za-z0-9]{1,8}$/;

/**
 * Fails the stream once more than `limit` bytes have gone through.
 *
 * Fastify's own bodyLimit does not apply here: the octet-stream parser below hands the raw
 * request stream to the route instead of buffering it, which is what keeps a 2 GB upload out
 * of memory - and also what removes the ceiling. Without this a runaway upload just fills the
 * disk, and the client learns nothing.
 */
function sizeLimiter(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) {
        const error = new Error(`Upload exceeds the ${limit} byte limit`);
        error.code = "UPLOAD_TOO_LARGE";
        done(error);
        return;
      }
      done(null, chunk);
    },
  });
}

/**
 * Parses a single-range `Range: bytes=…` header.
 *
 * Returns `null` for no/unsupported range header (serve the whole file), `"invalid"` when
 * the range cannot be satisfied (416), or the resolved `{ start, end }` inclusive offsets.
 * Multi-range requests are deliberately treated as "serve the whole file" — browsers only
 * use them for byte-serving PDFs, never for media playback.
 */
export function parseByteRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";

  let start;
  let end;
  if (rawStart === "") {
    // Suffix form: "bytes=-500" means the last 500 bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/**
 * Server-side storage routes: projects, media bytes and component metadata.
 *
 * No authentication — every project is readable and writable by anyone who can reach
 * the service. That is a deliberate limitation for this stage (see NOTES.md).
 */
export async function registerStorageRoutes(app) {
  await fs.mkdir(config.mediaDir, { recursive: true });

  /**
   * Uploads stream straight to disk. Raw `application/octet-stream` with the filename in
   * a header rather than multipart: the only client is our own editor, so this keeps the
   * body a stream — never buffering a whole video in memory — with no extra dependency.
   * The parser hands the route the raw request stream instead of a parsed body.
   */
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  /* -------------------------------------------------------------- projects */

  app.get("/projects", async (request) => {
    const { folder } = request.query ?? {};
    return {
      projects: listProjects(
        typeof folder === "string" && folder !== "" ? { folder } : {},
      ),
    };
  });

  /**
   * The distinct folders in use, for a picker.
   *
   * Declared before `/projects/:id` for readability only — find-my-way matches static
   * segments ahead of parametric ones regardless of registration order, so "folders" can
   * never be swallowed as an id. Verified with a real request, not assumed.
   */
  app.get("/projects/folders", async () => ({ folders: listProjectFolders() }));

  app.get("/projects/:id", async (request, reply) => {
    const record = getProject(request.params.id);
    if (!record) return reply.code(404).send({ error: "Unknown project" });
    return record;
  });

  app.post("/projects", async (request, reply) => {
    const { id, name, project, folder } = request.body ?? {};
    if (!project || typeof project !== "object") {
      return reply.code(400).send({ error: "project (object) is required" });
    }
    const projectId = typeof id === "string" && id ? id : (project.id ?? randomUUID());
    const projectName = typeof name === "string" && name ? name : (project.name ?? "Untitled");
    const saved = upsertProject({ id: projectId, name: projectName, project, folder });
    return reply.code(201).send(saved);
  });

  app.put("/projects/:id", async (request, reply) => {
    const { name, project, folder, expectedUpdatedAt } = request.body ?? {};
    if (!project || typeof project !== "object") {
      return reply.code(400).send({ error: "project (object) is required" });
    }

    // Optional optimistic-concurrency guard. Clients that pass the `updatedAt` they last
    // saw get a 409 instead of silently overwriting someone else's newer save; clients
    // that omit it keep the old last-write-wins behaviour.
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null) {
      const current = getProjectUpdatedAt(request.params.id);
      if (current !== null && current !== Number(expectedUpdatedAt)) {
        return reply.code(409).send({
          error: "Project changed on the server since you loaded it",
          serverUpdatedAt: current,
          yourUpdatedAt: Number(expectedUpdatedAt),
        });
      }
    }

    const projectName =
      typeof name === "string" && name ? name : (project.name ?? "Untitled");
    // folder is passed through as-is: undefined leaves whatever is stored alone, so an
    // ordinary editor save cannot reset it.
    return upsertProject({ id: request.params.id, name: projectName, project, folder });
  });

  app.delete("/projects/:id", async (request, reply) => {
    if (!deleteProject(request.params.id)) {
      return reply.code(404).send({ error: "Unknown project" });
    }
    // Sweep media no surviving project references, plus its component metadata.
    const removed = await sweepOrphanedMedia();
    return { deleted: request.params.id, orphanedMediaRemoved: removed };
  });

  /** Explicit sweep, for when media was orphaned by editing rather than deleting. */
  app.post("/media/sweep", async () => ({ orphanedMediaRemoved: await sweepOrphanedMedia() }));

  /**
   * `POST /storage/sweep` - housekeeping across all three directories.
   *
   * Body (all optional):
   *   dryRun                     report what would go, delete nothing
   *   rendered.minAgeMinutes     grace period for uncollected renders (default 60)
   *   exports.keep               newest exports to always keep (default 10)
   *   exports.maxAgeHours        keep anything younger than this (default 168)
   */
  app.post("/storage/sweep", async (request) => {
    const body = request.body ?? {};
    return sweepAll({
      dryRun: Boolean(body.dryRun),
      rendered: body.rendered ?? {},
      exports: body.exports ?? {},
    });
  });

  /* ----------------------------------------------------------------- media */

  app.get("/media", async () => ({ media: listMedia() }));

  /**
   * `POST /media` — raw bytes in the body.
   *   headers: content-type: application/octet-stream
   *            x-filename:  original file name
   *            x-media-id:  optional, to keep the editor's own mediaId as the key
   */
  app.post("/media", async (request, reply) => {
    const stream = request.body;
    if (!stream || typeof stream.pipe !== "function") {
      return reply.code(400).send({ error: "Expected a raw application/octet-stream body" });
    }

    const rawName = String(request.headers["x-filename"] ?? "upload.bin");
    const filename = path.basename(rawName).replace(/[^\w.\- ]+/g, "_") || "upload.bin";
    const suppliedId = request.headers["x-media-id"];
    const id =
      typeof suppliedId === "string" && /^[\w-]{6,64}$/.test(suppliedId)
        ? suppliedId
        : randomUUID();

    const ext = path.extname(filename);
    const storageName = `${id}${SAFE_EXT.test(ext) ? ext : ""}`;
    const storagePath = path.join(config.mediaDir, storageName);

    // Reject on the declared length when there is one, so a doomed upload does not have to
    // travel first; the limiter is what catches a chunked body with no content-length.
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > config.uploadLimitBytes) {
      return reply.code(413).send({
        error: "Upload too large",
        limitBytes: config.uploadLimitBytes,
        declaredBytes: declared,
      });
    }

    try {
      await pipeline(stream, sizeLimiter(config.uploadLimitBytes), createWriteStream(storagePath));
    } catch (error) {
      await fs.rm(storagePath, { force: true });
      if (error?.code === "UPLOAD_TOO_LARGE") {
        return reply.code(413).send({ error: "Upload too large", limitBytes: config.uploadLimitBytes });
      }
      throw error;
    }

    const { size } = await fs.stat(storagePath);
    if (size === 0) {
      await fs.rm(storagePath, { force: true });
      return reply.code(400).send({ error: "Upload was empty" });
    }

    // Probe server-side so headless callers (ops API, MCP server) get the same metadata
    // the browser's importMedia would have produced — they need it for the add_media op.
    // mediaType matters as much as the metadata: a still registered as "video" makes the
    // export engine try to open a video track that isn't there.
    let metadata = null;
    let mediaType = null;
    try {
      ({ metadata, mediaType } = await probeMedia(storagePath));
    } catch (error) {
      app.log.warn(`ffprobe failed for ${filename}: ${error.message}`);
    }

    const record = insertMedia({
      id,
      filename,
      storagePath,
      mimeType: String(request.headers["x-mime-type"] ?? "application/octet-stream"),
      size,
      metadata,
      mediaType,
    });

    return reply.code(201).send({ ...record, url: `/media/${id}` });
  });

  app.get("/media/:id", async (request, reply) => {
    const record = getMedia(request.params.id);
    if (!record) return reply.code(404).send({ error: "Unknown media" });

    let stat;
    try {
      stat = await fs.stat(record.storagePath);
    } catch {
      return reply.code(410).send({ error: "Media row exists but the file is gone" });
    }

    // Range support matters for video: without it, seeking re-downloads the whole file,
    // and <video> elements cannot start playing until the entire clip has arrived.
    // Parsed before the media content-type is set, because the 416 body is JSON and
    // Fastify refuses to serialise an object once the type says video/*.
    const range = parseByteRange(request.headers.range, stat.size);

    if (range === "invalid") {
      reply.header("content-range", `bytes */${stat.size}`);
      reply.header("accept-ranges", "bytes");
      return reply.code(416).send({ error: "Requested range not satisfiable" });
    }

    reply.header("content-type", record.mimeType);
    reply.header("accept-ranges", "bytes");
    reply.header("x-filename", record.filename);

    if (range) {
      reply.code(206);
      reply.header("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.header("content-length", range.end - range.start + 1);
      return reply.send(
        createReadStream(record.storagePath, { start: range.start, end: range.end }),
      );
    }

    reply.header("content-length", stat.size);
    return reply.send(createReadStream(record.storagePath));
  });

  /* ---------------------------------------------------- component metadata */

  app.get("/component-metadata", async () => ({ entries: listComponentMetadata() }));

  app.get("/component-metadata/:mediaId", async (request, reply) => {
    const entry = getComponentMetadata(request.params.mediaId);
    if (!entry) return reply.code(404).send({ error: "Unknown mediaId" });
    return entry;
  });

  app.post("/component-metadata", async (request, reply) => {
    const { mediaId, componentId, props, background, renderedFileId } = request.body ?? {};
    if (typeof mediaId !== "string" || !mediaId) {
      return reply.code(400).send({ error: "mediaId is required" });
    }
    if (typeof componentId !== "string" || !componentId) {
      return reply.code(400).send({ error: "componentId is required" });
    }
    const saved = upsertComponentMetadata({
      mediaId,
      componentId,
      props,
      background: background ?? null,
      renderedFileId: renderedFileId ?? null,
    });
    return reply.code(201).send(saved);
  });
}
