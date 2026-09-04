# NOTES

Engineering notes for the browser video editor prototype.

## Stage 0 — Environment

| Tool | Version | Status |
|---|---|---|
| Node.js | v22.14.0 | OK |
| npm | 11.8.0 | OK |
| pnpm | 10.12.1 | OK |
| git | 2.51.2 | OK |
| Docker | 29.2.1 | installed, **daemon not running** |
| Docker Compose | v5.0.2 | OK |
| ffmpeg | 8.1.1-full (gyan.dev) | OK, on PATH |

Platform: Windows 11 Pro, shell: PowerShell + git-bash.

Docker daemon must be started (Docker Desktop) before Stage 3 (Redis).

## Stage 1 — OpenReel Video

Vendored (absorbed fork, nested `.git` removed) into `apps/editor`.

- Upstream: https://github.com/Augani/openreel-video
- Forked at commit: `5f3c85e5fc223c86060bf4b12e1b4dec58e9b8a9` ("chore(deps): align public workspace lockfile")
- License: MIT
- To pull upstream changes later: add it as a remote from the monorepo root and merge with
  `git subtree`, or diff against a fresh clone of that SHA.

OpenReel is itself a pnpm monorepo:
`apps/{web,desktop,image,studio}`, `packages/{core,ui,agent,agent-runner,creation-*,fxpkg,image-core}`.
Editor target = `@openreel/web`. Root `dev` script = `pnpm --filter @openreel/web dev`.
`pnpm-workspace.yaml` uses `patchedDependencies` for `@ffmpeg/core` and `@ffmpeg/core-mt`
(pnpm-specific -> we stay on pnpm).

### Verified working (Stage 1, real interaction in a Chromium browser)

Dev server: `pnpm --filter @openreel/web dev` -> Vite 5.4.21 on <http://localhost:5173/>. No env vars required.

| Function | How verified |
|---|---|
| Import video | ffmpeg-made 6s 640x360 h264/aac file -> appears in Project Media with thumbnail |
| Add to timeline | double-click media item; prompts "Match Video Dimensions?" (kept 1920x1080) |
| Split | playhead 2s + Split (S) -> 6s clip becomes 1.987s + 2s clips |
| Trim | "Trim end to playhead (W)" at 4s -> second clip shortened to 2.00s |
| Multi-track | 4 track rows; text clip dragged from Video 1 to Track 2, confirmed in project JSON (`textClips[0].trackId`) |
| Export | MP4 2,072,315 bytes, header `ftypisom`, `[export] render=0.5ms/f frames=270` |
| Recovery | page reload -> "We found an unsaved project / 2 older saves available" -> Recover restored everything |

Notes on the environment:

- **WebGPU is unavailable in the embedded Claude browser** (`[WebGPURenderer] No GPU adapter available`
  -> `[RendererFactory] WebGPU init failed, using Canvas2D`). Export still works, CPU-rendered.
- **Export opens a native save dialog** via `showSaveFilePicker()`
  (`apps/web/src/components/editor/Toolbar.tsx:245`), which cannot be driven from automation.
  There is an anchor-download fallback at `apps/web/src/services/export-runner.ts:301` when the
  picker throws anything other than `AbortError`. For automated end-to-end tests, stub
  `window.showSaveFilePicker` with an in-memory writable implementing
  `write` / `seek` / `truncate` / `close` (omitting `seek` fails with `diskWriter.seek is not a function`).
- Only one external network request fires at startup: a Google Fonts stylesheet from `index.html`.
  Mediapipe / Hugging Face model downloads are on-demand only
  (`apps/web/src/services/multicam-face-reactions.ts`). `apps/web/scripts/vendor-fonts.mjs` exists to
  vendor those fonts locally if we want fully offline operation.

### Runtime project state

All paths below are relative to `apps/editor/apps/web/src/` unless noted.

- **`stores/project-store.ts`** (~4,500 lines) is the single Zustand store holding the whole project.
  It is composed from slices in **`stores/project/`**: `clip-slice.ts`, `media-slice.ts`, `track-slice.ts`,
  `timeline-item-slice.ts`, `text-graphics-slice.ts`, `subtitle-slice.ts`, `marker-slice.ts`,
  `history-slice.ts` (undo/redo), plus `project-helpers.ts` / `store-helpers.ts` / `types.ts`.
