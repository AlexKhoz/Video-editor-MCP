import { randomUUID } from "node:crypto";

/**
 * Pure JSON operations over an OpenReel project.
 *
 * Every function takes a project and returns a *new* project — nothing mutates in place —
 * so an operation list can be applied atomically and thrown away on the first error.
 *
 * Why this is safe without going through the editor's Zustand store (verified in Stage 10):
 *   - `loadProject` recomputes `timeline.duration`, so callers need not get it exactly right
 *     (we still keep it correct here).
 *   - The store's other side-effects are media probing (replaced by ffprobe server-side),
 *     thumbnails and waveforms (cosmetic), and IndexedDB caching (irrelevant server-side).
 *   - What the store *does* enforce is validation, which is ported below from
 *     `packages/core/src/actions/action-validator.ts`.
 *
 * Structural rules that are easy to get wrong and are enforced here:
 *   - text/shape/SVG/sticker clips live in TOP-LEVEL arrays (`textClips[]` …), not inside
 *     tracks, because the editor hands them to the title/graphics engines on load.
 *   - a transition lives on the track that owns its `clipAId`.
 */

/** Transition types the render engine implements (packages/core/src/types/effects.ts). */
export const TRANSITION_TYPES = [
  "crossfade", "dipToBlack", "dipToWhite", "wipe", "slide", "zoom", "push",
  "circleReveal", "blur", "whipPan", "radialWipe", "pixelate", "glitch", "blinds",
  "diamondReveal", "spin", "flip", "splitReveal", "flash", "filmBurn", "mosaic",
  "ripple", "pageTurn", "colorSplit",
];

export const DEFAULT_CLIP_DURATION = 5;

const DEFAULT_TRANSFORM = {
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
  fitMode: "contain",
};

const DEFAULT_TEXT_STYLE = {
  fontFamily: "Inter",
  fontSize: 96,
  fontWeight: 700,
  fontStyle: "normal",
  color: "#ffffff",
  strokeColor: "#111827",
  strokeWidth: 2,
  textAlign: "center",
  verticalAlign: "middle",
  lineHeight: 1.2,
  letterSpacing: 0,
};

export class ProjectKitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProjectKitError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProjectKitError(code, message);
}

const clone = (value) => structuredClone(value);

/* ------------------------------------------------------------------ lookup */

export function findTrack(project, trackId) {
  return project.timeline.tracks.find((track) => track.id === trackId) ?? null;
}

export function findClip(project, clipId) {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

export function findMedia(project, mediaId) {
  return project.mediaLibrary.items.find((item) => item.id === mediaId) ?? null;
}

/* -------------------------------------------------------------- validation */

function requireTrack(project, trackId, { forWrite = true } = {}) {
  if (typeof trackId !== "string" || !trackId) {
    fail("INVALID_PARAMS", "trackId is required and must be a string");
  }
  const track = findTrack(project, trackId);
  if (!track) fail("TRACK_NOT_FOUND", `Track ${trackId} not found`);
  if (forWrite && track.locked) fail("TRACK_LOCKED", `Track ${track.name} is locked`);
  return track;
}

function requireClip(project, clipId) {
  if (typeof clipId !== "string" || !clipId) {
    fail("INVALID_PARAMS", "clipId is required and must be a string");
  }
  const found = findClip(project, clipId);
  if (!found) fail("CLIP_NOT_FOUND", `Clip ${clipId} not found`);
  if (found.track.locked) fail("TRACK_LOCKED", `Track ${found.track.name} is locked`);
  return found;
}

function requireFiniteNumber(value, name, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail("INVALID_PARAMS", `${name} must be a finite number`);
  if (number < min) fail("INVALID_PARAMS", `${name} must be >= ${min}`);
  return number;
}

/** Overlap check on one track, ignoring a clip being moved/resized. */
function assertNoOverlap(track, startTime, duration, ignoreClipId) {
  const end = startTime + duration;
  for (const clip of track.clips) {
    if (clip.id === ignoreClipId) continue;
    const clipEnd = clip.startTime + clip.duration;
    if (startTime < clipEnd && clip.startTime < end) {
      fail(
        "CLIP_OVERLAP",
        `Clip would overlap "${clip.id}" (${clip.startTime.toFixed(2)}–${clipEnd.toFixed(2)}s) on track ${track.name}`,
      );
    }
  }
}

/* ------------------------------------------------------------- derivations */

export function computeTimelineDuration(project) {
  let end = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.startTime + clip.duration);
  }
  for (const key of ["textClips", "shapeClips", "svgClips", "stickerClips"]) {
    for (const item of project[key] ?? []) end = Math.max(end, item.startTime + item.duration);
  }
  for (const subtitle of project.timeline.subtitles ?? []) {
    end = Math.max(end, subtitle.endTime ?? 0);
  }
  return end;
}

