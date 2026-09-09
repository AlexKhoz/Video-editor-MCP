import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { config } from "./config.js";

/**
 * Server-side storage for projects, media files and component metadata.
 *
 * SQLite via `node:sqlite` (Node core, no dependency, no native build). The schema is
 * deliberately thin: a project is stored as a JSON blob rather than a normalised
 * timeline, because the editor already has a stable serialisation format and this stage
 * is about making it available across browsers, not about querying inside it.
 *
 * Swapping to Postgres later means replacing this module: the queries are plain SQL and
 * the exported functions are the only surface the routes use.
 */

let db = null;

export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media (
      id            TEXT PRIMARY KEY,
      filename      TEXT NOT NULL,
      storage_path  TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS component_metadata (
      media_id         TEXT PRIMARY KEY,
      component_id     TEXT NOT NULL,
      props            TEXT NOT NULL,
      background       TEXT,
      rendered_file_id TEXT,
      updated_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
  `);

  // Added after the table shipped, so tolerate an existing column.
  try {
    db.exec("ALTER TABLE media ADD COLUMN metadata TEXT");
  } catch {
    // already present
  }
  // The editor's MediaItem.type ("video" | "audio" | "image"). Kept out of the metadata
  // blob because that blob is handed to the editor verbatim as MediaMetadata.
  try {
    db.exec("ALTER TABLE media ADD COLUMN media_type TEXT");
  } catch {
    // already present
  }
  // Free-text organisation, one folder per project. Deliberately nullable with no
  // backfill: NULL means "never categorised" and is presented as DEFAULT_PROJECT_FOLDER,
  // which keeps it distinguishable from a project someone deliberately filed under a
  // folder of that name. Kept as a column rather than inside the project JSON because it
  // describes the stored record, not the composition — see NOTES.md Stage 22.
  try {
    db.exec("ALTER TABLE projects ADD COLUMN folder TEXT");
  } catch {
    // already present
  }

  return db;
}

/** What a project with no folder reports as. Never written to the column. */
export const DEFAULT_PROJECT_FOLDER = "Uncategorized";

/* ---------------------------------------------------------------- projects */

/**
 * Saved projects, newest first. `folder` filters to one folder; asking for the default
 * folder also returns the rows that have never been categorised, since those are the same
 * thing as far as a caller is concerned.
 */
export function listProjects({ folder } = {}) {
  const base =
    "SELECT id, name, folder, created_at, updated_at FROM projects";
  const order = " ORDER BY updated_at DESC";

  let rows;
  if (folder === undefined || folder === null) {
    rows = getDb().prepare(base + order).all();
  } else if (folder === DEFAULT_PROJECT_FOLDER) {
    rows = getDb()
      .prepare(`${base} WHERE folder IS NULL OR folder = ?${order}`)
      .all(folder);
  } else {
    rows = getDb().prepare(`${base} WHERE folder = ?${order}`).all(folder);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    folder: row.folder ?? DEFAULT_PROJECT_FOLDER,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** The distinct folders in use, so a picker does not have to list every project. */
export function listProjectFolders() {
  const rows = getDb()
    .prepare("SELECT DISTINCT folder FROM projects ORDER BY folder")
    .all();
  const names = new Set(
    rows.map((row) => row.folder ?? DEFAULT_PROJECT_FOLDER),
  );
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function getProject(id) {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    folder: row.folder ?? DEFAULT_PROJECT_FOLDER,
    project: JSON.parse(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert or update a project.
 *
 * `folder` is only written when the caller passes one: `COALESCE(excluded.folder, …)`
 * means an ordinary save — which carries the project JSON but knows nothing about
 * folders — cannot null out a folder someone set. Pass an empty string to clear it back
 * to the default.
 */
export function upsertProject({ id, name, project, folder }) {
  const now = Date.now();
  const data = JSON.stringify(project);
  const setsFolder = folder !== undefined;
  const folderValue = setsFolder ? normaliseFolder(folder) : null;

  // Two statements rather than one with COALESCE: "no folder given" and "clear the folder"
  // both reduce to SQL NULL, so a single statement cannot tell them apart — COALESCE made
  // the explicit clear silently do nothing. They differ only in whether DO UPDATE touches
  // the folder column; both take the same six parameters.
  const SET_FOLDER = `
    INSERT INTO projects (id, name, data, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      folder = excluded.folder,
      updated_at = excluded.updated_at`;
  const KEEP_FOLDER = `
    INSERT INTO projects (id, name, data, folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      updated_at = excluded.updated_at`;

  getDb()
    .prepare(setsFolder ? SET_FOLDER : KEEP_FOLDER)
    .run(id, name, data, folderValue, now, now);
  const saved = { id, name, updatedAt: now, bytes: data.length };
  if (folder !== undefined) saved.folder = folderValue ?? DEFAULT_PROJECT_FOLDER;
  return saved;
}

/**
 * Trims a caller-supplied folder name, mapping blank and the default label to NULL so the
 * column only ever holds a real, deliberate folder.
 */
export function normaliseFolder(folder) {
  if (typeof folder !== "string") return null;
  const trimmed = folder.trim();
  if (trimmed === "" || trimmed === DEFAULT_PROJECT_FOLDER) return null;
  return trimmed;
}

export function deleteProject(id) {
  const result = getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

/** The row's `updated_at`, for optimistic-concurrency checks. `null` when absent. */
export function getProjectUpdatedAt(id) {
  const row = getDb().prepare("SELECT updated_at FROM projects WHERE id = ?").get(id);
  return row ? row.updated_at : null;
}

/**
 * Media ids that no surviving project's JSON mentions.
 *
 * A substring match on the stored JSON is crude but safe in the direction that matters:
 * an id that appears anywhere in any project is treated as still referenced, so this
 * never deletes media that is in use. Worst case it keeps something too long.
 */
export function findOrphanedMedia() {
  const db = getDb();
  const projects = db.prepare("SELECT data FROM projects").all().map((row) => row.data);
  const mediaIds = db.prepare("SELECT id FROM media").all().map((row) => row.id);
  return mediaIds.filter((id) => !projects.some((data) => data.includes(id)));
}

/** Closes the handle, so a test (or a shutdown) can release the file. Reopens on demand. */
export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

/** Raw project JSON blobs, for the substring reference test the sweeps share. */
export function listProjectData() {
  return getDb().prepare("SELECT data FROM projects").all().map((row) => row.data);
}

/** Removes a media row and its component metadata. The file itself is the caller's job. */
export function deleteMediaRow(id) {
  const db = getDb();
  const row = db.prepare("SELECT storage_path FROM media WHERE id = ?").get(id);
  db.prepare("DELETE FROM component_metadata WHERE media_id = ?").run(id);
  const result = db.prepare("DELETE FROM media WHERE id = ?").run(id);
  return result.changes > 0 ? (row?.storage_path ?? null) : null;
}

/* ------------------------------------------------------------------- media */

export function insertMedia({ id, filename, storagePath, mimeType, size, metadata, mediaType }) {
  const now = Date.now();
  const encoded = metadata ? JSON.stringify(metadata) : null;
  getDb()
    .prepare(
      `INSERT INTO media (id, filename, storage_path, mime_type, size, created_at, metadata, media_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         filename = excluded.filename,
         storage_path = excluded.storage_path,
         mime_type = excluded.mime_type,
         size = excluded.size,
         metadata = excluded.metadata,
         media_type = excluded.media_type`,
    )
    .run(id, filename, storagePath, mimeType, size, now, encoded, mediaType ?? null);
  return {
    id, filename, mimeType, size, createdAt: now,
    metadata: metadata ?? null,
    mediaType: mediaType ?? null,
  };
}

export function getMedia(id) {
  const row = getDb().prepare("SELECT * FROM media WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    size: row.size,
    createdAt: row.created_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    mediaType: row.media_type ?? null,
  };
}

export function listMedia(limit = 200) {
  return getDb()
    .prepare("SELECT id, filename, mime_type, size, created_at, metadata, media_type FROM media ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((row) => ({
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      mediaType: row.media_type ?? null,
    }));
}

/* ------------------------------------------------------ component metadata */

/** Replaces Stage 5's localStorage registry (its deferred item #3). */
export function upsertComponentMetadata({ mediaId, componentId, props, background, renderedFileId }) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO component_metadata (media_id, component_id, props, background, rendered_file_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_id) DO UPDATE SET
         component_id = excluded.component_id,
         props = excluded.props,
         background = excluded.background,
         rendered_file_id = excluded.rendered_file_id,
         updated_at = excluded.updated_at`,
    )
    .run(mediaId, componentId, JSON.stringify(props ?? {}), background ?? null, renderedFileId ?? null, now);
  return { mediaId, updatedAt: now };
}

function rowToComponentMetadata(row) {
  return {
    mediaId: row.media_id,
    componentId: row.component_id,
    props: JSON.parse(row.props),
    background: row.background,
    renderedFileId: row.rendered_file_id,
    updatedAt: row.updated_at,
  };
}

export function getComponentMetadata(mediaId) {
  const row = getDb().prepare("SELECT * FROM component_metadata WHERE media_id = ?").get(mediaId);
  return row ? rowToComponentMetadata(row) : null;
}

export function listComponentMetadata() {
  return getDb()
    .prepare("SELECT * FROM component_metadata ORDER BY updated_at DESC")
    .all()
    .map(rowToComponentMetadata);
}
