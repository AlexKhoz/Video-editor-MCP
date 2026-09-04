import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Worker } from "bullmq";

import { getComponent } from "./components.js";
import { config, renderScript } from "./config.js";
import { redisConnection } from "./queue.js";

/**
 * Runs the Stage 2 render pipeline as-is (Vite dev server + headless Chrome +
 * image-sequence exporter + ffmpeg to VP9/yuva420p). Deliberately shelled out rather
 * than reimplemented: that script is already proven to produce a correct alpha channel.
 */
function runRenderScript({ componentId, props, out, fps, width, height }) {
  return new Promise((resolve, reject) => {
    const args = [
      renderScript,
      "--component",
      componentId,
      "--props",
      JSON.stringify(props),
      "--out",
      out,
      "--fps",
      String(fps),
      "--width",
      String(width),
      "--height",
      String(height),
    ];

    const child = spawn(process.execPath, args, {
      cwd: config.componentLibraryDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Render timed out after ${config.renderTimeoutMs}ms`));
    }, config.renderTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`render.mjs exited with ${code}\n${stderr.slice(-2000) || stdout.slice(-2000)}`));
      }
    });
  });
}

function parseFrameCount(stdout) {
  const match = stdout.match(/browser reported (\d+) frames/);
  return match ? Number(match[1]) : null;
}

const worker = new Worker(
  config.queueName,
  async (job) => {
    const { componentId, props, fps, width, height, durationInSeconds } = job.data;

    const meta = await getComponent(componentId);
    if (!meta) {
      throw new Error(`Unknown componentId "${componentId}"`);
    }

    await fs.mkdir(config.storageDir, { recursive: true });
    const fileName = `${job.id}.webm`;
    const filePath = path.join(config.storageDir, fileName);

    await job.updateProgress(5);
    const { stdout } = await runRenderScript({
      componentId,
      props,
      out: filePath,
      fps,
      width,
      height,
    });
    await job.updateProgress(95);

    const stat = await fs.stat(filePath);
    if (stat.size === 0) {
      throw new Error(`Render produced an empty file at ${filePath}`);
    }

    await job.updateProgress(100);
    return {
      fileName,
      filePath,
      bytes: stat.size,
      frames: parseFrameCount(stdout),
      durationInSeconds,
    };
  },
  {
    connection: redisConnection,
    concurrency: config.workerConcurrency,
  },
);

worker.on("completed", (job, result) => {
  console.log(`[worker] job ${job.id} done — ${result.fileName} (${result.bytes} bytes)`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed — ${error.message}`);
});

console.log(
  `[worker] listening on queue "${config.queueName}" via redis ${config.redis.host}:${config.redis.port}`,
);
console.log(`[worker] component library: ${config.componentLibraryDir}`);
console.log(`[worker] storage: ${config.storageDir}`);

async function shutdown() {
  await worker.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
