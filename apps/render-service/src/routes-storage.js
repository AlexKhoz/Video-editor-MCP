import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import {
  deleteProject,
  getComponentMetadata,
  getMedia,
  getProject,
  insertMedia,
  listComponentMetadata,
  listMedia,
  listProjects,
  upsertComponentMetadata,
  upsertProject,
} from "./db.js";

const SAFE_EXT = /^\.[A-Za-z0-9]{1,8}$/;

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

  app.get("/projects", async () => ({ projects: listProjects() }));

  app.get("/projects/:id", async (request, reply) => {
    const record = getProject(request.params.id);
    if (!record) return reply.code(404).send({ error: "Unknown project" });
    return record;
  });

  app.post("/projects", async (request, reply) => {
    const { id, name, project } = request.body ?? {};
    if (!project || typeof project !== "object") {
      return reply.code(400).send({ error: "project (object) is required" });
    }
    const projectId = typeof id === "string" && id ? id : (project.id ?? randomUUID());
    const projectName = typeof name === "string" && name ? name : (project.name ?? "Untitled");
    const saved = upsertProject({ id: projectId, name: projectName, project });
    return reply.code(201).send(saved);
  });

  app.put("/projects/:id", async (request, reply) => {
    const { name, project } = request.body ?? {};
    if (!project || typeof project !== "object") {
      return reply.code(400).send({ error: "project (object) is required" });
    }
    const projectName =
      typeof name === "string" && name ? name : (project.name ?? "Untitled");
    return upsertProject({ id: request.params.id, name: projectName, project });
  });

  app.delete("/projects/:id", async (request, reply) => {
    if (!deleteProject(request.params.id)) {
      return reply.code(404).send({ error: "Unknown project" });
    }
    return { deleted: request.params.id };
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

    await pipeline(stream, createWriteStream(storagePath));
    const { size } = await fs.stat(storagePath);
    if (size === 0) {
      await fs.rm(storagePath, { force: true });
      return reply.code(400).send({ error: "Upload was empty" });
    }

    const record = insertMedia({
      id,
      filename,
      storagePath,
      mimeType: String(request.headers["x-mime-type"] ?? "application/octet-stream"),
      size,
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

    reply.header("content-type", record.mimeType);
    reply.header("content-length", stat.size);
    reply.header("accept-ranges", "none");
    reply.header("x-filename", record.filename);
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