- Other stores: `stores/timeline-store.ts` (view state: zoom, track heights, playhead),
  `stores/ui-store.ts`, `stores/engine-store.ts` (title/graphics/render engines), `stores/settings-store.ts`.
- **Text, shape, SVG and sticker clips do NOT live in the Zustand project object.** They live in the
  title/graphics engines and are merged in on serialization by `getFullProject()`
  (see `stores/project-store.ts:2957`), which calls `titleEngine.getAllTextClips()`,
  `graphicsEngine.getAllShapeClips()`, etc. Anything needing the complete project must use
  `getFullProject()`, not `state.project`.
- Core domain types live in the workspace package **`packages/core/src/types/`**:
  `project.ts` (`Project`, `MediaItem`, `MediaLibrary`), `timeline.ts` (`Clip`, `Track`, `Effect`, `ClipMetadata`).

### Persistence

Three separate mechanisms, all local, all IndexedDB:

1. **Autosave / crash recovery** — `services/auto-save.ts`.
   IndexedDB `openreel-autosave`, store `autosaves`, version 1. Config at `services/auto-save.ts:28`:
   **30s interval, 2s debounce, 3 rotating slots**, enabled by default.
   The trigger is both timer- and edit-driven: `initializeAutoSave` (`stores/project-store.ts:2953`) starts
   the interval and subscribes to the Zustand `project` selector, calling
   `autoSaveManager.markDirty(getFullProject())` on every project change; the manager debounces 2s and
   skips writes when a content hash is unchanged.
   `serializeProjectForAutoSave()` strips `blob`, `fileHandle`, `waveformData`, `filmstripThumbnails`
   and any `blob:` thumbnail URL before storing. This is what powers the
   "We found an unsaved project / N older saves available" dialog (`checkForRecovery` / `recoverFromAutoSave`).
2. **Named projects + recents** — `services/project-manager.ts`.
   IndexedDB `openreel-projects`, stores `projects` (keyPath `id`) and `recent`.
3. **Media blobs** — `services/media-storage.ts`, delegating to `StorageEngine` from `@openreel/core`.
   Keyed by `mediaId` and `projectId` (`saveMediaBlob` / `loadProjectMedia` / `deleteProjectMedia`),
   plus persisted `FileSystemFileHandle` / directory handles for re-linking files across sessions.
   Recovery re-attaches blobs by `mediaId` after loading the autosaved JSON
   (`recoverFromAutoSave`, `stores/project-store.ts:2988`).

`localStorage` holds only small UI flags: `openreel-onboarding-complete`, `openreel-ui-preferences`,
`openreel-timeline-workspace` (track heights).

### Project JSON: export and import to file — YES, both already exist

The toolbar button **"Project JSON / Comments"** opens `components/editor/ScriptViewDialog.tsx`, which has
three modes: view, **Export JSON** (with `Copy` and `Download JSON` — a real `URL.createObjectURL` +
`a.download` of `<name>_<date>.json`, `ScriptViewDialog.tsx:71-77`) and **Import** (file read or paste,
then `Import Project`, `ScriptViewDialog.tsx:137`). So OpenReel already round-trips a project to a `.json`
file; we do not need to build save/load-to-file ourselves.

Serialization lives in `packages/core/src/storage/project-serializer.ts`:
`exportToJson()` wraps the project as `{ version, capabilities, minimumReaderVersion, project }` and strips
media blobs; `importFromJson()` calls `assertReaderCompatibility(projectFile)` then
`normalizeProjectStoredFields()`. Validation is deliberately lenient — `parseProjectContent`
(`services/project-manager.ts:186`) only requires `project.id` and `project.name` to be strings, and
`normalizeProjectStoredFields` (`project-serializer.ts:204`) only fills in motion/creation/shader defaults.
Everything is spread-based, so **unknown extra fields on clips survive a JSON round-trip**.

### Sample project object

Real export from the Stage 1 test project, saved verbatim at
[`apps/editor/NOTES-sample-project.json`](apps/editor/NOTES-sample-project.json).
That project = one 6s video imported, split at 2s, second half trimmed to 2s, plus one "Heading"
text clip moved onto Track 2.

Top-level shape:

```
{ version, minimumReaderVersion, capabilities[], project: {...}, metadata: { exportedAt, description } }
```

Inside `project`:

| Field | Meaning |
|---|---|
| `id`, `name`, `createdAt`, `modifiedAt` | project identity; timestamps are epoch ms |
| `settings` | `width`, `height`, `frameRate`, `sampleRate`, `channels` — the canvas/output spec |
| `mediaLibrary.items[]` | the media library (the "bin"). One entry per imported asset |
| `timeline.tracks[]` | ordered tracks; each has `id`, `type` ("video"), optional `mode`, `name`, `clips[]`, `transitions[]`, `locked`, `hidden`, `muted`, `solo` |
| `timeline.duration` | computed total duration, seconds |
| `timeline.subtitles[]`, `timeline.markers[]` | subtitles and timeline markers |
| `textClips[]`, `shapeClips[]`, `svgClips[]`, `stickerClips[]` | **flat top-level arrays, NOT nested in tracks**; each carries its own `trackId` |
| `motionCompositions[]`, `motionInstances[]`, `generatedShaders[]` | the built-in "Motion Design" mode's data |
| `capabilities[]` | e.g. `"universal-tracks-v1"`; gates whether an older reader may open the file |

A media library item (`mediaLibrary.items[0]`):

- `id` — UUID referenced by clips via `mediaId`. **This is the join key.**
- `name`, `type` (`"video" | "audio" | "image"`).
- `fileHandle: null`, `blob: null` — always stripped in JSON; blobs live in IndexedDB keyed by this `id`.
- `metadata` — `duration`, `width`, `height`, `frameRate`, `codec`, `sampleRate`, `channels`, `fileSize`,
  `hasVideo`, `hasAudio`.
- `thumbnailUrl` — a session-local `blob:` URL (worthless after reload; autosave nulls it out).
- `sourceFile` — `{ name, size, lastModified }`, a hint used to re-match the file in another session or machine.
- `isPlaceholder` — true when the media is referenced but its bytes are missing.
- Precedent worth copying: for AI-generated media the same interface already carries `originalUrl`,
  `isPending`, `kieaiTaskId`, `kieaiError` (`packages/core/src/types/project.ts:57`). Our render-service
  clips can follow exactly that pattern — a URL plus a job id plus a pending flag.

A timeline clip (`timeline.tracks[0].clips[0]`):

- `id`, `mediaId` (-> media library item), `trackId`.
- `startTime` — position on the timeline, seconds.
- `duration` — length on the timeline, seconds.
- `inPoint` / `outPoint` — the source-media in/out, seconds. **Trimming changes these, not the media.**
  In the sample, the split produced clip A `startTime 0, inPoint 0, outPoint 1.9867` and clip B
  `startTime 1.9867, inPoint 1.9867, outPoint 3.9867, duration 2` — both halves still point at the same
  `mediaId`, and B's `outPoint` was pulled in by the trim.
- `effects[]`, `audioEffects[]`, `transform` (`position`, `scale`, `rotation`, `anchor`, `opacity`,
  `fitMode`), `volume`, `keyframes[]`.
- Optional: `speed`, `reversed`, `chromaKey`, `colorGrading`, `blendMode`, `stabilization`, ... and **`metadata`**.