function finish(project) {
  const next = project;
  next.timeline.duration = computeTimelineDuration(next);
  next.modifiedAt = Date.now();
  return next;
}

/* ---------------------------------------------------------------- creation */

export function createProject({ name = "Untitled", width = 1920, height = 1080, frameRate = 30, id } = {}) {
  const now = Date.now();
  const project = {
    id: id ?? randomUUID(),
    name,
    createdAt: now,
    modifiedAt: now,
    settings: { width, height, frameRate, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { tracks: [], subtitles: [], duration: 0, markers: [] },
    motionCompositions: [],
    motionInstances: [],
    capabilities: ["universal-tracks-v1"],
    minimumReaderVersion: "1.2.0",
    textClips: [],
    shapeClips: [],
    svgClips: [],
    stickerClips: [],
    generatedShaders: [],
  };
  // addTrack returns { project, trackId }; callers of createProject want the project.
  return addTrack(project, { name: "Video 1" }).project;
}

/* -------------------------------------------------------------- operations */

export function addTrack(project, { name, type = "video" } = {}) {
  const next = clone(project);
  const track = {
    id: `track-${randomUUID()}`,
    type,
    name: name ?? `Video ${next.timeline.tracks.length + 1}`,
    clips: [],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
  next.timeline.tracks.push(track);
  return { project: finish(next), trackId: track.id };
}

/**
 * The editor branches on MediaItem.type all through the render path, so getting it wrong is
 * not cosmetic: a still image typed as "video" makes the export engine open a video track
 * that does not exist ("Video load failed"). Infer it from the probe's own flags rather than
 * assuming video, and let an explicit type win.
 */
function inferMediaType(metadata) {
  if (metadata.hasVideo) return "video";
  if (metadata.hasAudio) return "audio";
  // Neither flag set: only call it a still when it has pixels but no length, so metadata
  // that simply omits the flags still lands on "video" as it did before.
  if ((metadata.duration ?? 0) > 0) return "video";
  if ((metadata.width ?? 0) > 0 && (metadata.height ?? 0) > 0) return "image";
  return "video";
}

/**
 * Registers media in the library. `metadata` must be supplied by the caller — server-side
 * that means ffprobe, which yields the same fields the browser's importMedia probes.
 */
export function addMediaItem(project, { id, name, type, metadata, sourceFile }) {
  if (typeof id !== "string" || !id) fail("INVALID_PARAMS", "media id is required");
  if (findMedia(project, id)) fail("DUPLICATE_MEDIA", `Media ${id} is already in the library`);
  if (!metadata || typeof metadata !== "object") {
    fail("INVALID_PARAMS", "media metadata is required (duration, width, height, …)");
  }
  const next = clone(project);
  next.mediaLibrary.items.push({
    id,
    name: name ?? id,
    type: type ?? inferMediaType(metadata),
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 0, width: 0, height: 0, frameRate: 0, codec: "",
      sampleRate: 0, channels: 0, fileSize: 0, hasVideo: true, hasAudio: false,
      ...metadata,
    },
    thumbnailUrl: null,
    waveformData: null,
    sourceFile: sourceFile ?? null,
    isPlaceholder: false,
  });
  return { project: finish(next), mediaId: id };
}

export function addClip(project, {
  trackId, mediaId, startTime = 0, duration, inPoint = 0, metadata, effects = [], allowOverlap = false,
}) {
  const track = requireTrack(project, trackId);
  const media = findMedia(project, mediaId);
  if (!media) fail("MEDIA_NOT_FOUND", `Media ${mediaId} is not in the library`);

  const start = requireFiniteNumber(startTime, "startTime");
  const inP = requireFiniteNumber(inPoint, "inPoint");
  // Mirrors the store: explicit duration, else the media's, else a 5s default (images).
  const dur = requireFiniteNumber(
    duration ?? (media.metadata.duration > 0 ? media.metadata.duration : DEFAULT_CLIP_DURATION),
    "duration",
    { min: 0.001 },
  );
  if (media.metadata.duration > 0 && inP + dur > media.metadata.duration + 0.001) {
    fail(
      "OUT_OF_SOURCE",
      `inPoint+duration (${(inP + dur).toFixed(2)}s) exceeds the media's ${media.metadata.duration.toFixed(2)}s`,
    );
  }
  if (!allowOverlap) assertNoOverlap(track, start, dur, null);

  const next = clone(project);
  const clip = {
    id: randomUUID(),
    mediaId,
    trackId,
    startTime: start,
    duration: dur,
    inPoint: inP,
    outPoint: inP + dur,
    effects: clone(effects),
    audioEffects: [],
    transform: clone(DEFAULT_TRANSFORM),
    volume: 1,
    keyframes: [],
    ...(metadata ? { metadata: clone(metadata) } : {}),
  };
  findTrack(next, trackId).clips.push(clip);
  return { project: finish(next), clipId: clip.id };
}

/** Trim by timeline position and/or source in/out. Keeps outPoint consistent. */
export function trimClip(project, { clipId, startTime, duration, inPoint, allowOverlap = false }) {
  const { track } = requireClip(project, clipId);
  const next = clone(project);
  const target = findClip(next, clipId).clip;

  if (startTime !== undefined) target.startTime = requireFiniteNumber(startTime, "startTime");
  if (inPoint !== undefined) target.inPoint = requireFiniteNumber(inPoint, "inPoint");
  if (duration !== undefined) target.duration = requireFiniteNumber(duration, "duration", { min: 0.001 });
  target.outPoint = target.inPoint + target.duration;

  const media = findMedia(next, target.mediaId);
  if (media && media.metadata.duration > 0 && target.outPoint > media.metadata.duration + 0.001) {
    fail(
      "OUT_OF_SOURCE",
      `outPoint ${target.outPoint.toFixed(2)}s exceeds the media's ${media.metadata.duration.toFixed(2)}s`,
    );
  }
  if (!allowOverlap) {
    assertNoOverlap(findTrack(next, track.id), target.startTime, target.duration, clipId);
  }
  return { project: finish(next), clipId };
}

export function moveClip(project, { clipId, trackId, startTime, allowOverlap = false }) {
  const found = requireClip(project, clipId);
  const destinationId = trackId ?? found.track.id;
  const destination = requireTrack(project, destinationId);

  const next = clone(project);
  const source = findTrack(next, found.track.id);
  const index = source.clips.findIndex((clip) => clip.id === clipId);
  const [clip] = source.clips.splice(index, 1);

  if (startTime !== undefined) clip.startTime = requireFiniteNumber(startTime, "startTime");
  clip.trackId = destinationId;

  if (!allowOverlap) {
    assertNoOverlap(findTrack(next, destination.id), clip.startTime, clip.duration, clipId);
  }
  findTrack(next, destinationId).clips.push(clip);
  return { project: finish(next), clipId };
}

/** Splits at an absolute timeline time, mirroring the editor's Split (S). */
export function splitClip(project, { clipId, time }) {
  const { clip } = requireClip(project, clipId);
  const at = requireFiniteNumber(time, "time");
  const end = clip.startTime + clip.duration;
  if (at <= clip.startTime + 0.001 || at >= end - 0.001) {
    fail("INVALID_PARAMS", `time ${at} must fall strictly inside the clip (${clip.startTime}–${end})`);
  }

  const next = clone(project);
  const found = findClip(next, clipId);
  const first = found.clip;
  const offset = at - first.startTime;

  const second = {
    ...clone(first),
    id: randomUUID(),
    startTime: at,
    duration: first.duration - offset,
    inPoint: first.inPoint + offset,
    outPoint: first.outPoint,
  };
  first.duration = offset;
  first.outPoint = first.inPoint + offset;

  findTrack(next, found.track.id).clips.push(second);
  return { project: finish(next), clipId, newClipId: second.id };
}

export function removeClip(project, { clipId }) {
  const found = requireClip(project, clipId);
  const next = clone(project);
  const track = findTrack(next, found.track.id);
  track.clips = track.clips.filter((clip) => clip.id !== clipId);
  track.transitions = (track.transitions ?? []).filter(
    (transition) => transition.clipAId !== clipId && transition.clipBId !== clipId,
  );
  return { project: finish(next), clipId };
}

/**
 * Adds (or replaces) an effect on a clip. Verified in Stage 6: an effect carried in the
 * project JSON is honoured by the export renderer.
 */
export function setEffect(project, { clipId, type, params = {}, enabled = true, replace = true }) {
  requireClip(project, clipId);
  if (typeof type !== "string" || !type) fail("INVALID_PARAMS", "effect type is required");

  const next = clone(project);
  const clip = findClip(next, clipId).clip;
  clip.effects = clip.effects ?? [];
  const existing = replace ? clip.effects.findIndex((effect) => effect.type === type) : -1;
  const effect = { id: `effect-${randomUUID()}`, type, enabled, params: clone(params) };
  if (existing >= 0) effect.id = clip.effects[existing].id;
  if (existing >= 0) clip.effects[existing] = effect;
  else clip.effects.push(effect);
  return { project: finish(next), clipId, effectId: effect.id };
}

export function removeEffect(project, { clipId, type, effectId }) {
  requireClip(project, clipId);
  const next = clone(project);
  const clip = findClip(next, clipId).clip;
  clip.effects = (clip.effects ?? []).filter(
    (effect) => (effectId ? effect.id !== effectId : effect.type !== type),
  );
  return { project: finish(next), clipId };
}

export function setClipTransform(project, { clipId, transform = {}, volume, opacity }) {
  requireClip(project, clipId);
  const next = clone(project);
  const clip = findClip(next, clipId).clip;
  clip.transform = { ...clip.transform, ...clone(transform) };
  if (opacity !== undefined) clip.transform.opacity = requireFiniteNumber(opacity, "opacity");
  if (volume !== undefined) clip.volume = requireFiniteNumber(volume, "volume");
  return { project: finish(next), clipId };
}

/**
 * Audio fade in/out, in seconds from each end of the clip.
 *
 * Writes the engine's own `clip.fade` field, which the audio engine turns into a linear gain
 * envelope on the clip's gain node (see clip-fade-envelope.ts) and which survives into the
 * export mix. Transitions can impose their own fades; the engine takes whichever is longer.
 *
 * Fades longer than the clip, or overlapping each other, are rejected rather than silently
 * clamped - an agent that asks for a 5s fade on a 2s clip has made a mistake worth hearing
 * about. Setting both to 0 removes the fade entirely.
 */
export function setAudioFade(project, { clipId, fadeInSeconds, fadeOutSeconds }) {
  requireClip(project, clipId);
  if (fadeInSeconds === undefined && fadeOutSeconds === undefined) {
    fail("INVALID_PARAMS", "set_audio_fade needs fadeInSeconds and/or fadeOutSeconds");
  }

  const next = clone(project);
  const clip = findClip(next, clipId).clip;
  const current = clip.fade ?? { fadeIn: 0, fadeOut: 0 };

  const fadeIn = fadeInSeconds === undefined
    ? current.fadeIn
    : requireFiniteNumber(fadeInSeconds, "fadeInSeconds", { min: 0 });
  const fadeOut = fadeOutSeconds === undefined
    ? current.fadeOut
    : requireFiniteNumber(fadeOutSeconds, "fadeOutSeconds", { min: 0 });

  if (fadeIn + fadeOut > clip.duration + 1e-6) {
    fail(
      "INVALID_PARAMS",
      `fades (${fadeIn}s + ${fadeOut}s) exceed the clip's ${clip.duration}s`,
    );
  }

  if (fadeIn === 0 && fadeOut === 0) delete clip.fade;
  else clip.fade = { fadeIn, fadeOut };

  return { project: finish(next), clipId, fade: clip.fade ?? null };
}

/**
 * Text clips go in the TOP-LEVEL `textClips[]` array (verified in Stage 10 check #2): the
 * editor loads them into its title engine, and they render in the export.
 */
export function addTextClip(project, {
  trackId, text, startTime = 0, duration = 3, style = {}, transform = {},
}) {
  requireTrack(project, trackId);
  if (typeof text !== "string" || !text) fail("INVALID_PARAMS", "text is required");

  const next = clone(project);
  const clip = {
    id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    trackId,
    startTime: requireFiniteNumber(startTime, "startTime"),
    duration: requireFiniteNumber(duration, "duration", { min: 0.001 }),
    text,
    style: { ...DEFAULT_TEXT_STYLE, ...clone(style) },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
      ...clone(transform),
    },
    keyframes: [],
  };
  next.textClips = next.textClips ?? [];
  next.textClips.push(clip);
  return { project: finish(next), textClipId: clip.id };
}

