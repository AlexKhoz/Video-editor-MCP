import fs from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import {
  deleteMediaRow,
  findOrphanedMedia,
  listComponentMetadata,
  listProjectData,
} from "./db.js";

/**
 * Disk housekeeping for the three storage directories.
 *
 * Each sweep is deliberately conservative in a different way, because the three directories
 * have different truths about what "still needed" means:
 *
 *   media/     - a row is orphaned when no saved project mentions its id (Stage 9's rule).
 *   rendered/  - a component render is finished work that may not have been collected yet,
 *                so a file is only removable once nothing references it AND it has sat
 *                there past a grace period.
 *   exports/   - nothing ever references an export; it is output. Pure retention: keep the
 *                newest N and anything younger than the age limit.
 *
 * Every sweep supports dryRun, because the first question about a delete-things job is
 * always "what would it have deleted".
 */

/** Deletes media (row, file and component metadata) that no surviving project references. */
export async function sweepOrphanedMedia({ dryRun = false } = {}) {
  const removed = [];
  for (const id of findOrphanedMedia()) {
    if (dryRun) {
      removed.push(id);
      continue;
    }
    const storagePath = deleteMediaRow(id);
    if (storagePath) await fs.rm(storagePath, { force: true });
    removed.push(id);
  }
  return removed;
}

async function statFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) entries.push({ name, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Raced with something else deleting it; nothing to do.
    }
  }
  return entries;
}

/**
 * Removes rendered component files nothing points at any more.
 *
 * "Points at" means either a component_metadata row's renderedFileId or a mention anywhere
 * in a saved project's JSON — clips carry renderedFileId in their metadata so the panel can
 * re-render them, and that reference must outlive this sweep.
 *
 * The grace period protects the gap between a render finishing and the client downloading
 * it: a file younger than `minAgeMinutes` is never touched, however unreferenced it looks.
 */
export async function sweepRenderedFiles({ minAgeMinutes = 60, dryRun = false } = {}) {
  const referenced = new Set();
  for (const entry of listComponentMetadata()) {
    if (entry.renderedFileId) referenced.add(String(entry.renderedFileId));
  }
  const projectBlobs = listProjectData();

  const cutoff = Date.now() - minAgeMinutes * 60_000;
  const removed = [];
  let bytes = 0;

  for (const file of await statFiles(config.storageDir)) {
    if (file.name.startsWith(".")) continue;
    if (file.mtimeMs > cutoff) continue;
    if (referenced.has(file.name)) continue;
    // Same substring test Stage 9 uses for media: crude, but it cannot miss a reference,
    // which is the direction that matters when the alternative is deleting live data.
    if (projectBlobs.some((data) => data.includes(file.name))) continue;

    if (!dryRun) await fs.rm(file.path, { force: true });
    removed.push(file.name);
    bytes += file.size;
  }

  return { removed, bytes };
}

/**
 * Retention for finished exports: keep the newest `keep` files, plus anything younger than
 * `maxAgeHours`, and delete the rest.
 */
export async function sweepExports({ keep = 10, maxAgeHours = 24 * 7, dryRun = false } = {}) {
  const files = (await statFiles(config.exportDir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = Date.now() - maxAgeHours * 3_600_000;

  const removed = [];
  let bytes = 0;

  for (const [index, file] of files.entries()) {
    if (index < keep) continue;
    if (file.mtimeMs > cutoff) continue;

    if (!dryRun) await fs.rm(file.path, { force: true });
    removed.push(file.name);
    bytes += file.size;
  }

  return { removed, bytes };
}

/** All three, in one report. */
export async function sweepAll(options = {}) {
  const { dryRun = false, rendered = {}, exports: exportOptions = {} } = options;

  const media = await sweepOrphanedMedia({ dryRun });
  const renderedResult = await sweepRenderedFiles({ ...rendered, dryRun });
  const exportsResult = await sweepExports({ ...exportOptions, dryRun });

  return {
    dryRun,
    orphanedMediaRemoved: media,
    renderedRemoved: renderedResult.removed,
    renderedBytesFreed: renderedResult.bytes,
    exportsRemoved: exportsResult.removed,
    exportsBytesFreed: exportsResult.bytes,
    totalBytesFreed: renderedResult.bytes + exportsResult.bytes,
  };
}
