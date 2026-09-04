import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import Fastify from "fastify";

import { getComponent, listComponents, resolveDuration, validateProps } from "./components.js";
import { config } from "./config.js";
import { createQueue, toApiStatus } from "./queue.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
const queue = createQueue();

// The editor runs on a different localhost port, so allow cross-origin reads.
app.addHook("onRequest", async (request, reply) => {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-headers", "content-type");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") {
    reply.code(204).send();
  }
});

app.get("/health", async (_request, reply) => {
  let redis = "down";
  try {
    const client = await queue.client;
    redis = (await client?.ping()) === "PONG" ? "up" : "down";
  } catch {
    redis = "down";
  }

  const body = {
    status: redis === "up" ? "ok" : "degraded",
    redis,
    redisTarget: `${config.redis.host}:${config.redis.port}`,
    queue: config.queueName,
  };
  if (redis !== "up") {
    body.hint = "Start Redis with: docker compose -f infra/docker-compose.yml up -d";
    reply.code(503);
  }
  return body;
});

/** The catalogue the Component Library panel will render (Stage 4). */
app.get("/components", async () => ({ components: await listComponents() }));

app.post("/render", async (request, reply) => {
  const { componentId, props: rawProps, fps, width, height } = request.body ?? {};

  if (typeof componentId !== "string" || !componentId) {
    return reply.code(400).send({ error: "componentId is required" });
  }

  const meta = await getComponent(componentId);
  if (!meta) {
    return reply.code(404).send({ error: `Unknown componentId "${componentId}"` });
  }

  const { props, errors, ignored } = validateProps(meta, rawProps ?? {});
  if (errors.length > 0) {
    return reply.code(400).send({ error: "Invalid props", details: errors });
  }

  const job = await queue.add("render", {
    componentId,
    props,
    fps: Number(fps) || config.defaultFps,
    width: Number(width) || config.defaultWidth,
    height: Number(height) || config.defaultHeight,
    durationInSeconds: resolveDuration(meta, props),
  });

  return reply.code(202).send({
    jobId: job.id,
    status: "pending",
    componentId,
    props,
    ...(ignored?.length ? { ignoredProps: ignored } : {}),
  });
});

app.get("/render/:jobId", async (request, reply) => {
  const { jobId } = request.params;
  const job = await queue.getJob(jobId);
  if (!job) {
    return reply.code(404).send({ error: `Unknown jobId "${jobId}"` });
  }

  const status = toApiStatus(await job.getState());
  const body = {
    jobId,
    status,
    componentId: job.data.componentId,
    props: job.data.props,
    progress: job.progress ?? 0,
  };

  if (status === "done") {
    const result = job.returnvalue ?? {};
    body.file = result.fileName;
    body.filePath = result.filePath;
    body.url = `/files/${result.fileName}`;
    body.bytes = result.bytes;
    body.frames = result.frames;
    body.durationInSeconds = result.durationInSeconds ?? job.data.durationInSeconds;
  }

  if (status === "failed") {
    body.error = job.failedReason ?? "Render failed";
  }

  return body;
});

/** Serves rendered files straight off the local filesystem. */
app.get("/files/:fileName", async (request, reply) => {
  const { fileName } = request.params;
  if (!/^[A-Za-z0-9._-]+\.webm$/.test(fileName)) {
    return reply.code(400).send({ error: "Invalid file name" });
  }

  const filePath = path.join(config.storageDir, fileName);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return reply.code(404).send({ error: "Not found" });
  }

  reply.header("content-type", "video/webm");
  reply.header("content-length", stat.size);
  reply.header("cache-control", "public, max-age=31536000, immutable");
  return reply.send(createReadStream(filePath));
});

async function main() {
  await fs.mkdir(config.storageDir, { recursive: true });
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `render-service on http://${config.host}:${config.port} — storage ${config.storageDir}`,
  );
}

main().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
