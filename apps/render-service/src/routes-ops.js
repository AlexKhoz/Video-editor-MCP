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

    if (status === "done") {
      const result = job.returnvalue ?? {};
      body.file = result.fileName;
      body.filePath = result.filePath;
      body.url = `/exports/${result.fileName}`;
      body.bytes = result.bytes;
      body.durationSeconds = result.durationSeconds;
    }
    if (status === "failed") body.error = job.failedReason ?? "Export failed";

    return body;
  });

  app.get("/exports/:fileName", async (request, reply) => {
    const { fileName } = request.params;
    if (!/^[A-Za-z0-9._-]+\.(mp4|webm|mov)$/.test(fileName)) {
      return reply.code(400).send({ error: "Invalid file name" });
    }
    const filePath = path.join(config.exportDir, fileName);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
    reply.header("content-type", "video/mp4");
    reply.header("content-length", stat.size);
    return reply.send(createReadStream(filePath));
  });
}