A text clip (`textClips[0]`): `id`, `trackId`, `startTime`, `duration`, `text`, `style`
(`fontFamily`, `fontSize`, `fontWeight`, `color`, `strokeColor`, `textAlign`, ...), `transform`
(position normalized 0..1 here, unlike video clips' pixel offsets), `keyframes[]`.

### What this means for Stage 5 (extending the schema)

`Clip.metadata` is typed as `ClipMetadata` (`packages/core/src/types/timeline.ts:82`), which has an
**open index signature**:

```ts
export interface ClipMetadata {
  readonly templateSource?: EditingTemplateApplicationSource;
  readonly appliedTemplates?: AppliedEditingTemplate[];
  readonly templateManaged?: boolean;
  readonly templateTrackType?: "text" | "graphics";
  readonly [key: string]: unknown;   // <- official extension point
}
```

So the Stage 5 fields fit without touching the core schema at all:

```json
"metadata": {
  "source": "component-library",
  "componentId": "animated-text",
  "props": { "text": "...", "color": "#ffffff", "durationInSeconds": 3 },
  "renderedFileId": "..."
}
```

They survive export/import because the serializer is spread-based and validation is lenient.
Open question for Stage 5: whether to also add our own entry to `capabilities[]`. Doing so makes stock
OpenReel readers refuse the file via `assertReaderCompatibility` — honest, but stricter. Recommendation:
skip it for the prototype.

### Media library / import panel (for Stage 4)

- **`components/editor/AssetsPanel.tsx`** (~1,610 lines) is the whole left panel, mounted once at
  `components/editor/EditorInterface.tsx:483`.
- The left rail's tabs come from the `ASSETS_TABS` array (`AssetsPanel.tsx:62`), with the `AssetsTab`
  union type just above it: `media | text | graphics | effects | transitions | ai | recipes | templates`.
  **Adding a "Component Library" tab = one entry in that union + one entry in `ASSETS_TABS` + one panel body.**
- The "Project Media" grid renders at `AssetsPanel.tsx:1114`; the hidden `<input type="file" multiple>` is
  at `AssetsPanel.tsx:1559` (`accept="video/*,audio/*,image/*"`); drop handling is `onDrop={handleDrop}`
  at `AssetsPanel.tsx:1107`.
- The import entry point to reuse is **`importMedia(file: File)`** from the project store's media slice
  (`stores/project/media-slice.ts:22`), called at `AssetsPanel.tsx:712` and `:959`. Handing it a `File`
  fetched from render-service is the cleanest way to get a rendered component into the library — it handles
  metadata probing, thumbnailing, blob persistence and library insertion for us.

## Motion Design mode vs. our plan

Short focused pass over OpenReel's built-in "Motion Design" mode (the second workspace tab, and the
`motionCompositions` / `motionInstances` fields in the project JSON). Conclusion up front: **it is not
keyframe motion on existing clips — it is a full parameterized animation-composition system that already
does structurally what our Component Library is meant to do.** It is directly relevant, and it changes
the cheapest implementation path for Stage 4/5 (though not the brief we are following).

### What it actually is

A second, After-Effects-shaped editor living in `apps/web/src/motion/` (`MotionCreatorApp.tsx`,
`MotionCreatorShell.tsx`) with layer panel, graph editor, masks, deform, effects/shaders, animation
presets, camera, lights, motion blur and its own render queue. Types are in
`packages/core/src/motion/types.ts` (~1,100 lines).

Two-level data model, mirroring After Effects' comp/instance split:

- **`MotionComposition`** (`packages/core/src/motion/types.ts:1054`) — the reusable definition:
  `id`, `name`, `width`, `height`, `frameRate`, `duration`, `backgroundColor`, `layers[]`, `assets[]`,
  `fonts[]`, `markers[]`, `camera`, and — the interesting part — **`variables: MotionVariable[]`**.
- **`MotionVariable`** (`types.ts:990`) — `{ id, name, type, value }` where
  `type: "text" | "number" | "color" | "boolean" | "media"`. That is essentially our planned
  `meta.json` param schema, already in the codebase.
- **`MotionCompositionInstance`** (`types.ts:1081`) — a placement of a composition on a main-timeline
  track: `compositionId`, `trackId`, `startTime`, `duration`, `transform`, `opacity`, `blendMode`,
  and **`variableOverrides: Record<string, string | number | boolean>`**.

So: definition + per-instance parameter overrides + timeline placement. Compare with our Stage 5 target
(`componentId` + `props` + timing) — it is the same shape, with `compositionId` ~ `componentId` and
`variableOverrides` ~ `props`.

### It renders live, not to a file

Instances are composited **per frame** into the main editor timeline, not pre-rendered into a media file.
`Preview.tsx:1821` filters `project.motionInstances` by `trackId` and the current time window and hands
each to a `MotionRenderer`. `variableOverrides` is genuinely honored by the render path — it is threaded
through `packages/core/src/motion/motion-renderer.ts:165`, `motion-render-order.ts:72` and
`motion-gpu-render.ts:161`. There is no intermediate webm; a composition is re-rendered from its layer
graph on every frame draw.

This is the fundamental architectural difference from our plan, which pre-renders each component to a
`webm` with alpha and treats the result as ordinary media.

