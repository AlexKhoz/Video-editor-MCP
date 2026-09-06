/**
 * probeMedia's classification, against real files produced by ffmpeg.
 *
 * Needs ffmpeg and ffprobe on PATH; nothing else (no Redis, no server).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { probeMedia } from "../src/probe.js";

const execFileAsync = promisify(execFile);

let dir;
const files = {};

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-test-"));
  files.png = path.join(dir, "still.png");
  files.video = path.join(dir, "clip.mp4");
  files.audio = path.join(dir, "tone.m4a");
  files.gif = path.join(dir, "animated.gif");

  await execFileAsync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=red:s=640x360", "-frames:v", "1", files.png]);
  await execFileAsync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", "1", "-pix_fmt", "yuv420p", files.video]);
  await execFileAsync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-ac", "2", files.audio]);
  await execFileAsync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10", "-t", "1", files.gif]);
});

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test("a still image is typed image, with no duration and no video track", async () => {
  const { mediaType, metadata } = await probeMedia(files.png);
  assert.equal(mediaType, "image");
  // 0 means "no inherent length", matching the browser's extractImageMetadata.
  assert.equal(metadata.duration, 0);
  assert.equal(metadata.hasVideo, false);
  assert.equal(metadata.hasAudio, false);
  assert.equal(metadata.width, 640);
  assert.equal(metadata.height, 360);
  assert.ok(metadata.fileSize > 0);
});

test("a video is typed video and keeps its duration", async () => {
  const { mediaType, metadata } = await probeMedia(files.video);
  assert.equal(mediaType, "video");
  assert.equal(metadata.hasVideo, true);
  assert.ok(metadata.duration > 0.9 && metadata.duration < 1.2, `duration was ${metadata.duration}`);
  assert.equal(metadata.width, 320);
  assert.ok(metadata.frameRate > 0);
});

test("an audio-only file is typed audio", async () => {
  const { mediaType, metadata } = await probeMedia(files.audio);
  assert.equal(mediaType, "audio");
  assert.equal(metadata.hasVideo, false);
  assert.equal(metadata.hasAudio, true);
  assert.equal(metadata.sampleRate, 48000);
  assert.equal(metadata.channels, 2);
});

test("an animated gif is video, not a still", async () => {
  const { mediaType, metadata } = await probeMedia(files.gif);
  assert.equal(mediaType, "video");
  assert.ok(metadata.duration > 0, "animated gif should keep its duration");
});
