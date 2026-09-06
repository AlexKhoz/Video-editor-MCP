import { getExportEngine } from "@openreel/core";
import type { Project, VideoExportSettings } from "@openreel/core";

import { refreshRegistry } from "./component-library-clips";
import { saveMediaBlob } from "./media-storage";
import { fetchServerMedia, loadServerProject } from "./server-storage";
import { useEngineStore } from "../stores/engine-store";
import { useProjectStore } from "../stores/project-store";

/**
 * Automation hook for headless drivers (Stage 10).
 *
 * Exposed as `window.__openreelAutomation` so the export worker can load a project by id
 * and export it without scraping aria-labels or monkey-patching `showSaveFilePicker`.
 * Everything here is additive app code — no core engine changes.
 *
 * The export backend requires a writable stream (`webcodecs-backend.ts` throws without
 * one and has no in-memory target), so we hand it our own memory writable and keep the
 * bytes.
 */

interface MemoryWritable {
  stream: FileSystemWritableFileStream;
  bytes(): Uint8Array;
}

/** Implements just enough of FileSystemWritableFileStream, including `seek` (mp4 needs it). */
function createMemoryWritable(): MemoryWritable {
  let buffer = new Uint8Array(0);
  let position = 0;
  let size = 0;

  const ensure = (needed: number) => {
    if (needed <= buffer.length) return;
    const grown = new Uint8Array(Math.max(needed, buffer.length * 2 || 1 << 16));
    grown.set(buffer);
    buffer = grown;
  };

  const toBytes = async (data: unknown): Promise<Uint8Array> => {
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  };

  const stream = {
    async write(chunk: unknown) {
      let data = chunk;
      let at = position;
      if (chunk && typeof chunk === "object" && "type" in (chunk as Record<string, unknown>)) {
        const command = chunk as { type: string; position?: number; size?: number; data?: unknown };
        if (command.type === "seek") {
          position = command.position ?? 0;
          return;
        }
        if (command.type === "truncate") {
          size = command.size ?? size;
          return;
        }
        data = command.data;
        if (command.position != null) at = command.position;
      }
      const bytes = await toBytes(data);
      ensure(at + bytes.length);
      buffer.set(bytes, at);
      position = at + bytes.length;
      size = Math.max(size, position);
    },
    async seek(next: number) {
      position = next;
    },
    async truncate(next: number) {
      size = next;
    },
    async close() {},
    async abort() {},
  } as unknown as FileSystemWritableFileStream;

  return { stream, bytes: () => buffer.subarray(0, size) };
}

type ExportStatus = "idle" | "running" | "done" | "failed";

const state: {
  status: ExportStatus;
  progress: number;
  phase: string;
  error: string | null;
  bytes: Uint8Array | null;
} = { status: "idle", progress: 0, phase: "", error: null, bytes: null };

/**
 * Loads a server project into the store, rehydrating media blobs from `/media/:id`.
 * Mirrors what the Projects panel does — the same code path a human would take.
 */
async function loadProjectById(id: string) {
  try {
    const record = await loadServerProject(id);
    const incoming = record.project;

    const items = await Promise.all(
      (incoming.mediaLibrary?.items ?? []).map(async (item) => {
        if (item.blob instanceof Blob) return item;
        const blob = await fetchServerMedia(item.id);
        if (!blob) return { ...item, isPlaceholder: true };
        try {
          await saveMediaBlob(incoming.id, item.id, blob, item.metadata);
        } catch {
          // local cache is best-effort
        }
        return { ...item, blob, isPlaceholder: false };
      }),
    );

    const restored = items.filter((item) => !item.isPlaceholder).length;
    useProjectStore.getState().loadProject({ ...incoming, mediaLibrary: { items } });
    await refreshRegistry();

    const project = useProjectStore.getState().getFullProject();
    return {
      ok: true as const,
      name: project.name,
      duration: project.timeline.duration,
      clipCount: project.timeline.tracks.reduce((total, track) => total + track.clips.length, 0),
      textClipCount: project.textClips?.length ?? 0,
      mediaTotal: items.length,
      mediaRestored: restored,
    };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fire-and-forget: poll `getExportState()` and then `takeExportBase64()`. */
function startExport(overrides: Partial<VideoExportSettings> = {}) {
  if (state.status === "running") return { ok: false, error: "An export is already running" };

  state.status = "running";
  state.progress = 0;
  state.phase = "starting";
  state.error = null;
  state.bytes = null;

  void (async () => {
    try {
      // getFullProject() merges in text/shape/SVG/sticker clips, which live in the engines.
      const project: Project = useProjectStore.getState().getFullProject();
      const engine = getExportEngine();
      await engine.initialize();

      const writable = createMemoryWritable();
      const settings: Partial<VideoExportSettings> = {
        width: project.settings.width,
        height: project.settings.height,
        frameRate: project.settings.frameRate,
        format: "mp4",
        codec: "h264",
        bitrate: 12000,
        quality: 85,
        ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value != null)),
      };

      const generator = engine.exportVideo(project, settings, writable.stream);
      // A for-await loop would discard the generator's return value, so step manually.
      let result;
      for (;;) {
        const { value, done } = await generator.next();
        if (done) {
          result = value;
          break;
        }
        state.progress = value.progress ?? 0;
        state.phase = value.phase ?? "";
      }

      if (!result?.success) {
        throw new Error(result?.error?.message ?? "Export failed");
      }

      state.bytes = writable.bytes();
      state.progress = 1;
      state.phase = "complete";
      state.status = "done";
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = "failed";
    }
  })();

  return { ok: true };
}

