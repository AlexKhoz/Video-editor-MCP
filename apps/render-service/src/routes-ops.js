import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { applyOps, createProject, ProjectKitError } from "../../../packages/project-kit/src/index.js";

import { config } from "./config.js";
import { getProject, getProjectUpdatedAt, upsertProject } from "./db.js";
import { createExportQueue, toApiStatus } from "./queue.js";

/**
 * Headless project manipulation (Stage 10).
 *
 * `POST /projects/:id/ops` applies a list of project-kit operations atomically, so a
 * program can build and edit a project without a browser. `POST /projects/:id/export`
 * queues a headless-Chrome export, polled exactly like a component render.
 *
 * NO AUTHENTICATION. This is acceptable *only* because everything is bound to localhost.
 * These endpoints let any caller rewrite or export any project, which is a materially
 * bigger exposure than the read/write UI — close this before the service is reachable by
 * anyone but us. See NOTES.md.
 */
export async function registerOpsRoutes(app) {
  await fs.mkdir(config.exportDir, { recursive: true });
  const exportQueue = createExportQueue();

  app.addHook("onClose", async () => {
    await exportQueue.close();
  });

  /** Create an empty, valid project server-side (no browser involved). */
  app.post("/projects/new", async (request, reply) => {
    const { name, width, height, frameRate } = request.body ?? {};
    const project = createProject({ name, width, height, frameRate });
    const saved = upsertProject({ id: project.id, name: project.name, project });
    return reply.code(201).send({ ...saved, project });
  });

  app.post("/projects/:id/ops", async (request, reply) => {
    const { ops, expectedUpdatedAt } = request.body ?? {};
    const record = getProject(request.params.id);
    if (!record) return reply.code(404).send({ error: "Unknown project" });

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

    try {
      // Atomic: applyOps never mutates the loaded project, so a failure at step N leaves
      // the stored project exactly as it was — nothing is written.
      const { project, results } = applyOps(record.project, ops);
      const saved = upsertProject({ id: project.id, name: project.name, project });
      return {
        ...saved,
        results,
        timelineDuration: project.timeline.duration,
      };
    } catch (error) {
      if (error instanceof ProjectKitError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  /* ----------------------------------------------------------------- export */

  app.post("/projects/:id/export", async (request, reply) => {
    const record = getProject(request.params.id);
    if (!record) return reply.code(404).send({ error: "Unknown project" });

    const { format = "mp4", codec = "h264", bitrate, quality } = request.body ?? {};
    if (format !== "mp4") {
      return reply
        .code(400)
        .send({ error: 'Only format "mp4" is wired up in this stage' });
    }

    const job = await exportQueue.add("export", {
      projectId: request.params.id,
      projectName: record.name,
      format,
      codec,
      bitrate,
      quality,
    });

    return reply.code(202).send({ jobId: job.id, status: "pending", projectId: request.params.id });
  });

  /**
   * `POST /projects/:id/frame` — one composited PNG instead of a whole video.
   *
   * Same queue and same worker as export (one headless Chrome at a time is still the rule),
   * but the job skips the encoder and the audio mix, so it comes back in seconds. Poll it
   * through the same GET /export/:jobId.
   */
  app.post("/projects/:id/frame", async (request, reply) => {
    const record = getProject(request.params.id);
    if (!record) return reply.code(404).send({ error: "Unknown project" });

    const { time = 0, width, height } = request.body ?? {};
    const at = Number(time);
    if (!Number.isFinite(at) || at < 0) {
      return reply.code(400).send({ error: "time must be a non-negative number of seconds" });
    }

    const job = await exportQueue.add("frame", {
      kind: "frame",
      projectId: request.params.id,
      projectName: record.name,
      time: at,
      width: width === undefined ? undefined : Number(width),
      height: height === undefined ? undefined : Number(height),
    });

    return reply.code(202).send({ jobId: job.id, status: "pending", projectId: request.params.id, time: at });
  });

  app.get("/export/:jobId", async (request, reply) => {
    const job = await exportQueue.getJob(request.params.jobId);
    if (!job) return reply.code(404).send({ error: "Unknown export job" });

    const status = toApiStatus(await job.getState());
    const body = {
      jobId: request.params.jobId,
      status,
      projectId: job.data.projectId,
      progress: job.progress ?? 0,
    };

    if (job.data.kind === "frame") body.kind = "frame";

    if (status === "done") {
      const result = job.returnvalue ?? {};
      body.file = result.fileName;
      body.filePath = result.filePath;
      body.url = `/exports/${result.fileName}`;
      body.bytes = result.bytes;
      body.durationSeconds = result.durationSeconds;
      if (result.width) body.width = result.width;
      if (result.height) body.height = result.height;
      if (result.time !== undefined) body.time = result.time;
    }
    if (status === "failed") body.error = job.failedReason ?? "Export failed";

    return body;
  });

  const EXPORT_CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".png": "image/png",
  };

  app.get("/exports/:fileName", async (request, reply) => {
    const { fileName } = request.params;
    if (!/^[A-Za-z0-9._-]+\.(mp4|webm|mov|png)$/.test(fileName)) {
      return reply.code(400).send({ error: "Invalid file name" });
    }
    const filePath = path.join(config.exportDir, fileName);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
    reply.header("content-type", EXPORT_CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream");
    reply.header("content-length", stat.size);
    return reply.send(createReadStream(filePath));
  });
}
