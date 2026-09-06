import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addClip,
  addMediaItem,
  addTextClip,
  addTrack,
  addTransition,
  applyOps,
  computeTimelineDuration,
  createProject,
  findClip,
  ProjectKitError,
  removeClip,
  setEffect,
  splitClip,
  trimClip,
} from "../src/index.js";

/** ProjectKitError carries the code on `.code`, not in the message. */
function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ProjectKitError, `expected ProjectKitError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

const MEDIA = {
  id: "media-1",
  name: "footage.mp4",
  metadata: { duration: 6, width: 1920, height: 1080, frameRate: 30, codec: "h264", hasVideo: true, hasAudio: true },
};

function seeded() {
  const project = createProject({ name: "Test" });
  const trackId = project.timeline.tracks[0].id;
  const withMedia = addMediaItem(project, MEDIA).project;
  return { project: withMedia, trackId };
}

test("createProject produces a loadable shape with one track", () => {
  const project = createProject({ name: "Fresh" });
  assert.equal(project.name, "Fresh");
  assert.equal(project.timeline.tracks.length, 1);
  assert.deepEqual(project.textClips, []);
  assert.equal(project.settings.width, 1920);
});

test("operations never mutate the input project", () => {
  const { project, trackId } = seeded();
  const before = JSON.stringify(project);
  addClip(project, { trackId, mediaId: MEDIA.id, startTime: 0, duration: 2 });
  assert.equal(JSON.stringify(project), before);
});

test("addClip defaults duration to the media duration and sets outPoint", () => {
  const { project, trackId } = seeded();
  const { project: next, clipId } = addClip(project, { trackId, mediaId: MEDIA.id });
  const { clip } = findClip(next, clipId);
  assert.equal(clip.duration, 6);
  assert.equal(clip.outPoint, 6);
  assert.equal(next.timeline.duration, 6);
});

test("addClip rejects an unknown track, unknown media and out-of-source trims", () => {
  const { project, trackId } = seeded();
  expectCode(() => addClip(project, { trackId: "nope", mediaId: MEDIA.id }), "TRACK_NOT_FOUND");
  expectCode(() => addClip(project, { trackId, mediaId: "ghost" }), "MEDIA_NOT_FOUND");
  expectCode(() => addClip(project, { trackId, mediaId: MEDIA.id, inPoint: 5, duration: 3 }), "OUT_OF_SOURCE");
});

test("addClip refuses overlaps unless allowOverlap is set", () => {
  const { project, trackId } = seeded();
  const first = addClip(project, { trackId, mediaId: MEDIA.id, startTime: 0, duration: 3 }).project;
  expectCode(() => addClip(first, { trackId, mediaId: MEDIA.id, startTime: 2, duration: 2 }), "CLIP_OVERLAP");
  const forced = addClip(first, { trackId, mediaId: MEDIA.id, startTime: 2, duration: 2, allowOverlap: true });
  assert.equal(forced.project.timeline.tracks[0].clips.length, 2);
});

test("trimClip keeps outPoint consistent and guards the source length", () => {
  const { project, trackId } = seeded();
  const { project: withClip, clipId } = addClip(project, { trackId, mediaId: MEDIA.id, duration: 6 });
  const trimmed = trimClip(withClip, { clipId, duration: 4 }).project;
  const { clip } = findClip(trimmed, clipId);
  assert.equal(clip.duration, 4);
  assert.equal(clip.outPoint, 4);
  assert.equal(trimmed.timeline.duration, 4);
  expectCode(() => trimClip(withClip, { clipId, inPoint: 3, duration: 5 }), "OUT_OF_SOURCE");
});

test("splitClip divides in/out points at the split time", () => {
  const { project, trackId } = seeded();
  const { project: withClip, clipId } = addClip(project, { trackId, mediaId: MEDIA.id, startTime: 0, duration: 6 });
  const { project: split, newClipId } = splitClip(withClip, { clipId, time: 2 });
  const a = findClip(split, clipId).clip;
  const b = findClip(split, newClipId).clip;
  assert.equal(a.duration, 2);
  assert.equal(a.outPoint, 2);
  assert.equal(b.startTime, 2);
  assert.equal(b.duration, 4);
  assert.equal(b.inPoint, 2);
  expectCode(() => splitClip(withClip, { clipId, time: 0 }), "INVALID_PARAMS");
});

test("setEffect replaces by type and removeClip drops related transitions", () => {
  const { project, trackId } = seeded();
  const { project: p1, clipId } = addClip(project, { trackId, mediaId: MEDIA.id, duration: 2 });
  const p2 = setEffect(p1, { clipId, type: "chromaKey" }).project;
  const p3 = setEffect(p2, { clipId, type: "chromaKey", params: { tolerance: 0.4 } }).project;
  const effects = findClip(p3, clipId).clip.effects;
  assert.equal(effects.length, 1, "same type replaced rather than duplicated");
  assert.equal(effects[0].params.tolerance, 0.4);

  const second = addClip(p3, { trackId, mediaId: MEDIA.id, startTime: 2, duration: 2 });
  const withTransition = addTransition(second.project, {
    clipAId: clipId, clipBId: second.clipId, type: "crossfade", duration: 0.5,
  }).project;
  assert.equal(withTransition.timeline.tracks[0].transitions.length, 1);
  const pruned = removeClip(withTransition, { clipId }).project;
  assert.equal(pruned.timeline.tracks[0].transitions.length, 0);
});

test("addTransition validates the type and accepts empty params", () => {
  const { project, trackId } = seeded();
  const { project: p1, clipId } = addClip(project, { trackId, mediaId: MEDIA.id, duration: 2 });
  expectCode(() => addTransition(p1, { clipAId: clipId, type: "teleport" }), "INVALID_PARAMS");
  const ok = addTransition(p1, { clipAId: clipId, type: "flash", duration: 0.4 }).project;
  assert.deepEqual(ok.timeline.tracks[0].transitions[0].params, {});
});

test("addTextClip writes to the top-level textClips array and extends duration", () => {
  const { project, trackId } = seeded();
  const { project: next, textClipId } = addTextClip(project, {
    trackId, text: "Hello", startTime: 1, duration: 3,
  });
  assert.equal(next.textClips.length, 1);
  assert.equal(next.textClips[0].id, textClipId);
  assert.equal(next.textClips[0].style.fontSize, 96, "defaults filled in");
  assert.equal(computeTimelineDuration(next), 4);
  assert.equal(next.timeline.tracks[0].clips.length, 0, "text clips are not track clips");
});

test("applyOps chains ids and is atomic on failure", () => {
  const project = createProject({ name: "Chained" });
  const trackId = project.timeline.tracks[0].id;
  const { project: next, results } = applyOps(project, [
    { op: "add_media", ...MEDIA },
    { op: "add_clip", trackId, mediaId: MEDIA.id, startTime: 0, duration: 4 },
    { op: "add_text_clip", trackId, text: "Chained", startTime: 1, duration: 2 },
  ]);
  assert.equal(results.length, 3);
  assert.ok(results[1].clipId);
  assert.equal(next.timeline.duration, 4);

  const before = JSON.stringify(next);
  assert.throws(
    () => applyOps(next, [
      { op: "add_track", name: "Video 2" },
      { op: "add_clip", trackId: "missing", mediaId: MEDIA.id },
    ]),
    (error) => error instanceof ProjectKitError && /ops\[1\]/.test(error.message),
  );
  assert.equal(JSON.stringify(next), before, "failed batch left the input untouched");
});

test("locked tracks reject writes", () => {
  const { project, trackId } = seeded();
  const locked = structuredClone(project);
  locked.timeline.tracks[0].locked = true;
  expectCode(() => addClip(locked, { trackId, mediaId: MEDIA.id }), "TRACK_LOCKED");
});

test("addTrack appends and names sequentially", () => {
  const project = createProject({ name: "Tracks" });
  const { project: next, trackId } = addTrack(project, {});
  assert.equal(next.timeline.tracks.length, 2);
  assert.equal(next.timeline.tracks[1].id, trackId);
  assert.equal(next.timeline.tracks[1].name, "Video 2");
});

/* ----------------------------------------------- media type inference (Stage 12) */

const STILL = {
  id: "still-1",
  name: "background.png",
  // What probeMedia returns for a PNG: pixels, no length, no tracks.
  metadata: { duration: 0, width: 1920, height: 1080, frameRate: 0, codec: "", hasVideo: false, hasAudio: false },
};

test("a still image is typed image, not video", () => {
  const project = addMediaItem(createProject({ name: "Stills" }), STILL).project;
  const item = project.mediaLibrary.items.find((entry) => entry.id === "still-1");
  assert.equal(item.type, "image");
});

test("an audio-only file is typed audio", () => {
  const project = addMediaItem(createProject({ name: "Audio" }), {
    id: "audio-1",
    name: "voice.m4a",
    metadata: { duration: 12, width: 0, height: 0, frameRate: 0, codec: "aac", hasVideo: false, hasAudio: true },
  }).project;
  assert.equal(project.mediaLibrary.items[0].type, "audio");
});

test("an explicit type still wins over inference", () => {
  const project = addMediaItem(createProject({ name: "Override" }), { ...STILL, type: "video" }).project;
  assert.equal(project.mediaLibrary.items[0].type, "video");
});

test("metadata with no track flags but a duration stays video", () => {
  const project = addMediaItem(createProject({ name: "Legacy" }), {
    id: "legacy-1",
    name: "clip.mp4",
    metadata: { duration: 4, width: 1280, height: 720 },
  }).project;
  assert.equal(project.mediaLibrary.items[0].type, "video");
});

test("a still image clip defaults to 5 seconds and accepts an explicit one", () => {
  const seed = addMediaItem(createProject({ name: "Stills" }), STILL).project;
  const trackId = seed.timeline.tracks[0].id;

  const defaulted = addClip(seed, { trackId, mediaId: "still-1", startTime: 0 });
  assert.equal(findClip(defaulted.project, defaulted.clipId).clip.duration, 5);

  const explicit = addClip(seed, { trackId, mediaId: "still-1", startTime: 0, duration: 12 });
  assert.equal(findClip(explicit.project, explicit.clipId).clip.duration, 12);
});