function getExportState() {
  return {
    status: state.status,
    progress: state.progress,
    phase: state.phase,
    error: state.error,
    bytes: state.bytes?.length ?? 0,
  };
}

function encodeBase64(view: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

/** Hands the bytes over as base64 and drops the local reference. */
function takeExportBase64(): string | null {
  if (!state.bytes) return null;
  const base64 = encodeBase64(state.bytes);
  state.bytes = null;
  state.status = "idle";
  return base64;
}

/**
 * One composited frame as a PNG, without encoding a video.
 *
 * `VideoEngine.renderFrame` is what the preview canvas itself uses, so this is the same
 * compositing path — tracks in render order, transforms, effects, text and graphics — just
 * without the encoder or the audio mix. Seconds instead of the minutes a full export takes,
 * which is the whole point: an agent can look at what it built.
 *
 * The project comes from `getFullProject()`, not the raw store, because text/shape/SVG
 * clips live in the engines and only that merge brings them back.
 */
async function renderPreviewFrame(
  time: number,
  options: { width?: number; height?: number } = {},
): Promise<
  | { ok: true; base64: string; width: number; height: number; time: number }
  | { ok: false; error: string }
> {
  try {
    // The engine store initialises lazily, and in a headless tab nothing has triggered it:
    // the preview canvas is what normally does, and no one has looked at it. `initialize()`
    // also returns immediately when an init is already in flight, so waiting on the promise
    // is not enough — wait for the store to actually settle.
    const engineStore = useEngineStore.getState();
    if (!engineStore.initialized) {
      void engineStore.initialize().catch(() => {});
      const deadline = Date.now() + 30_000;
      while (!useEngineStore.getState().initialized && Date.now() < deadline) {
        const { initError } = useEngineStore.getState();
        if (initError) return { ok: false, error: `Engine init failed: ${initError}` };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const engine = useEngineStore.getState().videoEngine;
    if (!engine) return { ok: false, error: "VideoEngine did not initialise within 30s" };

    const project: Project = useProjectStore.getState().getFullProject();
    const at = Math.max(0, Math.min(time, project.timeline.duration));
    const frame = await engine.renderFrame(project, at, options.width, options.height);
    if (!frame) return { ok: false, error: `renderFrame produced nothing at ${at}s` };

    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, error: "Could not get a 2d context" };
    context.drawImage(frame.image, 0, 0);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { ok: true, base64: encodeBase64(bytes), width: frame.width, height: frame.height, time: at };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface OpenReelAutomation {
  ready: true;
  version: 1;
  loadProjectById: typeof loadProjectById;
  startExport: typeof startExport;
  getExportState: typeof getExportState;
  takeExportBase64: typeof takeExportBase64;
  renderPreviewFrame: typeof renderPreviewFrame;
}

declare global {
  interface Window {
    __openreelAutomation?: OpenReelAutomation;
  }
}

/** Idempotent; called once from the editor shell. */
export function installAutomationHook(): void {
  if (window.__openreelAutomation) return;
  window.__openreelAutomation = {
    ready: true,
    version: 1,
    loadProjectById,
    startExport,
    getExportState,
    takeExportBase64,
    renderPreviewFrame,
  };
}