### Is there a shortcut for Stage 4?

Partly — the store layer, yes; the UI, no.

- **Reusable:** `insertMotionInstance(compositionId, placement?)`
  (`apps/web/src/stores/project-store.ts:3456`, typed at `stores/project/types.ts:250`) does exactly what a
  library panel needs: place a parameterized composition on a track at a given `startTime`/`duration`.
  There are matching `removeMotionInstance`, `getMotionComposition`, `getMotionInstance` actions, and
  motion actions are wired into undo/redo via `packages/core/src/actions/handlers/motion.ts`.
- **Not reusable:** there is **no library/browser UI** for it. The only caller of `insertMotionInstance`
  is `MotionCreatorShell.tsx:666` — a "Use in editor" button inside the Motion Design workspace, which
  places the composition you are currently authoring. You author a comp by hand, then push it to the
  timeline. There is no "pick from a catalogue" panel to mirror.
- **Also missing:** despite `variableOverrides` existing in the type and being honored by the renderer,
  **no UI writes it** — a grep for `variableOverrides` across `apps/web/src/**/*.tsx` returns nothing.
  So per-instance parameter editing is data-model-only today. (`TemplateVariablesPanel.tsx` is a different
  feature — project-template variables, not motion variables.)

Net: for Stage 4 we would still build the panel and the parameter form ourselves either way. What the
motion path would save is the render service, the queue and the file storage; what it would cost is
writing components as OpenReel `MotionLayer` graphs instead of Motion Canvas scenes.

### Conflicts with our plan

- **No conflict on storage or in-repo assumptions.** Compositions are plain project data stored in the
  project JSON (and IndexedDB) — user-authored at runtime, not compiled into the repo. Nothing expects a
  fixed in-repo catalogue, so nothing blocks fetching assets from an external service.
- **No conflict on our chosen approach.** Our render-service clips arrive as normal media library items +
  ordinary `Clip`s carrying `metadata.componentId` / `props` / `renderedFileId`. That path does not touch
  `motionCompositions` / `motionInstances` at all — the two systems sit side by side without interfering.
- **One real tension, worth naming:** we are about to build a second, parallel mechanism for
  "parameterized reusable animated component on the timeline" when the host app already has one. The
  duplication is deliberate (the brief specifies Motion Canvas, and Motion Canvas gives us a real
  animation DSL, headless CLI rendering, and alpha-channel webm output that survives outside this editor),
  but it is duplication.
- **Practical trade-offs of the two paths**, for the record:
  - *Our plan (Motion Canvas + render service):* components are authored in TypeScript with a proper
    animation library; rendering is headless and reproducible; output is a portable file. Costs: a
    service, a Redis queue, render latency before a clip appears, and re-render on every parameter change.
  - *Motion Design instances:* zero infrastructure, instant parameter changes, live compositing, undo/redo
    already wired. Costs: components must be expressed as OpenReel motion layer graphs (no external DSL),
    they only exist inside OpenReel, and we would be building on a large in-repo subsystem we did not write
    and would have to learn.

**Decision taken:** proceed with Stage 2 as briefed (Motion Canvas + render service). Recorded here so the
alternative is a deliberate rejection rather than an oversight — if render latency turns out to be the
prototype's main friction, `insertMotionInstance` + `variableOverrides` is the escape hatch.

### Direct comparison: native Motion Design vs. external Motion Canvas + render-service

**1. Live or baked?** Both, on separate paths — and this is a point in its favour.

- *On the main timeline:* strictly **live, per-frame, never baked.** `Preview.tsx:1821` filters
  `project.motionInstances` by `trackId` + time window and renders each through `MotionRenderer` on every
  frame draw. Equivalent to a Remotion Player: parameter changes are instant, nothing is written to disk.
- *Engine:* primary path is **`OffscreenCanvas` 2D** (`motion-renderer.ts:633`, `getContext("2d")`).
  An optional **WebGPU** compositor handles layer blending when available
  (`motion-gpu-compositor.ts:331`, `getContext("webgpu")`, with WGSL blend shaders from
  `motion-gpu-blend.ts`) behind a `preferGpu` flag; it falls back to Canvas2D otherwise.
  Adjustment layers, track mattes and backdrop-blur force the Canvas2D compositing path
  (`compositionRequiresCanvas2dCompositing`, `motion-gpu-render.ts:28`). 3D (`scene3d`) layers use
  **WebGL** internally (`motion-renderer.ts:756`). So: Canvas2D by default, WebGPU compositing when the
  GPU allows, WebGL for 3D. In our embedded-browser environment WebGPU is unavailable, so Canvas2D.