/**
 * Transitions live on the track owning `clipAId`. `params` may be `{}` — every type reads
 * its options with a default (verified in Stage 10 check #1). `edge` ("in"/"out") anchors a
 * transition to one clip's edge instead of between two clips.
 */
export function addTransition(project, { clipAId, clipBId, type, duration = 0.5, params = {}, edge }) {
  const { track } = requireClip(project, clipAId);
  if (!TRANSITION_TYPES.includes(type)) {
    fail("INVALID_PARAMS", `Unknown transition type "${type}". Known: ${TRANSITION_TYPES.join(", ")}`);
  }
  if (clipBId !== undefined && clipBId !== null) requireClip(project, clipBId);
  if (edge !== undefined && edge !== "in" && edge !== "out") {
    fail("INVALID_PARAMS", 'edge must be "in" or "out"');
  }

  const next = clone(project);
  const transition = {
    id: `transition-${randomUUID()}`,
    clipAId,
    ...(clipBId ? { clipBId } : {}),
    ...(edge ? { edge } : {}),
    type,
    duration: requireFiniteNumber(duration, "duration", { min: 0.001 }),
    params: clone(params),
  };
  const target = findTrack(next, track.id);
  target.transitions = [...(target.transitions ?? []), transition];
  return { project: finish(next), transitionId: transition.id };
}

