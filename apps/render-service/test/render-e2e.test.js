/**
 * Minimal end-to-end test: ask the API to render `stat-counter` with custom props,
 * wait for the job to finish, and confirm the file exists and is non-empty.
 *
 * Needs Redis (infra/docker-compose.yml) and, because it runs the real Stage 2
 * pipeline, ffmpeg on PATH plus an installed Chrome. Run with:
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";

import { config } from "../src/config.js";

const PORT = Number(process.env.TEST_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_LABEL = "E2E render";

let server;
let worker;
let renderedFile;

const children = [];

function spawnService(entry) {
  const child = spawn(process.execPath, [path.join(config.serviceRoot, "src", entry)], {
    cwd: config.serviceRoot,
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${entry}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${entry}] ${chunk}`));
  // Remember why a child died so a startup failure reports itself instead of
  // showing up later as a vague "did not become healthy".
  child.on("exit", (code, signal) => {
    if (code !== 0 && !signal) child.exitError = `${entry} exited with code ${code}`;
  });
  children.push({ entry, child });
  return child;
}

function deadChild() {
  return children.find(({ child }) => child.exitCode !== null && child.exitCode !== 0);
}

async function portIsFree() {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host: "127.0.0.1", port: PORT });
    probe.setTimeout(1000);
    const done = (free) => {
      probe.destroy();
      resolve(free);
    };
    probe.on("connect", () => done(false));
    probe.on("error", () => done(true));
    probe.on("timeout", () => done(true));
  });
}

async function redisReachable() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: config.redis.host, port: config.redis.port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

async function waitForHealth(attempts = 40) {
  let lastBody = null;
  for (let i = 0; i < attempts; i += 1) {
    const dead = deadChild();
    if (dead) {
      throw new Error(
        `${dead.child.exitError ?? `${dead.entry} exited`} — see its output above for the cause`,
      );
    }
    try {
      const response = await fetch(`${BASE}/health`);
      lastBody = await response.json();
      if (response.ok) return lastBody;
    } catch {
      // server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `render-service did not become healthy${lastBody ? `; last /health said ${JSON.stringify(lastBody)}` : ""}`,
  );
}

before(async () => {
  assert.ok(
    await redisReachable(),
    `Redis is not reachable at ${config.redis.host}:${config.redis.port}. ` +
      `Start it with: docker compose -f infra/docker-compose.yml up -d`,
  );
  assert.ok(
    await portIsFree(),
    `Port ${PORT} is already in use — a server from an earlier run is probably still alive. ` +
      `Kill it, or set TEST_PORT to something else.`,
  );
  server = spawnService("server.js");
  worker = spawnService("worker.js");
  const health = await waitForHealth();
  assert.equal(health.redis, "up");
});

after(async () => {
  server?.kill();
  worker?.kill();
  if (renderedFile && !process.env.KEEP_TEST_OUTPUT) {
    await fs.rm(renderedFile, { force: true });
  }
});

test("lists the component catalogue", async () => {
  const response = await fetch(`${BASE}/components`);
  assert.equal(response.status, 200);
  const { components } = await response.json();
  const ids = components.map((component) => component.id);
  assert.ok(ids.includes("stat-counter"), `expected stat-counter in ${ids.join(", ")}`);

  const statCounter = components.find((component) => component.id === "stat-counter");
  const types = new Set(statCounter.params.map((param) => param.type));
  for (const type of types) {
    assert.ok(
      ["text", "number", "color", "boolean", "media"].includes(type),
      `param type "${type}" is outside OpenReel's MotionVariable vocabulary`,
    );
  }
});

test("rejects an unknown component", async () => {
  const response = await fetch(`${BASE}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ componentId: "does-not-exist", props: {} }),
  });
  assert.equal(response.status, 404);
});

test("rejects props that fail the schema", async () => {
  const response = await fetch(`${BASE}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      componentId: "stat-counter",
      props: { accentColor: "not-a-colour", durationInSeconds: 999 },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Invalid props");
  assert.equal(body.details.length, 2);
});

test("renders stat-counter end to end and writes a non-empty file", async (t) => {
  const enqueue = await fetch(`${BASE}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      componentId: "stat-counter",
      props: { label: TEST_LABEL, accentColor: "#ffcc00", durationInSeconds: 2 },
    }),
  });
  assert.equal(enqueue.status, 202);

  const { jobId, status, props } = await enqueue.json();
  assert.ok(jobId, "expected a jobId");
  assert.equal(status, "pending");
  assert.equal(props.label, TEST_LABEL);

  const deadline = Date.now() + 8 * 60_000;
  let final;
  const seen = new Set();
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE}/render/${jobId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    seen.add(body.status);
    if (body.status === "done" || body.status === "failed") {
      final = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  assert.ok(final, "job did not settle before the deadline");
  assert.equal(final.status, "done", `job failed: ${final.error ?? "unknown"}`);
  t.diagnostic(`statuses observed: ${[...seen].join(" -> ")}`);

  assert.equal(final.file, `${jobId}.webm`);
  assert.equal(final.url, `/files/${jobId}.webm`);

  renderedFile = path.join(config.storageDir, final.file);
  const stat = await fs.stat(renderedFile);
  assert.ok(stat.size > 0, "rendered file is empty");
  assert.equal(stat.size, final.bytes);
  t.diagnostic(`${final.file}: ${stat.size} bytes, ${final.frames} frames`);

  // The file must also be downloadable through the API, since that is how the editor
  // will pull it into its media library at Stage 4.
  const download = await fetch(`${BASE}${final.url}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "video/webm");
  const bytes = await download.arrayBuffer();
  assert.equal(bytes.byteLength, stat.size);

  // WebM magic bytes (EBML header).
  const head = new Uint8Array(bytes.slice(0, 4));
  assert.deepEqual([...head], [0x1a, 0x45, 0xdf, 0xa3], "not a WebM/EBML file");
});

test("reports 404 for an unknown job", async () => {
  const response = await fetch(`${BASE}/render/999999`);
  assert.equal(response.status, 404);
});
