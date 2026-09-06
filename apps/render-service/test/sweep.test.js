/**
 * Storage housekeeping, against throwaway directories and a throwaway SQLite file.
 *
 * config.js reads its paths from the environment at import time, so the env is set before
 * anything is imported and every path points inside a temp dir. Nothing here can touch the
 * real storage/ tree. Needs no Redis, no ffmpeg, no server.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";

let dirs;
let sweep;
let db;

/** Writes a file and backdates it, so age-based rules can be exercised without waiting. */
async function writeAged(filePath, contents, ageMinutes) {
  await fs.writeFile(filePath, contents);
  const when = new Date(Date.now() - ageMinutes * 60_000);
  await fs.utimes(filePath, when, when);
}

before(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sweep-test-"));
  dirs = {
    root,
    rendered: path.join(root, "rendered"),
    exports: path.join(root, "exports"),
    media: path.join(root, "media"),
  };
  await fs.mkdir(dirs.rendered, { recursive: true });
  await fs.mkdir(dirs.exports, { recursive: true });
  await fs.mkdir(dirs.media, { recursive: true });

  process.env.RENDER_STORAGE_DIR = dirs.rendered;
  process.env.EXPORT_DIR = dirs.exports;
  process.env.MEDIA_DIR = dirs.media;
  process.env.DB_PATH = path.join(root, "test.sqlite");

  sweep = await import("../src/sweep.js");
  db = await import("../src/db.js");
});

after(async () => {
  // SQLite keeps the file open, and Windows will not unlink it while it is.
  db?.closeDb();
  if (dirs) await fs.rm(dirs.root, { recursive: true, force: true });
});

test("rendered: keeps referenced files, removes unreferenced ones past the grace period", async () => {
  // Referenced by a component_metadata row.
  await writeAged(path.join(dirs.rendered, "keep-by-metadata.webm"), "a", 120);
  // Referenced from inside a saved project (a clip's renderedFileId).
  await writeAged(path.join(dirs.rendered, "keep-by-project.webm"), "b", 120);
  // Unreferenced, but too fresh to touch.
  await writeAged(path.join(dirs.rendered, "too-fresh.webm"), "c", 5);
  // Unreferenced and old.
  await writeAged(path.join(dirs.rendered, "orphan.webm"), "d", 120);

  db.upsertComponentMetadata({
    mediaId: "media-x",
    componentId: "lower-third",
    props: {},
    background: null,
    renderedFileId: "keep-by-metadata.webm",
  });
  db.upsertProject({
    id: "project-1",
    name: "Refs",
    project: {
      id: "project-1",
      timeline: { tracks: [{ clips: [{ metadata: { renderedFileId: "keep-by-project.webm" } }] }] },
    },
  });

  const { removed } = await sweep.sweepRenderedFiles({ minAgeMinutes: 60 });
  assert.deepEqual(removed, ["orphan.webm"]);

  const left = (await fs.readdir(dirs.rendered)).sort();
  assert.deepEqual(left, ["keep-by-metadata.webm", "keep-by-project.webm", "too-fresh.webm"]);
});

test("exports: keeps the newest N and anything inside the age limit", async () => {
  for (const [index, ageHours] of [200, 150, 100, 50, 1].entries()) {
    await writeAged(path.join(dirs.exports, `export-${index}.mp4`), "x".repeat(10), ageHours * 60);
  }

  // Keep the 2 newest; of the rest, keep anything younger than 120h.
  const { removed } = await sweep.sweepExports({ keep: 2, maxAgeHours: 120 });
  // Newest two are export-4 (1h) and export-3 (50h). Of the remainder, export-2 (100h) is
  // inside the age limit; export-1 (150h) and export-0 (200h) are not.
  assert.deepEqual(removed.sort(), ["export-0.mp4", "export-1.mp4"]);
  assert.ok((await fs.readdir(dirs.exports)).includes("export-2.mp4"), "age limit should protect it");
});

test("dryRun reports without deleting", async () => {
  await writeAged(path.join(dirs.rendered, "dry-orphan.webm"), "e", 120);

  const report = await sweep.sweepAll({ dryRun: true, rendered: { minAgeMinutes: 60 } });
  assert.ok(report.dryRun);
  assert.ok(report.renderedRemoved.includes("dry-orphan.webm"));
  assert.ok(
    (await fs.readdir(dirs.rendered)).includes("dry-orphan.webm"),
    "dryRun must leave the file on disk",
  );
});

test("sweepAll reports bytes freed", async () => {
  const report = await sweep.sweepAll({ rendered: { minAgeMinutes: 60 } });
  assert.ok(report.renderedRemoved.includes("dry-orphan.webm"));
  assert.equal(report.totalBytesFreed, report.renderedBytesFreed + report.exportsBytesFreed);
  assert.ok(report.totalBytesFreed > 0);
});