- *It can also bake:* Motion Design has its own render queue (`apps/web/src/motion/render-queue-runner.ts`
  -> `exportMotionCompositionScene`) whose formats (`export-motion-frame.ts:64`,
  `MOTION_EXPORT_FORMATS`) are: `mp4` (H.264), **`webm-alpha` — "WebM (VP9, transparent)"**,
  `mov-prores4444` (transparent) and `png-sequence` (transparent ZIP), with resolution scaling and a
  frame range. **That is exactly the deliverable Stage 2 was going to build a Node service to produce,
  and it already exists client-side.**

**2. Can a composition be authored as arbitrary code?** **No.** This is the real constraint.

- `MotionLayerType` (`packages/core/src/motion/types.ts:20`) is a **closed union of ten types**:
  `text | shape | image | video | group | null | composition | adjustment | particle | scene3d`.
  There is no "custom code" or "custom component" layer type. A composition is a declarative JSON layer
  graph in OpenReel's own schema, authored through the Motion Design UI.
- Two genuine code escape hatches exist, but neither is component-level authoring:
  - **Per-property expressions.** `MotionExpression.code` (`types.ts:575`) holds a JS snippet, compiled via
    a `Function`-style compiler with `"use strict"` and cached (`motion-expressions.ts:544`), with
    After-Effects-like helpers (default example: `value + wiggle(2, 20)`). This animates *one property*,
    it does not define a component.
  - **Custom GLSL.** `MotionShaderDef` (`packages/core/src/motion/shaders/types.ts`) carries raw `glsl`
    plus typed params (`number | color`) and an `origin: "builtin" | "generated"`. Real shader code, but
    scoped to fills/effects on a layer.
- **Portability verdict:** a composition is meaningful only to OpenReel's renderer. There is no
  composition import/export to a standalone file (no `importComposition`/`exportComposition` anywhere in
  `apps/web/src/motion/`); comps live inside the project JSON. Authoring components natively means our
  component library becomes fork-specific data with no life outside this editor — precisely the coupling
  the external render-service was chosen to avoid. Motion Canvas scenes, by contrast, are ordinary
  TypeScript in a standalone repo that renders to a file usable by any editor.

**3. Recommendation: keep the external Motion Canvas + render-service plan.** Reasoning, weighted:

- The decisive factor is (2), not (1). Live rendering and transparent-webm output are both *better* in the
  native path — but component **authoring** is locked to a proprietary declarative schema with a
  GUI-first workflow. Our components (`animated-text`, `logo-reveal`, `color-transition`) are code
  artifacts we want to version, review, parameterize and reuse; as OpenReel layer graphs they would be
  hand-built in a UI and stored as project JSON, with no path to any other tool.
- The brief's stated rationale (portability, MIT-licensed external engine, self-hosted rendering) is
  satisfied only by the external path. Pivoting would silently trade the prototype's main design goal for
  short-term convenience.
- What we knowingly give up: instant parameter feedback (we re-render on every prop change), and the
  infrastructure cost of a service plus Redis queue. Both are acceptable for a prototype and were
  budgeted in the original architecture.
- Two concrete borrowings from the native system, at no cost to portability:
  - Mirror `MotionVariable`'s param typing (`"text" | "number" | "color" | "boolean" | "media"`,
    `types.ts:990`) in our `meta.json` schema instead of inventing our own vocabulary.
  - Keep `insertMotionInstance` + `variableOverrides` documented as the escape hatch if render latency
    becomes the prototype's dominant friction — the store action, undo/redo wiring and live renderer are
    already there, so a later pivot stays cheap.
- Also worth stealing regardless of path: their `webm-alpha` encoder settings, as a cross-check that our
  Motion Canvas CLI output (VP9 + alpha) matches what this editor imports cleanly.

## Stage 2 — Motion Canvas components

_pending_

## Stage 3 — render-service

_pending_