export function renameProject(project, { name }) {
  if (typeof name !== "string" || !name) fail("INVALID_PARAMS", "name is required");
  const next = clone(project);
  next.name = name;
  return { project: finish(next), name };
}

/* ------------------------------------------------------------ op dispatch */

export const OPERATIONS = {
  add_track: addTrack,
  add_media: addMediaItem,
  add_clip: addClip,
  trim_clip: trimClip,
  move_clip: moveClip,
  split_clip: splitClip,
  remove_clip: removeClip,
  set_effect: setEffect,
  remove_effect: removeEffect,
  set_clip_transform: setClipTransform,
  set_audio_fade: setAudioFade,
  add_text_clip: addTextClip,
  add_transition: addTransition,
  rename_project: renameProject,
};

/**
 * Applies a list of `{ op, ...params }` entries in order.
 *
 * Atomic: the input project is never mutated, and an error at step N discards every
 * earlier step too — the caller keeps its original. Returns the new project plus each
 * step's result (ids of things created), so an agent can chain (add a clip, then trim it).
 */
export function applyOps(project, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    fail("INVALID_PARAMS", "ops must be a non-empty array");
  }

  let current = project;
  const results = [];

  ops.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof entry.op !== "string") {
      fail("INVALID_PARAMS", `ops[${index}] must be an object with an "op" string`);
    }
    const handler = OPERATIONS[entry.op];
    if (!handler) {
      fail("UNKNOWN_OP", `ops[${index}]: unknown op "${entry.op}". Known: ${Object.keys(OPERATIONS).join(", ")}`);
    }
    const { op, ...params } = entry;
    try {
      const { project: updated, ...rest } = handler(current, params);
      current = updated;
      results.push({ op, ...rest });
    } catch (error) {
      if (error instanceof ProjectKitError) {
        fail(error.code, `ops[${index}] (${op}): ${error.message}`);
      }
      throw error;
    }
  });

  return { project: current, results };
}
