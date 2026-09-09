/**
 * Folder organisation at the storage layer, against a throwaway SQLite file.
 *
 * config.js reads its paths from the environment at import time, so the env is set before
 * anything is imported and nothing here can touch the real storage/ tree. Needs no Redis,
 * no ffmpeg and no server.
 *
 * The column is nullable with no backfill: NULL means "never categorised" and is reported
 * as DEFAULT_PROJECT_FOLDER. That keeps it distinguishable from a project deliberately
 * filed under a folder of that name, and it is why several of these tests are about NULL
 * rather than about strings.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";

let db;
let root;

/** A minimal but structurally valid project blob. */
function project(id, name) {
  return {
    id,
    name,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { tracks: [], subtitles: [], duration: 0, markers: [] },
  };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "folders-test-"));
  process.env.DB_PATH = path.join(root, "test.sqlite");
  process.env.MEDIA_DIR = path.join(root, "media");
  process.env.RENDER_STORAGE_DIR = path.join(root, "rendered");
  process.env.EXPORT_DIR = path.join(root, "exports");
  db = await import("../src/db.js");
});

after(async () => {
  // SQLite keeps the file open, and Windows will not unlink it while it is.
  db?.closeDb();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("a project saved without a folder reports the default", () => {
  db.upsertProject({ id: "p-none", name: "No folder", project: project("p-none", "No folder") });

  const listed = db.listProjects().find((row) => row.id === "p-none");
  assert.equal(listed.folder, db.DEFAULT_PROJECT_FOLDER);
  assert.equal(db.getProject("p-none").folder, db.DEFAULT_PROJECT_FOLDER);
});

test("an explicit folder round-trips through list and single-project reads", () => {
  db.upsertProject({
    id: "p-client",
    name: "Client work",
    project: project("p-client", "Client work"),
    folder: "Acme Q4",
  });

  assert.equal(db.listProjects().find((row) => row.id === "p-client").folder, "Acme Q4");
  assert.equal(db.getProject("p-client").folder, "Acme Q4");
});

test("the column stores NULL rather than the default label", () => {
  // Asserted directly, because the whole design rests on it: a backfilled literal would
  // make "never categorised" and "deliberately called Uncategorized" indistinguishable.
  const raw = db
    .getDb()
    .prepare("SELECT folder FROM projects WHERE id = ?")
    .get("p-none");
  assert.equal(raw.folder, null);
});

test("blank and default-label folders normalise to NULL", () => {
  for (const [id, folder] of [
    ["p-blank", ""],
    ["p-spaces", "   "],
    ["p-default", "Uncategorized"],
    ["p-nonstring", 42],
  ]) {
    db.upsertProject({ id, name: id, project: project(id, id), folder });
    assert.equal(
      db.getDb().prepare("SELECT folder FROM projects WHERE id = ?").get(id).folder,
      null,
      `${JSON.stringify(folder)} should not be stored`,
    );
    assert.equal(db.getProject(id).folder, db.DEFAULT_PROJECT_FOLDER);
  }
});

test("a folder name is trimmed before storage", () => {
  db.upsertProject({
    id: "p-trim",
    name: "Trim",
    project: project("p-trim", "Trim"),
    folder: "  Spaced Out  ",
  });
  assert.equal(db.getProject("p-trim").folder, "Spaced Out");
});

test("filtering returns only that folder", () => {
  db.upsertProject({ id: "p-a1", name: "a1", project: project("p-a1", "a1"), folder: "Alpha" });
  db.upsertProject({ id: "p-a2", name: "a2", project: project("p-a2", "a2"), folder: "Alpha" });
  db.upsertProject({ id: "p-b1", name: "b1", project: project("p-b1", "b1"), folder: "Beta" });

  const alpha = db.listProjects({ folder: "Alpha" }).map((row) => row.id).sort();
  assert.deepEqual(alpha, ["p-a1", "p-a2"]);
  assert.deepEqual(db.listProjects({ folder: "Beta" }).map((row) => row.id), ["p-b1"]);
  assert.deepEqual(db.listProjects({ folder: "Nope" }), []);
});

test("filtering by the default folder also returns the uncategorised rows", () => {
  // The case most likely to be got wrong silently: those rows hold NULL, not the label.
  const ids = db.listProjects({ folder: db.DEFAULT_PROJECT_FOLDER }).map((row) => row.id);
  for (const expected of ["p-none", "p-blank", "p-spaces", "p-default", "p-nonstring"]) {
    assert.ok(ids.includes(expected), `${expected} should be in the default folder`);
  }
  for (const notExpected of ["p-a1", "p-b1"]) {
    assert.ok(!ids.includes(notExpected), `${notExpected} is in a real folder`);
  }
});

test("the folder list is distinct, sorted, and includes the default when in use", () => {
  const folders = db.listProjectFolders();
  assert.deepEqual(folders, ["Acme Q4", "Alpha", "Beta", "Spaced Out", "Uncategorized"]);
});

test("a save that omits folder does not clear the stored one", () => {
  // The editor's ordinary save carries the project JSON and knows nothing about folders;
  // it must not reset a folder someone set.
  db.upsertProject({
    id: "p-keep",
    name: "Keep",
    project: project("p-keep", "Keep"),
    folder: "Retained",
  });
  db.upsertProject({ id: "p-keep", name: "Keep renamed", project: project("p-keep", "Keep renamed") });

  const record = db.getProject("p-keep");
  assert.equal(record.folder, "Retained");
  assert.equal(record.name, "Keep renamed");
});

test("a folder can be set on a project that was saved without one", () => {
  // Only DO UPDATE differs between the two statements, so a fresh INSERT always carries
  // its folder — this is the update path, which is what re-filing an existing project uses.
  db.upsertProject({ id: "p-refile", name: "Refile", project: project("p-refile", "Refile") });
  assert.equal(db.getProject("p-refile").folder, db.DEFAULT_PROJECT_FOLDER);

  db.upsertProject({
    id: "p-refile",
    name: "Refile",
    project: project("p-refile", "Refile"),
    folder: "Moved Here",
  });
  assert.equal(db.getProject("p-refile").folder, "Moved Here");
});

test("a folder can be changed from one to another", () => {
  db.upsertProject({
    id: "p-refile",
    name: "Refile",
    project: project("p-refile", "Refile"),
    folder: "Moved Again",
  });
  assert.equal(db.getProject("p-refile").folder, "Moved Again");
});

test("an explicit empty folder clears it back to the default", () => {
  db.upsertProject({
    id: "p-clear",
    name: "Clear",
    project: project("p-clear", "Clear"),
    folder: "Temporary",
  });
  assert.equal(db.getProject("p-clear").folder, "Temporary");

  db.upsertProject({ id: "p-clear", name: "Clear", project: project("p-clear", "Clear"), folder: "" });
  assert.equal(db.getProject("p-clear").folder, db.DEFAULT_PROJECT_FOLDER);
});

test("upsert echoes the folder only when the caller supplied one", () => {
  const withFolder = db.upsertProject({
    id: "p-echo",
    name: "Echo",
    project: project("p-echo", "Echo"),
    folder: "Echoed",
  });
  assert.equal(withFolder.folder, "Echoed");

  const without = db.upsertProject({ id: "p-echo", name: "Echo", project: project("p-echo", "Echo") });
  assert.equal("folder" in without, false, "an ordinary save should not claim to have set a folder");
});
