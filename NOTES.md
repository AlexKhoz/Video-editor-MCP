# NOTES

Engineering notes for the browser video editor prototype.

## Conventions

Standing rules that apply to future work, kept here so they survive between sessions.

- **Custom components carry a `-Rep` suffix on both the id and the display name.** Every
  component we build from now on is named `<thing>-Rep` with a display name ending in
  " Rep" — e.g. id `orbit-headline-Rep`, name "Orbit Headline Rep". Applied retroactively to
  the two Stage 13/14 components in Stage 15; the six earlier ones (animated-text,
  color-transition, logo-reveal, logo-reveal-v2, lower-third, stat-counter) keep their
  original ids deliberately, since renaming them would break the projects and
  component_metadata rows that already reference them.
- **A component's directory name must equal its `meta.json` id.** `listComponents` throws on
  a mismatch, so a rename means moving the directory too. By convention the project and scene
  filenames match as well (`src/projects/<id>.ts`, `src/scenes/<id>.tsx`), and `meta.json`'s
  `project` field is what actually resolves the path.
- **Adding or renaming a component touches four places**: `components/<id>/meta.json`,
  `src/projects/<id>.ts`, `src/scenes/<id>.tsx`, plus registration in *both*
  `src/render-harness.ts` (import + `PROJECTS` key, which is the id used by the API and CLI)
  and `vite.config.ts` (the `project:` list).

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

Motion Canvas 3.17.2 (MIT, as are `@motion-canvas/2d`, `/ui`, `/vite-plugin`, `/ffmpeg`).
`packages/component-library/` is a standalone npm project — it has its own `node_modules` and is not
part of any pnpm workspace, so it can be lifted out of this repo unchanged.

### Layout

```
packages/component-library/
  components/<id>/meta.json     param schema per component (what the UI reads)
  src/projects/<id>.ts          makeProject() + defaults, one project per component
  src/scenes/<id>.tsx           the animation itself
  src/lib/props.ts              prop injection (URL query, then VITE_COMPONENT_PROPS)
  src/render-harness.ts         headless render driver (runs in the browser)
  render-harness.html           page the headless browser loads
  scripts/render.mjs            CLI: props in, transparent webm out
  output/                       scratch PNG frames (gitignored)
```

### Param schema

`meta.json` `type` values deliberately reuse OpenReel's `MotionVariable` vocabulary
(`packages/core/src/motion/types.ts:990`): **`text | number | color | boolean | media`**.
So `text` (not "string") for strings. This keeps the format compatible with the
`insertMotionInstance` + `variableOverrides` fallback described above, should we ever switch.
Each `meta.json` also names its `project` file and which param is the duration
(`durationParam`), so the UI can set clip length without hardcoding key names.

### Rendering: there is no Motion Canvas CLI

Worth recording because the original plan assumed one. Findings:

- Motion Canvas ships **no CLI binary** (`npm view @motion-canvas/core bin` -> none). Rendering is
  designed to run in a browser, driven by the editor UI.
- `@motion-canvas/ffmpeg` **cannot produce alpha**: its exporter hardcodes MP4 and
  `-pix_fmt yuv420p` (`node_modules/@motion-canvas/ffmpeg/lib/server/FFmpegExporterServer.js:64-65`).
- The built-in image-sequence exporter (`@motion-canvas/core/image-sequence`) **does** keep alpha, but
  it only works with a Vite dev server: it ships each frame over the HMR channel
  (`import.meta.hot.send('motion-canvas:export', ...)`) and the Vite plugin writes the PNGs to disk.

So `scripts/render.mjs` builds the pipeline the missing CLI would have provided:

1. start a Vite dev server programmatically (random port);
2. launch **headless Chrome** via `puppeteer-core` (Apache-2.0, no bundled Chromium download — it uses
   the system Chrome/Edge; override with `CHROME_PATH`);
3. load `render-harness.html?project=<id>&props=<json>&fps=&width=&height=`, which constructs
   `new Renderer(project)` and calls `render()` with `background: null` and the image-sequence exporter;
4. Vite writes `output/<id>/000000.png` … (PNG, alpha preserved);
5. our own ffmpeg muxes them: `libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 28 -auto-alt-ref 0`,
   matching OpenReel's own `webm-alpha` export target;
6. delete the PNG scratch frames (`--keep-frames` to keep them).

Exact command:

```bash
node scripts/render.mjs --component animated-text \
  --props '{"text":"Ship it","color":"#ffcc00","durationInSeconds":2}' \
  --out ../../storage/rendered/demo.webm
```

Flags: `--component --props --out --fps (30) --width (1920) --height (1080) --keep-frames`.
Everything is local: Vite, Chrome, ffmpeg. No API keys, no cloud.

### The three components render, verified

| Component | Props used | Frames | Output | Peak mean alpha |
|---|---|---|---|---|
| `animated-text` | text "Stage 2", `#ffcc00`, 2s | 61 @30fps | 104,110 B | 2.99 (small glyph coverage) |
| `logo-reveal` | `#22d3ee`, 2.5s | 89 @30fps | 52,916 B | 20.96 (badge covers more) |
| `color-transition` | `#ef4444` -> `#3b82f6`, 1.5s | 46 @30fps | 12,302 B | 255 (full-frame overlay) |

All three: VP9, 1920x1080, WebM tag `alpha_mode=1`. Verified with
`ffprobe -show_entries stream_tags=alpha_mode` and by measuring the alpha plane frame by frame:

```bash
ffmpeg -c:v libvpx-vp9 -i file.webm \
  -vf "alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -
```

For `animated-text` the mean alpha traces the animation exactly: 0 -> 2.99 (hold) -> 1.05 -> 0.

### Alpha compatibility with OpenReel: import works, compositing does NOT

This was checked before building anything on top of it, and it turned up a real problem.

**What works.** OpenReel imports the file cleanly. Its probe of `animated-text.webm` read
`codec vp9, 1920x1080, duration 2.033333, frameRate 30, hasVideo true, hasAudio false`,
`isPlaceholder` false — all correct. The clip behaves like any other: it lands in the media library,
drops on a track, trims, and exports.

**What does not.** **OpenReel's decode path drops the alpha channel.** Stacked
`animated-text` (top track) over the opaque `color-transition` (lower track) and exported: at a time
where both clips are live, the frame shows the text glyphs at exactly `255,204,0` — and everywhere
else **pure black**, not the layer underneath. The reverse stacking gave the mirror image: the opaque
clip covered the text entirely. So each video layer is composited opaquely; a transparent region
becomes black.

**The file is not at fault.** The same webm decoded through a plain `<video>` element in the same
browser and drawn to a 2D canvas gives corner RGBA `(0,0,0,0)` — fully transparent — with only 220
non-transparent pixels across the centre row (the glyphs). Chrome decodes our alpha correctly;
OpenReel's pipeline is what loses it. Cause: OpenReel extracts frames through WebCodecs/mediabunny
(`packages/core/src/video/video-engine.ts`, no `alpha` handling anywhere in it), and VP9 alpha in WebM
lives in per-block side data that WebCodecs does not reconstruct. Note the asymmetry: OpenReel can
*encode* `webm-alpha` but cannot *decode* it.

Useful adjacent finding: **track order is reversed for rendering** —
`getVisibleTrackRenderOrder` (`packages/core/src/timeline/timeline-items.ts:62-68`) reverses the
array, so **"Video 1" (index 0) is the topmost layer**, not the bottom one. Also, "Add to timeline"
inserts at the playhead, not at 0.

### Gotchas to remember during Stage 4 manual testing

Small, but each one will waste an hour if forgotten:

- **"Video 1" is the TOP layer, not the bottom.** `getVisibleTrackRenderOrder`
  (`packages/core/src/timeline/timeline-items.ts:62-68`) reverses the track array before rendering,
  so track index 0 composites last, i.e. on top. A component dropped on "Video 1" covers everything
  below it.
- **"Add to timeline" inserts at the playhead, not at 0.** Two clips added one after another both
  landed at 0.9s because that is where the playhead happened to sit. Park the playhead at 0 before
  testing, or expect offsets.
- Hovering a media card is what reveals its per-item **"Add to timeline" / "Delete"** buttons; they
  are not in the DOM until then. Double-clicking a card adds it too, but only via real pointer events.
- The preview canvas does not repaint while the browser pane is hidden, so pixels sampled from it can
  be stale. Export a frame instead when you need deterministic output.

**Options for Stage 4** (needs a product decision, none blocks Stage 3):

1. *Patch the fork's decode path* — draw alpha-carrying WebM clips from an `HTMLVideoElement` instead
   of WebCodecs frames (proven above to preserve alpha) for clips whose media is tagged
   `alpha_mode=1`. Contained change, keeps the architecture and true transparency. Most work.
2. *Chroma key* — render components over a green background and lean on OpenReel's existing per-clip
   `chromaKey` / green-screen feature (`Clip.chromaKey`, `GreenScreenSection.tsx`). Zero core changes,
   works today, but edge quality suffers and it is a hack.
3. *Accept opaque components* for the prototype — put them on the top track with their own designed
   background. Cheapest, but gives up the overlay use case that motivates the library.
4. *Switch to the native motion path* — `insertMotionInstance` + `variableOverrides` renders live with
   real alpha and never touches a decoder. Trades away the portability that justified Motion Canvas
   (see the Motion Design section above); still the documented fallback if the decode patch proves
   expensive or render latency bites.

Recommendation: keep Stage 3 as planned (nothing here affects the render-service), and take option 1
at Stage 4 with option 2 as the fallback if the patch turns out to be larger than it looks.

## Stage 3 — render-service

Fastify 5.12.3 + BullMQ 6.3.4 (both MIT) in `apps/render-service`, Redis 7-alpine from
`infra/docker-compose.yml`. Storage is the local filesystem (`storage/rendered/`) — no object store.

### Shape

```
apps/render-service/
  src/config.js      paths + env-var configuration
  src/components.js  reads packages/component-library/components/*/meta.json, validates props
  src/queue.js       BullMQ queue + BullMQ-state -> API-status mapping
  src/server.js      HTTP API (producer)
  src/worker.js      queue consumer; shells out to the Stage 2 render script
  test/render-e2e.test.js
```

Server and worker are **separate processes**: a render holds a headless Chrome and an ffmpeg for tens
of seconds, and the API has to stay responsive. Redis is bound to `127.0.0.1:6379` only — it is a
local dev queue, not a network service.

### API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | service + Redis status; **503** when Redis is unreachable, with the compose command as a hint |
| `GET` | `/components` | the catalogue, straight from each `meta.json` (this is what the Stage 4 panel will list) |
| `POST` | `/render` | `{ componentId, props, fps?, width?, height? }` -> `202 { jobId, status: "pending", props }` |
| `GET` | `/render/:jobId` | `{ status, progress, … }`; when done also `file`, `url`, `bytes`, `frames`, `durationInSeconds` |
| `GET` | `/files/:name.webm` | streams the rendered file (this is how the editor will pull it into its media library) |

Status values are exactly the four the plan asked for. BullMQ's richer state set is collapsed in
`toApiStatus()`: `waiting | delayed | prioritized | paused | waiting-children` -> `pending`,
`active` -> `processing`, `completed` -> `done`, `failed` -> `failed`.

Props are validated against the component's `meta.json` *before* a job is queued — unknown keys are
dropped and echoed back as `ignoredProps`, missing keys take their defaults, numbers are range-checked
against `min`/`max`, colours must be hex. Bad input gets a `400` listing every problem, so the Stage 4
form can show them inline. The validator switches on the same `MotionVariable` type vocabulary the
`meta.json` files use (`text | number | color | boolean | media`).

### Worker

The worker does **not** reimplement the render pipeline: it spawns
`packages/component-library/scripts/render.mjs` with `--component`, `--props`, `--out`, `--fps`,
`--width`, `--height`, and writes to `storage/rendered/<jobId>.webm`. That script is already verified
(Stage 2) to produce a correct alpha channel, so reusing it keeps one implementation of the
Vite + Chrome + ffmpeg chain. The worker adds a kill-switch timeout (`RENDER_TIMEOUT_MS`, default
10 min), progress updates, an empty-file guard, and parses the frame count out of the script's stdout.

Concurrency defaults to 1 (`WORKER_CONCURRENCY`).

### Configuration

All optional env vars: `PORT` (3001), `HOST` (127.0.0.1), `REDIS_HOST`, `REDIS_PORT`, `QUEUE_NAME`,
`RENDER_STORAGE_DIR`, `COMPONENT_LIBRARY_DIR`, `WORKER_CONCURRENCY`, `RENDER_TIMEOUT_MS`,
`RENDER_FPS`, `RENDER_WIDTH`, `RENDER_HEIGHT`, `LOG_LEVEL`.

### Three snags worth remembering (all fixed)

1. **`node --test test/` does not work here.** With a directory argument Node 22.14 on Windows tried
   to `require` the directory as a module and died with `MODULE_NOT_FOUND: ...	est`. The script is
   now `node --test test/*.test.js`.
2. **BullMQ 6 made `ioredis` an optional dependency.** Without it both server and worker threw
   `BullMQ could not load the optional 'ioredis' package` at import time, so the server never listened.
   `ioredis` (MIT) is now an explicit dependency.
3. **BullMQ 6 removed `queue.client`.** It resolves to `undefined` (the raw Redis client moved behind
   the backend abstraction, per `queue-base.d.ts`), so the old `queue.client.ping()` health check always
   reported Redis down. Readiness is now `queue.waitUntilReady()` raced against a 2s timeout, because it
   otherwise hangs while ioredis retries.

Also: killing a test run with Ctrl+C (or a task kill) leaves the spawned server and worker alive, and
the next run then fails with `EADDRINUSE 127.0.0.1:3199`. The test now checks the port is free up
front and reports a dead child's exit code, instead of blaming it on an unhealthy service.

### Test

`npm test` in `apps/render-service` (node:test): lists the catalogue and asserts every param type is
in the MotionVariable vocabulary, rejects an unknown component (404) and bad props (400 with two
specific messages), then renders `animated-text` with custom text through the real API — polling
`/render/:jobId` until it settles — and asserts the file exists, is non-empty, matches the reported
byte count, downloads over HTTP as `video/webm`, and starts with WebM's EBML magic bytes
(`1A 45 DF A3`). Requires Redis, ffmpeg and Chrome.

Result: **5/5 passing, exit 0, ~7.7s** end to end (`processing -> done`; `pending` is usually too brief
to observe). The rendered file was `102,273 bytes, 40 frames`, and `ffprobe` confirms the file the API
produced still carries alpha: `vp9,1920,1080` with `alpha_mode=1`. `KEEP_TEST_OUTPUT=1` keeps it for
inspection.

## Stage 4 — Component Library panel in OpenReel

Alpha decision for this stage: **chroma key (option 2)**, not patching the decode path. No
core-engine changes, works today, and gives a real visual overlay. Patching WebCodecs for
`alpha_mode=1` stays a post-Stage-6 follow-up.

### Chroma-key rendering

`scripts/render.mjs` gained `--background <hex>`; the transparent mode is untouched and still the
default. With a background the harness passes it to Motion Canvas as the stage `background` (instead
of `null`), and ffmpeg encodes `yuv420p` rather than `yuva420p` — the alpha plane is pointless once
the frames carry a backdrop, and the file is smaller (39 KB vs 102 KB for a comparable clip).

`#00ff00` is not arbitrary: it matches OpenReel's own chroma default, `keyColor { r: 0, g: 1, b: 0 }`
(`GreenScreenSection.tsx:124`). Verified on a rendered frame — background exactly `(0,255,0)`,
glyphs `(255,255,255)`.

`POST /render` takes an optional `background` (validated as hex), threads it through the job to the
worker's `--background`, and echoes it on the job status. The panel always asks for `#00ff00`.

### The panel

`apps/editor/apps/web/src/components/editor/panels/ComponentLibraryPanel.tsx`, wired into
`AssetsPanel.tsx` at exactly the four points mapped in Stage 1: the `AssetsTab` union, `ASSETS_TABS`,
`TAB_ICONS` (added `Boxes`), and the `renderSectionContent` switch. Nothing else in that file changed.
`tsc --noEmit` on `@openreel/web` is clean.

Flow: `GET /components` -> card grid -> form generated from the param schema (`text`/`media` -> text
input, `color` -> colour picker, `number` -> range + readout, `boolean` -> checkbox) -> **Generate**
-> `POST /render` -> poll `GET /render/:jobId` once a second -> download the file -> hand it to the
store's existing `importMedia(file)`. Button text tracks the phase (Queued / Rendering N% / Adding to
media), errors surface inline and as a toast, and if the service is unreachable the panel says so and
offers Retry plus the commands to start it. Service URL overridable with `VITE_RENDER_SERVICE_URL`
(default `http://127.0.0.1:3001`).

### Manual test — works end to end

Generated `animated-text` with the text "Stage 4 works" from the panel: job 3 rendered in ~20s and
landed in the media library as `animated-text-Stage 4 works.webm` (75,415 bytes, 00:02), behaving like
any other clip. Placed it on **Video 1** (the top layer) with a blue-to-pink gradient clip on
**Video 2** underneath, then applied Chroma Key.

Measured from OpenReel's own MP4 export, sampling the centre row of the frame:

| time | what is live | green px | white px | background pixel |
|---|---|---|---|---|
| 1.0s, before keying | both clips | 1467 | 405 | `(0,255,1)` — green covers the layer below |
| 1.0s, after keying | both clips | **0** | 438 | `(233,62,119)` — the gradient shows through |
| 4.0s, after keying | gradient only | 0 | 0 | `(233,62,119)` |

The editor's live preview agrees: white "Stage 4 works" over the gradient, no green anywhere, no
visible fringing at preview scale.

### Two things about OpenReel's chroma-key UI

1. **The Green Screen section's Enable switch does not affect rendering.** `handleToggleEnabled`
   (`GreenScreenSection.tsx:141`) only mutates the in-memory `ChromaKeyEngine` and bumps
   `project.modifiedAt`; unlike the colour/tolerance handlers it never dispatches
   `clip/setChromaKey`, so `clip.chromaKey` stays undefined and the export is unaffected. Toggling it
   changed nothing in the output — confirmed by exporting and sampling pixels.
2. **The path that works is the Chroma Key *effect*.** Select the clip, open Effects, and
   **double-click** the "Chroma Key" card (its own label says "or double-click to apply to selected
   clip"). That writes `clip.effects[] = [{ type: "chromaKey", enabled: true, params: {} }]`, which the
   render path honours. Default params key out green at 30% tolerance — good enough as-is.

For Stage 5/6 automation: the inspector accordions are `div[role="button"]`, not `<button>` elements,
so `querySelectorAll("button")` misses them entirely — select by `aria-label` instead
(`Expand … section` / `Collapse … section`).

## Stage 5 — component metadata and re-render

### Where the metadata lives

On `clip.metadata`, via the `ClipMetadata` index signature found in Stage 1 — **no core schema
change**:

```json
"metadata": {
  "source": "component-library",
  "componentId": "animated-text",
  "props": { "text": "Persisted swap", "color": "#ffffff", "durationInSeconds": 2 },
  "renderedFileId": "6.webm",
  "background": "#00ff00"
}
```

`background` is recorded so a re-render reproduces the same chroma backdrop rather than assuming the
current default.

### How it gets there

The panel imports the rendered file, but the *clip* only exists once the user drops that media on a
track — so `services/component-library-clips.ts` bridges the gap:

- `registerGeneratedMedia(mediaId, info)` records mediaId -> component info, mirrored into
  `localStorage` (`openreel-component-library-media`) so a reload before placement does not lose it;
- a single store subscription stamps `clip.metadata` on any clip referencing registered media that
  does not carry it yet — idempotent, so it is safe on every store change;
- `updateClipMetadata(clipId, patch)` merges into one clip's metadata by spreading the clip, so
  `effects`, `transform` and trim points are carried over untouched. Written straight to the store
  because there is no `clip/setMetadata` action; `GreenScreenSection` mutates store state the same way.

### Round-trip: confirmed, no re-render

Generated `animated-text` ("Round trip"), placed it, applied Chroma Key, waited for autosave, reloaded
the page and hit Recover:

| check | result |
|---|---|
| `clip.metadata` after reload | all five fields intact |
| `clip.effects` after reload | `["chromaKey"]` |
| media restored | `animated-text-Round trip.webm`, `isPlaceholder: false` |
| calls to render-service after reload | **none** (`performance` resource list has no `:3001` entries) |
| render-service job counter | `4` before reload, `4` after — nothing re-rendered |

### Re-render: effects survive

`handleRegenerate` uses **`replaceMediaAsset(clip.mediaId, file)`**, which swaps the bytes behind the
*existing* mediaId. The clip object is never rebuilt, so effects/transform/trim/position survive by
construction rather than by copying them across. Verified on a clip that already had Chroma Key:

| check | before | after |
|---|---|---|
| clip id | `b3010207-…` | `b3010207-…` (same) |
| mediaId | `17f787fb-…` | `17f787fb-…` (same) |
| `effects` | `[chromaKey enabled]` | `[chromaKey enabled]` |
| `metadata.props.text` | "Round trip" | "Re-rendered OK" |
| `renderedFileId` | `4.webm` | `5.webm` |
| `startTime` / `duration` / `inPoint` / `outPoint` | 0 / 2.033 / 0 / 2.033 | unchanged |

And the keying still works — sampled from OpenReel's own export at 1.0s, centre row:
**0 green pixels**, background `(233,62,119)` (the gradient underneath), 462 white glyph pixels; at
4.0s (component clip ended) pure gradient. The UI reports it too: "1 effect kept on the clip."

### Two bugs found while testing

1. **`replaceMediaAsset` never persists the new blob — fixed in our flow.** It updates the in-memory
   media item but calls no `saveMediaBlob` (the only call in `media-slice.ts` is inside `importMedia`).
   Consequence: the re-render looked right until a reload, after which recovery re-attached the
   *previous* bytes and the clip showed the old text while its metadata described the new one.
   `handleRegenerate` now writes the blob itself after the swap. Re-tested end to end: re-rendered to
   "Persisted swap", waited for autosave, reloaded, recovered — preview and export both show the new
   render, and the export still keys (0 green, 462 white).
2. **The preview does not apply clip effects after a media swap, or after loading a project.** This one
   is pre-existing OpenReel behaviour, not caused by the swap: on a freshly recovered project whose
   clip carries `effects: [chromaKey]`, the preview shows the raw green while **the export of that very
   same project keys correctly** (0 green). Dispatching `openreel:preview-invalidate` (the convention
   other inspector sections use) does not help; scrubbing the playhead does not help. The effect
   appears to be registered with the preview's effect pipeline only when applied through the UI in that
   session.

   Consequence for Stage 6: after a reload the demo's live preview will show green even though the
   project is correct. Either re-apply the Chroma Key effect in-session before demoing the preview, or
   demo the exported file. Worth a follow-up alongside the alpha decode patch — both are preview/decode
   plumbing in the same area.

## Stage 6 — end-to-end scenario

Run against a genuinely fresh project, driven through the real UI in a Chromium browser. Project id
`c9ca4e44-970c-4255-8a6c-fc5db510f8e7`.

| # | Step | Verified how | Result |
|---|---|---|---|
| 1 | Create a new project | real interaction — Start Fresh -> Create Horizontal project | empty library ("No media imported"), 1920x1080 |
| 2 | Import a video, trim it | real interaction — file input, Add to timeline, **Trim end to playhead (W)** at 4.0s | 6s source -> clip `0 - 4.00s`, `outPoint 4.00` |
| 3 | Generate `animated-text` | real interaction — Component Library, text "End to end", 2s, Generate | job 7 -> `7.webm`, appeared in Project Media |
| 4 | Second track, sync timing, Chroma Key | real interaction — Add to timeline at playhead 1s, then the Effects **Chroma Key card (double-click)** | component on **Video 1** (top) `1.00 - 3.03s`, video on **Video 2** `0 - 4.00s`, `effects: [chromaKey]` |
| 5 | Save the project | real interaction — autosave (this build has no explicit Save button; persistence is autosave + Project JSON download) | 3 rotating autosave slots for this project id, newest 3,443 B |
| 6 | Reload and reopen | real interaction — full page reload -> "We found an unsaved project" -> Recover Project | same project id; component `start 1.00`, `effects [chromaKey]`, full metadata (`componentId`, `props`, `renderedFileId 7.webm`, `background #00ff00`); both media restored, neither a placeholder |
| 7 | Export the final video | real interaction — Export (MP4 preset), captured through an in-page writable stub | **1,976,509 bytes**, header `ftypisom`, **1920x1080**, **4.00s** |

### Export frame verification

Sampled the centre row of the exported MP4 — the source of truth for this stage, since the live
preview is affected by the known reload bug:

| time | what should be live | green px | white px | background pixel |
|---|---|---|---|---|
| 0.5s | footage only (component starts at 1s) | 0 | 0 | `(233,62,119)` |
| 2.0s | footage + component | **0** | **356** | `(233,62,119)` |
| 3.6s | footage only (component ended at 3.03s) | 0 | 0 | `(233,62,119)` |

Zero green anywhere, the gradient footage visible behind the text, and white glyph pixels present only
while the component clip is live. The compositing is correct in the exported file.

### Preview screenshot

With the Chroma Key effect re-applied in-session (the documented workaround for the reload bug), the
live preview at 2.0s shows white "End to end" over the blue-to-pink gradient, no green. That extra
effect application was undone afterwards, so the saved project still carries exactly one
`chromaKey` effect.

**Definition of Done met**: the scenario reproduces locally with no manual file edits between steps,
everything lives in one git repository, and the root `README.md` documents running it from scratch.

## Stage 7 — alpha fixed in export; the preview-effects fix failed and was reverted

### The earlier diagnosis was wrong in one direction

Stages 2 and 5 concluded "OpenReel drops the alpha channel". That was inferred from the *export*
only, then generalised. Tested properly — a transparent VP9 clip on Video 1 over gradient footage on
Video 2, no chroma key:

- **Preview composited the alpha clip correctly all along** (yellow glyphs over the gradient, no black
  box). Preview's own decode path builds an `HTMLVideoElement` (`Preview.tsx`, `decodeClipFrame`), and
  `createImageBitmap(video)` keeps the alpha.
- **Export rendered it as an opaque black rectangle** covering the footage: at 1.0s the centre row had
  1701 black pixels, 15 gradient, 204 yellow.

So alpha was an **export-path** problem and the effects-reapplication is a **preview-path** problem —
the mirror image of what Stages 2/5 assumed.

### Fix that landed: one option, in the export decoder

`ExportFrameDecoder` (`packages/core/src/media/mediabunny-engine.ts:113`) built its sink as
`new CanvasSink(videoTrack, { poolSize: 2 })`. mediabunny's own docs for the option it omits
(`media-sink.d.ts`, `CanvasSinkOptions`):

> `alpha?: boolean` — "Whether the output canvases should have transparency instead of a black
> background. Defaults to `false`. Set this to `true` when using this sink to read transparent videos."

Default `false` means `getContext('2d', { alpha: false })`, which bakes black behind every frame.
mediabunny *does* decode VP9 alpha side data (it has a `u_alphaTexture` WebGL path), so nothing was
missing upstream — the flag was simply never passed. Adding `alpha: true` is the entire fix.

Verified, same project and timestamps, before -> after:

| sample | before | after |
|---|---|---|
| 1.5s black pixels (centre row) | 1701 | **0** |
| 1.5s gradient pixels | 15 | **1711** |
| 1.5s yellow glyph pixels | 204 | 209 |
| 3.5s (alpha clip ended) | gradient, clean | gradient, clean |

**Regression check on the chroma path** (Stage 4/6's mechanism, an opaque clip keyed with the Chroma
Key effect): export still correct — 0 green, 0 black, gradient visible behind 439 white glyph pixels.
Preview also still renders normally. `alpha: true` is a no-op for opaque content.

Consequence: **true transparency now works end to end**, so chroma keying is no longer required. The
panel still renders on `#00ff00` because that path is what Stages 4-6 verified; switching it is a
one-line change (`CHROMA_BACKGROUND` -> `null` in `ComponentLibraryPanel.tsx`, and drop the
`background` from the render request), and would remove keying artefacts — but it needs the Stage 5/6
flows re-verified before being made the default.

### Fix that did NOT work: hydrating the effects bridge (reverted)

Root cause of the preview bug was found and is not in doubt. `applyEffectsToFrame`
(`components/editor/preview/canvas-renderers.ts:1769`) reads a clip's effects from
**`effectsBridge.getEffects(clipId)`** — an in-memory `Map` populated only by `applyVideoEffect()`
when an effect is applied through the UI — while the export reads `clip.effects` off the project
(`video-engine.ts:788`). Hence: correct in-session, wrong after a reload, export always fine.

The obvious fix — walk the project on load and replay each clip's stored effects into the bridge —
**made the preview worse**: the canvas rendered nothing at all (pure background, 1882 white pixels in
the centre row) instead of the unkeyed green. A/B proof, hook in place both times:

| hydration | preview centre row |
|---|---|
| `applyVideoEffect` disabled | green 1470, white 416 — renders (the original bug) |
| `applyVideoEffect` enabled | white 1882 — renders nothing |

Params were not the problem (`getDefaultParams("chromaKey")` supplies key colour, tolerance, edge
softness and spill). The likely gap: the Effects card path does more than touch the bridge — it
dispatches `clip/addEffect` *and* the inspector's chroma controls separately drive a `ChromaKeyEngine`
(`enableChromaKey` / `setKeyColor` / `setTolerance`), so a bridge-only entry leaves the preview's chroma
pipeline half-configured and it keys everything away. Making this work needs the preview's chroma/GL
path understood properly, which is more than a safe prototype-scope patch, so the whole attempt was
reverted: **deferred item #2 stands, with its root cause now pinned to a specific line.**

An earlier `alpha: true` was also tried in `video/decode-worker.ts`, `video/playback-engine.ts` and
`video/video-engine.ts`. Those sites are not on the export path (the export reaches
`ExportFrameDecoder` via `decodeFrameWithMediaBunny` -> `getMediaEngine()`), so they were reverted too
— the change is one line in one file.

### Two debugging traps worth recording

- **`await import('/src/stores/project-store.ts')` from the page console creates a second module
  instance**, hence a second, empty Zustand store. A probe using it reported "0 clips" for a loaded
  project and sent this investigation down a blind alley. Read app state through the DOM, or through a
  module the app itself exported onto `window`.
- **Autosave recovery is not deterministic across rapid reloads.** Twice a "blank preview" turned out
  to be an empty project because the Recover dialog had not appeared yet. Always assert the clip count
  before drawing conclusions from pixels.

## Stage 8 — alpha as the panel default, and three new components

### Alpha is now the default

`ComponentLibraryPanel.tsx` renders with `DEFAULT_BACKGROUND = null` (transparent). `CHROMA_BACKGROUND`
(`#00ff00`) is retained and documented as the fallback for OpenReel builds without the Stage 7 alpha
fix — flipping one constant switches the whole panel back, and `--background` in `render.mjs` plus the
`background` field on `POST /render` are unchanged.

Why alpha won, measured rather than assumed:

| | true alpha | chroma key |
|---|---|---|
| Green-dominant edge pixels in an exported frame | **0** | 4,364 (0.21% of frame) |
| File size, 2s clip | 104,110 B | 75,415 B (alpha ~38% larger) |
| Steps after Generate | drop on a track | drop on a track **+ apply the Chroma Key effect** |
| Correct in preview after a reload | **yes** | no — needs the effect, which hits the open preview bug |

The last row is the decisive one: a chroma component depends on an *effect*, and effects do not
survive a reload in the preview (Stage 7). An alpha component needs no effect, so it renders correctly
in preview and export, before and after reload — it routes around the bug we could not fix.

Accepted cost: a transparent component only composites correctly in a build carrying the Stage 7 fix.
Stock OpenReel, or another tool with the same mediabunny default, would show a black box — which is
exactly why the chroma path stays supported.

### Verification: Stage 4 and Stage 6 re-run on the default path

Not alpha in isolation — the actual default user path through the panel, on a fresh project, with a
new component (`lower-third`, title "Alpha By Default").

- **Panel catalogue** lists all six components (Stage 4 requirement).
- **Generated through the panel**: job 8, metadata recorded `background: null`, and the file on disk is
  `vp9 … alpha_mode=1`, 73,217 B — the default path really does produce transparency.
- **Placed** on Video 1 at 1.02s over footage on Video 2 (0.02–5.02s, trimmed from 6s with
  *Trim end to playhead*). **No Chroma Key applied anywhere** — `effects: []` on both clips.
- **Saved** via autosave, **reloaded**, **recovered**: component still at 1.02s with
  `source: component-library`, `background: null`, `effects: []`.
- **Live preview after the reload was already correct** — centre row 1920/1920 gradient pixels (no
  black box), lower band 880 dark plate + 12 accent + 1028 gradient. This is the bug-#2 sidestep in
  practice.
- **Export**: 3,007,187 B, `ftypisom`, 1920x1080, 5.03s.

| time | expected | centre row | lower band |
|---|---|---|---|
| 0.5s | footage only | 1920 gradient, 0 black | 1920 gradient |
| 2.5s | footage + lower third | 1920 gradient, 0 black | 880 plate + 12 accent + 1028 gradient, **0 black** |
| 4.9s | lower third sliding out | 1920 gradient | 298 plate + 1622 gradient |

Zero black pixels at every sample: alpha composites correctly through the full save/reload/export
chain with no keying step.

### Three new components

Chosen for the category OpenReel has no native equivalent for. Each is a Motion Canvas scene plus a
`meta.json` using the `MotionVariable` vocabulary, registered in `vite.config.ts` and the render
harness, and rendered through `render.mjs`:

| component | render | animation |
|---|---|---|
| `lower-third` | 119 frames, 61,804 B, peak mean alpha 14.40 | accent bar and text plate slide in from the left, hold, slide out; lower-left safe area |
| `logo-reveal-v2` | 108 frames, 242,256 B, peak mean alpha 3.20 | 12 shards spiral in from outside the frame, land as a dodecagon, then a ring materialises and a core snaps in |
| `stat-counter` | 96 frames, 425,365 B, peak mean alpha 7.85 | number counts up to its target over an accent rule and label; `toLocaleString` grouping, decimals only for fractional targets |

All three: VP9 1920x1080, `alpha_mode=1`, animated alpha (verified per-frame), and all six appear in
the panel catalogue and in `GET /components`.

`logo-reveal-v2` is deliberately distinct from `logo-reveal` (badge wipe) so the library has visual
variety in the same slot. One honest note: once the ring materialises, the landed shards sit under the
ring stroke at the same radius and stop being individually visible — the assembly reads during the
build, not in the held frame.

### Part A: OpenReel's native transition system (and why Part B was redirected)

`TRANSITION_TYPES` (`packages/core/src/types/effects.ts:612`) defines **24 transition types**:
crossfade, dipToBlack, dipToWhite, wipe, slide, zoom, push, circleReveal, blur, whipPan, radialWipe,
pixelate, glitch, blinds, diamondReveal, spin, flip, splitReveal, **flash**, filmBurn, mosaic, ripple,
pageTurn, colorSplit. They are real implementations, not stubs — `video/transition-engine.ts` has
cases for `wipe` at lines 214/1405 and `flash` at 350/1435, with preview renderers in
`preview/canvas-renderers.ts:145` and a dedicated `transition-bridge.ts`.

The data model is a true A-to-B transition:
`Transition { id, clipAId, clipBId?, edge?, type, duration, params }` (`types/timeline.ts:274`),
applied at a clip edge from the Transitions tab.

That is why the originally-proposed `flash-transition` and `wipe-overlay` components were dropped: an
overlay clip sits *on top of* two clips and cannot interpolate between them, so it would be a strictly
worse duplicate of `flash`/`wipe`. Transitions belong to the native system; this library covers
overlays and graphics.

## Stage 9 — server-side storage for projects, media and component metadata

### Choices, and why

- **SQLite via `node:sqlite`** — Node core on 22.14 (experimental warning, no flag needed), so zero
  dependencies and no native build on Windows. The schema is plain SQL behind a handful of exported
  functions (`src/db.js`), so swapping to Postgres means rewriting one module.
- **Inside render-service**, not a sibling service. It already owns `storage/`, the config and the CORS
  hook, and the editor already talks to it; a second process would have duplicated all of that for no
  gain at this stage.
- **A project is one JSON blob**, not a normalised timeline. The editor already has a stable
  serialisation format (`getFullProject()` + OpenReel's own serialiser) and nothing needs to query
  inside a project yet.
- **Uploads are raw `application/octet-stream`** with `x-filename` / `x-media-id` / `x-mime-type`
  headers, streamed to disk with `pipeline()`. Multipart would have meant a dependency and, in its
  simple form, buffering an entire video in memory; the only client is our own editor, so headers are
  enough. Fastify's default 1 MB `bodyLimit` is raised to `UPLOAD_LIMIT_BYTES` (default 2 GB).
- **IndexedDB is kept as a cache, not removed.** `importMedia` still writes the local blob and the
  autosave/recovery flow still runs; the server write is added alongside. Ripping the local layer out
  would have touched the preview, autosave and recovery paths — far more invasive than this stage
  warrants — and it doubles as the offline safety net.

### Schema

```
projects            id, name, data (JSON), created_at, updated_at
media               id, filename, storage_path, mime_type, size, created_at
component_metadata  media_id, component_id, props (JSON), background, rendered_file_id, updated_at
```

Bytes live in `storage/media/<mediaId><ext>`; the SQLite file is `storage/video-editor.sqlite`.
`component_metadata` replaces Stage 5's localStorage registry — its deferred item #3 is now closed.

### API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/projects` | id, name, createdAt, updatedAt, newest first |
| `POST` | `/projects` | create; id defaults to the project's own id |
| `GET` | `/projects/:id` | full project JSON |
| `PUT` | `/projects/:id` | upsert — saving twice updates in place |
| `DELETE` | `/projects/:id` | |
| `GET` | `/media` | list |
| `POST` | `/media` | raw body, streamed to disk, keyed by the editor's own mediaId |
| `GET` | `/media/:id` | streams the file with its stored mime type |
| `GET`/`POST` | `/component-metadata`, `/component-metadata/:mediaId` | list / read / upsert |

### Editor wiring

- `services/server-storage.ts` — the client. Save strips binary fields through OpenReel's own
  `serializeProjectForAutoSave` before `PUT`.
- `stores/project/media-slice.ts` — after the existing `saveMediaBlob`, an un-awaited
  `uploadMedia(mediaId, file, name)` pushes the bytes server-side under the **same mediaId**, so a clip's
  `mediaId` resolves directly to `/media/:id` on any browser. 8 added lines; a slow upload never blocks
  the import.
- `services/component-library-clips.ts` — the localStorage registry is gone. `registerGeneratedMedia`
  writes to `/component-metadata`, and `refreshRegistry()` hydrates an in-memory cache from the server
  on panel mount.
- **New "Projects" tab** in `AssetsPanel` (the same four-touchpoint pattern as the Component Library
  tab): server project list, "Save to server", and open — which fetches the project JSON, then fetches
  each media item's bytes and attaches them as real blobs.

### Cross-session verification (the actual point of the stage)

Built a project: footage imported, `stat-counter` generated through the panel ("Cross-session", target
8888), both placed, saved to the server.

Then **destroyed local state** in the browser: `indexedDB.deleteDatabase()` for every database and
`localStorage.clear()` / `sessionStorage.clear()`. Confirmed after reload:

- `openreel-db` — the database holding media blobs — **absent**.
- `localStorage` — **0 keys**.
- **No recovery dialog was offered at all**, and the app started with "No media imported". So nothing
  local could have supplied this result.

Opened the project from the **Projects** tab:

| check | result |
|---|---|
| Project listed from the server | "New Horizontal Video" |
| Open result | toast: **"2 media files restored from the server."** |
| Media items | `footage.mp4` 454,999 B / 6.00s and `stat-counter-Cross-session.webm` 257,560 B / 2.20s, **`isPlaceholder: false`** for both |
| Clips | stat-counter on Video 1 at 1.02s, footage on Video 2 at 0.02s |
| Component metadata | `source: component-library`, `componentId: stat-counter`, `renderedFileId: 9.webm`, `background: null`, props intact |
| Media actually decodes | preview at 2.0s: centre row **283 white pixels** (the counting digits) over **1637 gradient pixels** (the footage), 0 transparent — both streams decoded from server-fetched blobs |
| Re-render still works | selecting the clip put the panel in re-render mode, "from 9.webm · …", prefilled `label: "Cross-session"`, `targetNumber: 8888` |

### Two bugs found and fixed during the work

1. **CORS preflight killed every upload.** The custom `x-filename` / `x-media-id` / `x-mime-type`
   headers triggered a preflight that the service rejected, because its hook only allowed
   `content-type` — surfacing in the browser as a bare `TypeError: Failed to fetch`. The hook now
   allows those headers and `PUT`/`DELETE`.
2. **`JSON.stringify` turns a `Blob` into `{}`, which is truthy.** The first save wrote
   `"blob": {}` for every media item, and the loader's `if (item.blob) return item` would then have
   skipped fetching bytes — the cross-session test would have "passed" with empty objects. Saves now go
   through OpenReel's autosave serialiser (drops `blob`, `fileHandle`, `waveformData`, `blob:`
   thumbnails) and the loader tests `item.blob instanceof Blob`.

### Deferred / known limitations

- **No authentication or access control.** Every project is readable and writable by anyone who can
  reach the service. Deliberate for this stage.
- **No conflict handling.** Two people editing one project is last-save-wins, no merge, no warning,
  not even an `updatedAt` precondition check on `PUT`. An `If-Unmodified-Since`-style guard on
  `updated_at` would be the cheapest first step when it matters.
- **Uploads are whole-file, not resumable.** A 2 GB ceiling is configured, but a dropped connection
  restarts the upload; there is no chunking and no progress reporting to the UI.
- **`GET /media/:id` sends `accept-ranges: none`** — it streams the whole file rather than honouring
  range requests, so seeking a large clip re-downloads it. Worth adding range support before anyone
  works with long footage.
- **No garbage collection.** Deleting a project leaves its media rows and files on disk, and nothing
  prunes `component_metadata`.
- Recommendation if this grows past the prototype: move to Postgres plus object storage with
  presigned uploads, at which point range requests and chunked/resumable uploads come mostly for free.

### Stage 9 follow-up — the three infrastructure gaps, closed

The items flagged at the end of Stage 9, now done rather than deferred.

#### 1. Range requests on `GET /media/:id`

Was `accept-ranges: none`, so seeking a clip re-downloaded it and a `<video>` element could not
start until the whole file had arrived. `parseByteRange()` handles the single-range forms and the
route answers `206` with `content-range`; unparseable headers fall back to the whole file, per RFC
9110. Verified against a 257,560-byte clip:

| `Range` | response | body |
|---|---|---|
| *(none)* | `200`, `accept-ranges: bytes` | 257,560 B |
| `bytes=0-99` | `206`, `content-range: bytes 0-99/257560` | 100 B |
| `bytes=-50` (suffix) | `206`, `bytes 257510-257559/257560` | 50 B |
| `bytes=257500-` (open-ended) | `206`, `bytes 257500-257559/257560` | 60 B |
| `bytes=999999999-` | **`416`**, `content-range: bytes */257560` | error JSON |
| `bytes=abc` (malformed) | `200` (ignored) | 257,560 B |

One wrinkle worth remembering: the 416 body first came back as a `500`
(`Attempted to send payload of invalid type 'object'`) because the media `content-type` had already
been set on the reply, so Fastify refused to serialise a JSON error. The range is now parsed *before*
any media header is set.

#### 2. Optimistic-concurrency guard on `PUT /projects/:id`

The body accepts an optional `expectedUpdatedAt`. If it does not match the row's current
`updated_at`, the save is refused with `409` and both timestamps; omitting the field keeps the old
last-write-wins behaviour, so nothing else had to change. Verified end to end:

```
PUT (create)                    -> updatedAt 1788542698930
PUT with expectedUpdatedAt=…930 -> 200, updatedAt 1788542700056
PUT with the STALE …930 again   -> 409 {serverUpdatedAt: …056, yourUpdatedAt: …930}
GET                             -> stored v = 2   (the v=3 write was refused, nothing clobbered)
```

The editor now uses it. The Projects panel remembers the `updatedAt` it last saw (set on open and
after each save) and sends it with every save. On `409` it shows a banner — "The server copy changed
at 7:27:56 PM; you opened the one from 6:37:54 PM. There is no merge — pick one." — with
**Overwrite theirs** (re-saves unguarded) and **Load theirs (discards mine)**. Verified by simulating
a second user with a `curl` save between opening and saving: the banner appeared, Overwrite restored
the local copy on the server, and the banner cleared.

This is still not a merge. It just makes the clobber deliberate instead of silent.

#### 3. Orphan sweep

`POST /media/sweep`, and automatically after `DELETE /projects/:id`. A media row is an orphan when its
id appears in no surviving project's stored JSON — a substring test, which errs toward keeping files
rather than deleting live ones. Sweeping removes the row, its `component_metadata` and the file.
Verified: two genuine orphans (a duplicate footage upload from the CORS-failure retry, and the
smoke-test media) were removed, the two media referenced by the saved project were kept,
`component_metadata` went 2 rows -> 1, and both orphan files disappeared from `storage/media/`.
A later `DELETE` of a project whose media was still referenced elsewhere reported
`orphanedMediaRemoved: []`, as it should.

#### Still deferred

- **No authentication or access control** — unchanged, and the reason the conflict guard is
  identity-free (it compares timestamps, not users).
- **Uploads are still whole-file and not resumable**, with no progress in the UI. The 2 GB ceiling
  stands.
- **No pruning of rendered files** in `storage/rendered/` — the sweep covers uploaded media only.
- Range support does not extend to `GET /files/:name.webm` (the render-service output route), only to
  `/media/:id`.

### Stage 9 definition-of-done — re-run against the hardened code

The cross-session test above was run before the conflict guard changed the save and open paths, so it
was repeated end to end on current code, starting from an empty server (0 projects, 0 media rows, 0
files) and adding two pieces of evidence the first run lacked: the HTTP fetches, and a real re-render
rather than just a prefill check.

**1. Build.** Imported `dod-footage.mp4` (454,999 B), generated `lower-third` through the panel
("Fresh Machine" / "DoD run", 3s) -> job 10, placed both clips (component on Video 1 at 1.02s, footage
on Video 2), saved through the Projects panel -> project `92ea2a9f…`. Server then held 2 media rows and
1 component-metadata row.

**2. Wipe.** `indexedDB.deleteDatabase()` on every database plus `localStorage.clear()` and
`sessionStorage.clear()`. **`openreel-db` — the media-blob store — deleted**, localStorage 0 keys.
(`openreel-autosave` could not be dropped because the running app holds a handle, so recovery was then
declined explicitly, which is stricter: any media had to come from the network.)

**3. Reload and open.** After reload: **no recovery dialog offered at all**, media library empty,
`openreel-db` still absent. `GET /projects` listed "New Horizontal Video"; opening it produced the
toast *"2 media files restored from the server."*

The requests the open actually made, from `performance.getEntriesByType("resource")`:

```
/projects
/projects/92ea2a9f-5e77-404d-a49e-3ae2254939e8
/media/00308eba-a010-4125-a130-a722421f1c6e     <- the footage
/media/55254e37-d50b-499b-9ba8-737be187d990     <- the component
/component-metadata
```

(`transferSize` reads 0 on those entries because cross-origin resource timing is opaque without
`Timing-Allow-Origin`; the decoded pixels below are the real proof that the bytes arrived.)

**4. Evidence.**

| check | result |
|---|---|
| Media items | `dod-footage.mp4` 454,999 B / 6.00s and `lower-third-Fresh Machine.webm` 57,225 B / 3.97s, `isPlaceholder: false` for both |
| Clips | component Video 1 @1.02s, footage Video 2 @0.02s |
| Component metadata | `source: component-library`, `componentId: lower-third`, `renderedFileId: 10.webm`, `background: null`, props intact |
| Video decodes | preview at 2.5s: centre row **1920/1920 gradient pixels** (footage, no black box), lower band **880 plate + 12 accent + 1028 gradient** — both streams decoded from server-fetched blobs |
| Re-render | panel opened in re-render mode ("from 10.webm", prefilled "Fresh Machine" / "DoD run"); changed the title and re-rendered for real -> "Component re-rendered", media renamed, and server metadata moved to `renderedFileId: 11.webm` with the new title |

**A gap the real re-render exposed (now fixed).** After a re-render the server still held the
*previous* render's bytes: `replaceMediaAsset` swaps the blob locally and `saveMediaBlob` writes the
local cache, but nothing re-uploaded. Server metadata said `11.webm` while `/media/:id` still returned
the 57,225-byte "Fresh Machine" file — so a *third* browser would have opened the project and seen the
old render with new props. `handleRegenerate` now re-uploads after the swap. Verified: a further
re-render moved the server row to `lower-third-Server Bytes Updated.webm`, **72,929 B**, under the same
mediaId, with metadata at `renderedFileId: 12.webm` and the matching title — bytes, metadata and disk
all consistent.

Only the first prefill-only check would have missed this; it took actually pressing re-render.

## Stage 10 — headless project manipulation API

Foundation for an MCP agent: a program can build, edit and export a project with no human
in a browser.

> **NO AUTHENTICATION.** These endpoints let any caller rewrite or export any project —
> materially more exposure than the human UI, which at least needs someone clicking. This
> is acceptable **only** while everything is bound to localhost. **It must be closed before
> the service is reachable by anyone but us.** Flagged again here because Stage 10 is the
> point where the risk changes character.

### The three pre-implementation checks

**1. Transition param shapes — no gap.**
`Transition { id, clipAId, clipBId?, edge?: "in"|"out", type, duration, params }`
(`packages/core/src/types/timeline.ts:274`). **`params` may be `{}`**: the editor's own
`transition/add` writes exactly that (`action-executor.ts:1672`), and every branch of
`transition-engine.ts` reads its options with a default — `direction` ("left"),
`softness` (0), `holdDuration` (0), `scale` (2), `center`, `intensity` (?? 1), plus a global
`curve`. `edge` anchors a transition to one clip's edge with `clipBId` omitted. Transitions
live on the track that owns `clipAId`.

**2. Text-clip round-trip — works.** A `textClips[]` entry authored purely as JSON loaded
("JSON TEXT" appeared in the editor UI) and rendered in a headless export: at 2.5s the
centre row had **171 white text pixels + 11 dark stroke pixels** over the footage, and none
at 0.5s or 4.5s — its 1s–4s window honoured exactly.

**3. Audio in a headless export — survives.** Footage with a real aac track exported to
**aac 48000 Hz / 2ch, 5.01s, mean_volume -24.1 dB / max -17.5 dB** (i.e. not silence). The
source was 44100 Hz mono and came out 48 kHz stereo — resampled to the project's
`settings`, as expected.

A fourth finding shaped the design: **the export backend requires a writable stream.**
`webcodecs-backend.ts:54` throws "No writable stream provided" and has no in-memory target,
so the automation hook hands `exportVideo()` its own memory writable rather than
monkey-patching `showSaveFilePicker`.

### What shipped

**`packages/project-kit`** — pure JSON operations, no dependencies, importable by the
service without a build step. Every function returns a *new* project; nothing mutates in
place, which is what makes a batch atomic. Validation is ported from
`packages/core/src/actions/action-validator.ts`: track exists / not locked, clip exists,
finite non-negative times, in/out inside the source media, and an overlap check that can be
waived with `allowOverlap`. `addClip` mirrors the store's duration fallback (explicit →
media duration → 5s default for stills). 13 unit tests cover defaults, overlap refusal,
split arithmetic, effect replace-by-type, transition-type validation, text clips landing in
the top-level array, and atomic rollback.

Operations: `add_track`, `add_media`, `add_clip`, `trim_clip`, `move_clip`, `split_clip`,
`remove_clip`, `set_effect`, `remove_effect`, `set_clip_transform`, `add_text_clip`,
`add_transition`, `rename_project`.

**render-service** gained:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/projects/new` | create an empty valid project server-side |
| `POST` | `/projects/:id/ops` | apply an operation list atomically; honours `expectedUpdatedAt` |
| `POST` | `/projects/:id/export` | queue a headless export |
| `GET` | `/export/:jobId` | `pending \| processing \| done \| failed`, then `file`/`url`/`bytes` |
| `GET` | `/exports/:file` | the exported mp4 |

`ops` results echo the ids of everything created, so an agent can chain steps (add a clip,
then trim *that* clip) without a second round trip to read the project.

**`src/export-worker.js`** — a second BullMQ worker (own queue `project-exports`,
concurrency 1, since export runs at roughly real time). It drives headless Chrome through
**`window.__openreelAutomation`** (`apps/web/src/services/automation.ts`, installed by
`EditorInterface`): `loadProjectById` → `startExport` → poll `getExportState` →
`takeExportBase64`, written to `storage/exports/<jobId>.mp4`.

Two details worth keeping:
- The worker navigates to **`#/editor`**, which mounts the editor directly and skips the
  welcome launcher. The first attempt hit `Waiting failed: 90000ms exceeded` because the
  hook lives in `EditorInterface`, which does not mount while the launcher is showing.
- No aria-label scraping and no `showSaveFilePicker` patching anywhere in the worker.

### End-to-end verification

An agent-shaped script (`scratchpad/e2e-stage10.mjs`) built a project **entirely through the
API** — no hand-written project JSON:

1. `POST /projects/new` → project + first track.
2. `POST /render` (Stage 3 queue) → `13.webm`, downloaded.
3. `POST /media` ×2 with ffprobe metadata.
4. Three `ops` batches: add both media, add a second track, add the footage clip, **trim it
   5s → 4s**, **move it** to the lower track, add the **component clip** on the top track
   with its `component-library` metadata, **set a chromaKey effect** on it, and add a
   **text clip**.
5. `POST /projects/:id/export`, polled to completion.

Guard behaviour, checked in the same run:

- stale `expectedUpdatedAt` → **HTTP 409** (no write).
- a batch whose second op is invalid → **HTTP 400**, and the project name was unchanged:
  **atomic: true**.

Stored project after the batches — exactly what was asked for:

```
name: Agent Built | duration: 4
  Video 1: start=1 dur=2 in/out=0/2 effects=['chromaKey'] src=stat-counter
  Video 2: start=0 dur=4 in/out=0/4 effects=[]
  textClips: [('OPS API', 2.5, 1.5)]
```

Export: **`3.mp4`, 2,638,625 bytes, produced in 11.9s**; h264 1920x1080, **120 frames**,
duration **4.01s** (matching the ops-set trim), plus **aac 48000 Hz/2ch at mean -24.1 dB**.

Frame sampling (centre row, 2px stride):

| time | expected | white | dark stroke | footage |
|---|---|---|---|---|
| 0.4s | footage only | 0 | 0 | 960 |
| 2.0s | + stat-counter | **73** | 0 | 887 |
| 3.2s | + "OPS API" text (component ended) | **22** | **15** | 923 |

One precise caveat: the `chromaKey` effect is *carried and processed* (it is in the stored
project and the export completed through the effect path) but this scenario cannot prove it
*keys* anything, because the component was rendered with true alpha and contains no green.
Keying from a JSON-carried effect was already proven in Stage 6 with a green clip.

### Deferred

- **Auth** — see the banner above. This is the item that should block any non-localhost use.
- One Chrome per export, concurrency 1; a 4s timeline took ~12s, so long timelines are
  minutes. No cancellation endpoint yet.
- `render_preview_frame` (a single-frame version for agent feedback) is not implemented.
- The ops API has no undo/redo: agent edits do not appear in the editor's history.
- Exports are never pruned; `storage/exports/` grows.

## Stage 11 — MCP server

`apps/mcp-server` — a stdio MCP server exposing the render-service operations as tools for
Claude. Dependencies: `@modelcontextprotocol/sdk` (MIT) and `zod` (MIT).

**Kept independent on purpose**: every tool is a wrapper over one render-service HTTP
endpoint. `src/service.js` is a ~120-line fetch client; nothing imports project-kit,
render-service modules or the editor. The only coupling is the HTTP contract.

Package README (`apps/mcp-server/README.md`) carries the config snippets and the tool
table; this section records what was decided and what was verified.

### The nine tools

`list_components`, `generate_component`, `upload_media`, `list_projects`, `create_project`,
`load_project`, `apply_project_ops`, `export_project`, `service_health`.

Three decisions worth recording:

1. **Long jobs poll inside the tool.** `generate_component` and `export_project` queue the
   job then poll to completion (10 and 30 minute ceilings), returning one answer. Exposing
   `job_status` instead would make the model spend turns polling — and, worse, invite it to
   report success on a `waiting` status.
2. **The op vocabulary lives in `apply_project_ops`'s description** (the `OPS_VOCABULARY`
   block, ~60 lines). It states the two things that cost real debugging time earlier:
   "Video 1" is the **top** track, and `add_text_clip`'s `transform.position` is
   **normalised 0-1** while clip transforms are pixel offsets.
3. **Errors are translated, not forwarded.** A 409 becomes "call `load_project`, then apply
   your operations again"; a 400 becomes the failing op's index, message and project-kit
   code plus the words "nothing was saved".

Conflict handling: `apply_project_ops` does a **load-then-write** — reads the project's
current `updatedAt`, sends it as `expectedUpdatedAt`. That protects against a stale read
inside the call, not against a change landing between two of the model's calls; retrying is
always safe, but retrying after a *successful* call applies the ops twice.

### Service addition: ffprobe on upload

`POST /media` now probes uploads server-side (`apps/render-service/src/probe.js`) and stores
the result in the `media.metadata` column, returning it in the response. Without this a
headless caller would need local ffmpeg to fill in `add_media`'s `metadata` — and a clip
whose media has no metadata has no duration to fall back on. The shape matches exactly what
the browser's `importMedia` produces.

### Gotchas

- **stdout is the protocol channel.** The startup line goes to stderr. One `console.log`
  in a tool handler corrupts the session.
- Importing the SDK by absolute Windows path in a verification script needs a `file:///`
  URL, and the real ESM entry (`dist/esm/client/index.js`), not the package root.
- The first e2e run failed at step 4 with `Cannot read properties of undefined (reading
  'duration')` — render-service was still running the pre-ffprobe code. Restarting it fixed
  it. Reloading a Fastify service is not automatic; check the process, not the file.

### Verification

`npm test` in the package: 5 tests over a real stdio round-trip (all nine tools advertised,
every description substantial, the full op vocabulary documented, required params declared,
both long tools stating that they block). Passes.

End-to-end: `scratchpad/mcp-e2e.mjs` drives the server with the SDK's own `Client` +
`StdioClientTransport`, in the order Claude would, and checks every payload. Exit 0.

| step | tool | result |
|---|---|---|
| 1 | `service_health` | status=ok, redis=up |
| 2 | `list_components` | 6 components |
| 3 | `generate_component` (lower-third) | `16.webm`, 62,271 bytes, 119 frames, downloaded locally |
| 4 | `upload_media` x2 | footage 5.00s audio=true; component 3.97s 1920x1080 — metadata from server-side ffprobe |
| 5 | `create_project` | project + top trackId returned |
| 6 | `apply_project_ops` | media + second track; then footage clip (Video 2, 0-4s) and component clip (Video 1, 0.5-3.5s) |
| 7 | `apply_project_ops` | `brightness` effect on the component clip + an "MCP" text clip at 3.0-4.0s |
| 8 | `apply_project_ops` (invalid) | rejected: `isError=true :: Error: ops[1] (add_clip): Track ghost-track not found [TRACK_NOT_FOUND] — nothing was saved.` |
| 9 | `load_project` | `Video 1: start=0.5 dur=3 effects=["brightness"]`, `Video 2: start=0 dur=4 effects=[]`, `textClips: [{text:"MCP", startTime:3, duration:1}]`, duration 4s |
| 10 | `export_project` | `4.mp4`, 2,438,435 bytes, 16.6s |

`4.mp4`: h264 1920x1080, **120 frames**, duration **4.010667s**, **aac 48000 Hz/2ch**,
`mean_volume -24.1 dB / max_volume -17.5 dB`.

Frame sampling — two scan rows, one across the lower-third's band and one across the
centre, counting white / dark-stroke / footage-gradient pixels:

```
t=0.2  corner=(253,158,13) | lower-third band w/d/g= 0 0 960   | centre w/d/g= 0 0 960
t=2.0  corner=(251,158,12) | lower-third band w/d/g= 0 440 520 | centre w/d/g= 0 0 960
t=3.5  corner=(252,159,13) | lower-third band w/d/g= 0 0 960   | centre w/d/g= 109 7 844
```

Reading it: at 0.2s only footage (the component starts at 0.5s). At 2.0s the lower-third's
**dark plate covers 440 px of its band** — the component is composited over the footage,
with alpha, in its own band and nowhere else. At 3.5s the component has just ended (band
clean again) and the **"MCP" text clip appears in the centre (109 white + 7 stroke px)**.
That is precisely the timeline the MCP tools built, and none of it was touched by hand.

Same caveat as Stage 10, restated: the `brightness` effect is carried and processed (stored
in the project, export completed through the effect path) but a frame count does not prove
its magnitude.

### Deferred

- **Auth — unchanged and still the blocker.** This server adds no auth of its own and calls
  a no-auth localhost service. Registering it in a Claude client means any tool call can
  read or overwrite any project. Must be closed before render-service is reachable beyond
  this machine.
- `upload_media` reads local paths with the privileges of whoever runs the server.
- ~~No `render_preview_frame`~~ — added in Stage 12; the model can now see one frame in ~2s.
- Tool edits bypass undo/redo, and an editor tab with the project open needs a reload.

## Stage 12 — bug-fixing pass

Seven independent items, each committed separately so any one can be reverted alone.

### 1. Still images were registered as video, and export died (4203e7f)

Reproduced exactly: a PNG through `upload_media` then `add_clip` killed the export in the
preparing phase with `{"status":"failed","error":"Video load failed"}`.

The duration was a red herring. ffprobe reports a PNG as a one-frame *video* stream, so
`hasVideo: true`, and project-kit's `add_media` defaulted every item to `type: "video"`. The
editor branches on `MediaItem.type` all through the render path, so the export engine went
looking for a video track that does not exist.

`duration: 0` turned out to be **correct** and was kept: the browser's own
`extractImageMetadata` returns 0, and both the store and project-kit already default an image
clip to 5s. Zero there means "no inherent length", not "probe failed".

- `probeMedia` now returns `{ metadata, mediaType }` and classifies stills. Animated gif/webp
  stay video via a frame-count check.
- `mediaType` lives in a new `media.media_type` column (tolerant ALTER, like `metadata`),
  *not* in the metadata blob — that blob is handed to the editor verbatim as `MediaMetadata`.
- project-kit infers the type from the metadata flags instead of assuming video, which also
  fixes audio-only files landing as video. An explicit `type` still wins.

Verified: PNG background + text overlay exports as 90 frames / 3.000s, the image's blue in
every sampled frame, text only in its window. 4 probe tests, 5 project-kit tests.

### 2. set_audio_fade (6048f12)

The engine already honoured `clip.fade = { fadeIn, fadeOut }` — `audio-engine.ts:367` turns it
into a linear gain envelope (`clip-fade-envelope.ts`) that survives into the export mix. No op
wrote it, so an agent had to pre-process with ffmpeg before uploading. The new op writes
exactly that field; fades exceeding the clip are rejected rather than clamped.

Same 5s clip exported twice, only the fade differing:

| segment | baseline | fadeIn/Out 1.5s |
|---|---|---|
| 0.0-0.4 | -24.2 dB | **-40.4 dB** |
| 0.4-0.8 | -24.1 dB | **-31.9 dB** |
| 2.2-2.8 | -24.1 dB | **-24.1 dB** |
| 4.2-4.6 | -24.1 dB | **-31.9 dB** |
| 4.6-5.0 | -24.1 dB | **-40.4 dB** |

Symmetric, and the hold region matches baseline exactly.

### 3. Float noise on adjacent boundaries (006f1f7)

Not in the editor's action-validator, as assumed — in project-kit's `assertNoOverlap`.
`0.1 + 0.2` is `0.30000000000000004`, so a clip placed at exactly `0.3` was rejected as
overlapping by 5.5e-17 seconds, and callers were nudging boundaries by microseconds:

```
clip A end = 0.30000000000000004
B at 0.3      -> CLIP_OVERLAP
B at 0.300002 -> OK   (the workaround)
```

The test already used strict `<`, which permits exact adjacency; what it lacked was tolerance
for the arithmetic that produced the numbers. Both sides now compare against
`BOUNDARY_EPSILON = 1e-4` — 12 orders of magnitude above the noise, well under a 60fps frame
(16.7ms) or a 48kHz sample (0.02ms), so it cannot mask a real overlap. Shared by add, trim and
move. The other tolerances here (1ms on source length, minimum durations) are deliberate
limits, not float noise, and are untouched.

Verified with clips at 0 / 1.1 / 1.3 / 2.0 (where 1.1+0.2 is 1.3000000000000003), accepted with
no offsets; luminance across the three seams 143.6 / 144.2 / 145.5 with no black frame.

### 4. Sweeping rendered files and old exports (f903d97)

Stage 9's rule ("orphaned when no project mentions the id") does not fit the other two
directories, so each got its own:

- **rendered/** — a finished render may not have been collected yet, so a file goes only when
  nothing references it (a `component_metadata.renderedFileId`, or a mention anywhere in a
  project's JSON, since clips carry `renderedFileId` for re-render) **and** it is past a grace
  period.
- **exports/** — nothing ever references an export. Pure retention: newest N plus anything
  inside the age limit.

`POST /storage/sweep` runs all three with per-directory options; `{"dryRun":true}` reports
without deleting. The same sweep runs at startup, after `listen` and unawaited.

Verified: 4 tests against throwaway dirs (env-overridden paths, so the real tree cannot be
touched); live startup pass took rendered from 20 to 12 files; a dry run listed 6 exports /
39.6 MB with all 8 still on disk; a real sweep removed exactly the two oldest.

`db.js` gained `closeDb()` — Windows will not unlink an open SQLite file, so tests could not
clean up.

### 5. Four small deferred items (2385b2d)

**Byte ranges on `GET /files/:name.webm`**, reusing `/media/:id`'s parser: 206 + content-range,
suffix ranges, 416 with `bytes */size`. Partial content byte-identical to the same slice of the
whole file.

**An actual upload ceiling.** Fastify's `bodyLimit` never applied to `POST /media`: the
octet-stream parser hands the route the raw stream instead of buffering it — which is what
keeps a 2 GB upload out of memory, and also what removed the ceiling. A declared content-length
over the limit is now refused before the bytes travel; a chunked body is cut off mid-stream by
a size limiter; both answer 413 and delete the partial. Resumable uploads are still not
implemented and that is now stated in the README.

**`render_preview_frame`** — one composited PNG at a given time. `VideoEngine.renderFrame` is
what the preview canvas itself uses, so it is the export's compositing path minus encoder and
audio mix: ~2s against ~10s+. Runs as a `"frame"` job on the existing export queue, so still
one Chrome at a time. Preview vs export of the same project at the same timestamps:

| time | preview PNG | exported video |
|---|---|---|
| 0.3s | white 0, blue 960 | white 0, blue 960 |
| 1.5s | white 68, blue 886 | white 67, blue 886 |

Identical bar h264 quantisation against a lossless PNG.

Gotcha worth keeping: **the engine store initialises lazily and nothing triggers it in a
headless tab** (the preview canvas is what normally does), and `initialize()` returns
immediately when an init is already in flight — so waiting on that promise proves nothing. The
hook waits for the store to settle instead.

### 6. logo-reveal-v2 shards (f826f65)

The shards landed at radius 170, which is the ring's own radius, and the ring strokes 16px of
the same colour across 162-178 — so the twelve shards the build-up spends most of its runtime
flying in were buried underneath it. They now land at ring outer edge + half a shard + an 8px
gap (193), derived from the ring geometry, and hold at 0.8 opacity instead of 0.35.

Pink pixels by radius in the held frame at 1.6s:

| band | before | after |
|---|---|---|
| core r0-45 | 1562 | 1562 |
| ring r160-178 | 4661 | 4440 |
| **outside r184-200** | **0** | **3769** |

Two measurement traps: bands guessed rather than measured gave byte-identical counts for two
visibly different frames; and extracting a PNG from a VP9-alpha WebM **without
`-c:v libvpx-vp9`** yields a fully opaque frame, so alpha-based counting measures nothing.
Colour-by-radius with the explicit decoder is what showed the difference.

### 7. Preview effects after reload — fixed (73df62b); swap path proved not to need one

**Stage 7's diagnosis was aimed at the wrong thing.** The editor already has a canonical
hydrator: `syncProjectEffectsBridge` (`project-store.ts:769`) walks every clip and calls
`effectsBridge.deserializeEffects` — the same path undo/redo uses, and its own comment says it
is "what makes undo/redo (and project load) restore the graded look". **`loadProject()` already
calls it** (`project-store.ts:1770`).

What Stage 7 tried instead was replaying effects through `applyVideoEffect()`, which *also*
drives the ChromaKeyEngine — hence the blanked frame. "The Effects card does more than the
bridge" was true but irrelevant: the supported hydration path never goes near that code.

Two concrete gaps found instead:

- Both sync helpers **return early and silently when `effectsBridge.isInitialized()` is
  false**, and `getEffectsBridge()` is synchronous with fire-and-forget background init
  (`effects-bridge.ts:1299`). On a reload the project can be restored before that init
  resolves, in which case the sync no-ops and **nothing ever re-runs it**. That fits every
  symptom: right in-session, wrong after reload, export always fine.
- `replaceMediaAsset` calls `set({ project })` with **no** `syncClipEffectsBridge` — the
  media-swap half of the bug.

#### Outcome (73df62b)

**The gate falsified my own hypothesis, and that was the point of having one.**

Instrumented probes on a real reload — the one that shows *Recover Your Work* — printed:

```
[S12-PROBE] initializeEffectsBridge resolved
[S12-PROBE] recoverFromAutoSave called
[S12-PROBE] after recover: clip=297a04f4 storedEffects=["chromaKey"] bridgeEffects=0 isInitialized=true
```

- `isInitialized=true` — the bridge is ready. **Not a timing race.**
- No sync line follows, because a reload never goes through `loadProject`. It goes through
  **`recoverFromAutoSave`**, which set the project and never called the sync. Of the three
  paths that open a project (`createProject` 1716, `loadProject` 1770, `recoverFromAutoSave`
  3047) it was the only one missing it.

So the planned `EditorInterface` change would have been a **no-op** — bridge init resolves
*before* recovery runs — and it was dropped. Had the gate been skipped, that no-op would have
shipped "verified" against a path that was never broken.

The fix is the single call `loadProject` already makes, through the same `deserializeEffects`
route undo/redo uses — not `applyVideoEffect`, which is what blanked the frame in Stage 7.

Same project, same playhead (00:02:12) throughout:

| | band row (green / gradient / plate) | centre row |
|---|---|---|
| before reload (`loadProject`) | 0 / 521 / 439 | 0 / 960 |
| after reload, **pre-fix** | **514** / 7 / 439 | **960** / 0 |
| after reload, **post-fix** | **0 / 521 / 439** | **0 / 960** |

Post-fix matches the baseline digit for digit, and the plate is still at 439 — the effect is
applied, not over-applied, which was Stage 7's failure mode.

True-alpha regression (transparent component, no chromaKey at all): band 0 / 520 / 440 both
before and after a recovery. 80 project-store tests pass.

#### The media-swap half: fix withheld on evidence

The approved plan also had `syncClipEffectsBridge` added to `replaceMediaAsset`. Reading the
code first showed why that would be another no-op: `handleRegenerate` calls
`replaceMediaAsset(clip.mediaId, file)`, which rewrites the **media item only** — clip ids and
`clip.effects` are untouched, so the bridge entry (keyed by clip id) stays valid across a swap.
The Stage 7 observation was most likely the reload bug seen after a re-render, or a stale
decode cache, which is a different mechanism.

Not added. The swap test below then confirmed it was unnecessary rather than untested.

#### Gotcha: sample only after the composite settles

A first post-fix reading showed `green 0` **and** `plate 0` — which looks like the Stage 7
over-keying failure. It was neither: the preview composites asynchronously and the component
layer had not been drawn yet. A whole-frame scan found the plate and text present a moment
later. Assert that the expected feature *is* there, not merely that the artefact is gone.

#### Swap test: fix 2 was correctly declined (it would have been a no-op)

Run through the real UI path, not a simulation: a green `lower-third` clip carrying genuine
Component Library metadata (`source: "component-library"`, componentId, props, background
`#00ff00`) plus a `chromaKey` effect, selected in the timeline, title changed to
"SWAPPED TITLE", **Re-render clip** pressed — so `handleRegenerate` ran for real, including
`replaceMediaAsset`, `saveMediaBlob`, `uploadMedia` and `updateClipMetadata`.

Preview at the same playhead (00:02:12), before and after the swap:

| | band row (green / gradient / plate) | centre row |
|---|---|---|
| before swap | 0 / 521 / 439 | 0 / 960 |
| after swap | 0 / 521 / 439 | 0 / 960 |

Identical — the clip stays keyed across a media swap, with **no** `syncClipEffectsBridge`
added to `replaceMediaAsset`. Which is what reading the code predicted: the swap rewrites the
media item only, so the bridge entry (keyed by clip id) is never invalidated.

Identical numbers are also how a test that did nothing would look, so the swap was proved
independently. Server-side after the re-render: `component-metadata` for that mediaId now
reads `props.title: "SWAPPED TITLE"`, `renderedFileId: "20.webm"`; the media row is
`lower-third-SWAPPED TITLE.webm` at 50,925 bytes, exactly `20.webm`'s size. And the preview
matches the new render's glyphs, not the old one's:

| | white glyph pixels in the band |
|---|---|
| old render (`green-lt.webm`, "CHROMA GATE") | 2597 |
| new render (`20.webm`, "SWAPPED TITLE") | 2709 |
| **preview after swap** | **2733** |

2733 sits with the new render (the ~1% difference is chroma edge softness eroding glyph
antialiasing over the gradient), and nowhere near the old render's 2597.

**Verdict: fix 2 is unneeded, not merely untested.** The Stage 7 note that the swap also broke
the preview was the reload bug observed after a re-render.

#### Export regression, chroma path (Stage 4/6 equivalent)

`19.mp4` — h264 1920x1080, **150 frames, 5.000s**:

```
t=0.5  band[green=0  white=0    plate=0     grad=76800]  centre[green=0 grad=19200]
t=2.0  band[green=8  white=2700 plate=28920 grad=45172]  centre[green=0 grad=19200]
t=3.0  band[green=12 white=2702 plate=28926 grad=45160]  centre[green=0 grad=19200]
t=4.5  band[green=0  white=0    plate=0     grad=76800]  centre[green=0 grad=19200]
```

Gradient everywhere the component is absent, the component's plate and glyphs where it is,
no black rectangle, and the centre row never sees green. The 8-12 stray green pixels out of
76,800 sampled band pixels (0.01%) are keying edge antialiasing — Stage 7's run reported 0
with the Effects card's default params, where this used tolerance 0.35 / edgeSoftness 0.1 set
through the ops API. Different params, same conclusion. White glyphs at 2700 also confirm the
export used the swapped media.

## Stage 13 — turbulent-background (hybrid presets + custom image)

A seventh component: a still background warped by a churning turbulence field, looping
seamlessly, rendering 9:16 by default. Five bundled brand gradients or a caller-supplied
image.

### Resolution: a render-invocation flag, plus two hardcoded defaults

The scene layer turned out to be entirely resolution-agnostic — nothing in `src/projects/` or
`src/scenes/` mentions a size, and `makeProject` takes none. The canvas size comes from one
place, `size: new Vector2(width, height)` in the harness, fed from `?width`/`?height`, fed
from `--width`/`--height`. So no scene change was needed for 9:16.

Both *callers*, though, hardcoded 1920x1080: `parseArgs` in `render.mjs` and
`config.defaultWidth/Height` in `POST /render`. Components can now declare their own frame
size in `meta.json` (`defaultWidth` / `defaultHeight`), mirroring how `durationParam` already
lets a component name its own duration source. Resolution order is explicit request, then
the component's default, then the service's. Since `listComponents` returns the whole meta
object, `GET /components` exposes it and the MCP agent sees a 9:16 component without being
told. Verified: `turbulent-background` renders 1080x1920 with no flags, `lower-third` still
renders 1920x1080.

### Shaders are gated, and the gate is silent

`Node.shaders` exists in Motion Canvas 3.17.2 and gives true per-pixel displacement on the
GPU. Getting it to actually run took four wrong hypotheses, all eliminated by measurement:

| hypothesis | test | result |
|---|---|---|
| WebGL2 unavailable under `--disable-gpu` | probed 3 flag sets in headless Chrome | **false** — webgl2 present in all three |
| shader fails to compile | compiled the source standalone, printed the info log | **false** — compiles clean |
| the node cache freezes the output | read `Node.render`; `shaderCanvas` is not `@computed` | **false** — the pass runs every frame |
| `Layout` overrides positioning | `layoutEnabled()` defaults to false | **false** |

The actual cause is in `parseShader` (`2d/lib/partials/ShaderConfig.js`):

```js
if (!useScene().experimentalFeatures && result.length > 0) {
    result = [];   // reported only through Motion Canvas's own logger
}
```

Shaders are **silently discarded** unless the project sets `experimentalFeatures: true`, and
the one clue goes to a logger the headless Renderer never surfaced. A constant-red probe
shader was what finally proved the pass was not running at all (centre pixel stayed
gradient-coloured, then went `(255,0,0)` once the flag was set).

Two lessons worth keeping:

- **The harness now forwards Motion Canvas's logger** (`project.logger.onLogged` -> console,
  error-level entries also fail the render). Without it a swallowed scene error surfaced only
  as "No frames were written". It paid for itself within minutes — the next bug reported
  itself as a one-line message instead of another hour of bisection.
- **A file-size difference is not evidence of an effect.** The displaced render was 327 KB
  against 170 KB undisplaced, which looked like proof the shader worked. It wasn't:
  `displacementAmount` also fed the bleed margin, so the two renders had different zoom. The
  red-probe test is what settled it.

### Cache bounding boxes ignore `clip`

The first working design put the over-sized image inside a frame-sized `Rect` with `clip` and
attached the shader there. Zoom and pan then had *no effect on the output* while the scene's
own arithmetic was provably correct (logged `pan: -270`, `drawScale: 0.75`). The reason:

```
[probe] rect cacheBBox: 2068.5 3072   world: 1085 1925
```

A node's cache bbox grows to contain its children even when the node clips them, so the
shader's source texture was the whole picture rather than the frame — it always sampled the
entire image, which is exactly why pan/zoom vanished, and it also broke the frame-space
premise the turbulence relies on.

Fix: `composeFramed()` flattens the positioned background into a frame-sized texture once per
render (a 2D canvas plus `toDataURL`), and the shader hangs off an `Img` that is exactly
frame-sized. `sourceUV` and `screenUV` then agree by construction.

That change surfaced one more thing: Motion Canvas's `loadImage` does **not** set
`crossOrigin`, so a remote custom image tainted the composing canvas and `toDataURL` threw
`SecurityError`. Its `Img` node does set it, which is why the node path never hit this. The
scene now loads images itself with `crossOrigin = "anonymous"`; render-service already replies
`access-control-allow-origin: *`.

### Seamless loop

The time axis is a **circle** through 4D gradient noise: `(x, y, r*cos(theta), r*sin(theta))`
with `theta` sweeping 0..2pi over `durationInSeconds`. Two or three dimensions cannot close a
loop by scrolling; four can, exactly. The noise is hand-written GLSL (Perlin-style gradients,
three octaves) rather than a vendored simplex implementation, so there is no third-party
licence to carry. Scaling the point per octave scales the circle too, which is still a closed
circle, so periodicity survives the fBm.

### Verification

Frame size 1080x1920 throughout. Measured on the final code, not an earlier revision.

**Seam** — 6.0s at 30fps, so frame 180 is exactly one period:

```
frame 0 vs   1: 0.6294        frame 0 vs 179: 0.6207
frame 0 vs  60: 3.0395        frame 0 vs 180: 0.0000   <- exact
frame 0 vs 120: 2.6095        frame 0 vs 181: 0.0000
```

**Warping, not brightness** — frame 0 vs frame 60: mean luminance 185.52 -> 185.02 (delta
0.50) while per-row x-shifts read `[-21,-6,-8,-13,-9,-14,-8,2,3]`, a 24px spread. Rows move by
differing amounts and the level stays put: a geometric warp, not a level change.

**Framing control** — measured with a non-periodic noise pattern carrying landmarks, because
the brand gradients have almost no horizontal structure and a first attempt with a
checkerboard was degenerate (at scale 1.6 its on-screen cell is 18px, so a 540px pan is
exactly 30 cells and the pattern is self-similar under it):

```
offsetX -0.5 vs +0.5 : best alignment at 540 px, mean|diff| 0.00   (predicted 540)
offsetY  0.0 vs +0.5 : best alignment at 480 px, mean|diff| 0.00   (predicted 480)
zoom 1.0 vs 2.0      : on-screen pattern period 22 px -> 45 px     (predicted 2.00x)
```

Every other alignment offset sits near 58, so these are unambiguous minima.

**Turbulence invariance across zoom** — displacement measured by block-matching a warped
frame against an undisplaced render of the same framing:

```
scale 1.0: |displacement| per block [0,1,2,2,4,8]  median 2.0 px  max 8 px
scale 2.0: |displacement| per block [0,2,2,3,4,8]  median 2.5 px  max 8 px
```

Equal in *screen* pixels at both zooms, which is what computing the noise in frame space
buys. Image-space noise would have doubled it.

**Preset consistency** — brand-1 vs brand-4, identical params: mean|diff| 3.04 vs 3.68, frame
luminance 185.5 vs 184.4. The row-shift estimator reads lower on brand-4 (median 2px vs 8px)
because that image carries less horizontal detail to correlate, not because the motion
differs: the displacement field is a function of frame position only and is identical by
construction.

**Custom image** — uploaded to render-service and rendered by URL; warped (frame 0 vs 15
mean|diff| 0.897 on a smooth gradient). `custom` with no image fails with the intended
message rather than falling back:

```
Error: backgroundPreset is "custom" but no image was supplied. Set the "image" parameter to a
URL the renderer can fetch (http/https or data:), for example http://127.0.0.1:3001/media/<mediaId>.
```

**Timing** — 182 frames at 1080x1920: 35s for brand-1 (192 ms/frame, 5.2 fps) and 54s for
brand-4 (297 ms/frame). The spread between presets is PNG encoding, not the shader.

**Regression** — `lower-third` renders 119 frames at 1920x1080 in 6s, unchanged by the
harness and `render.mjs` edits.

### Per-pixel vs coarse mesh-warp: not benchmarked head to head

The plan promised a benchmark of both. I did not build the mesh-warp variant, and the reason
is in the numbers already collected: before `experimentalFeatures` was set, the shader was
silently skipped, which accidentally produced a clean control — those renders cost ~207
ms/frame at this resolution against ~192 ms/frame with the shader running. **The GPU pass is
free relative to PNG encoding, which dominates the render.** A coarse mesh-warp could only be
slower and lower quality, so building one to lose a benchmark was not worth the time. Flagged
rather than quietly dropped; happy to add it if the comparison matters for its own sake.

### Deferred

- `displacementAmount` is a multiplier on a zero-centred noise field, so the default 45 moves
  pixels by roughly 2-16px rather than 45. Documented in the param description; normalising it
  so the number means pixels would be a nicer contract.
- Displacement sampling is edge-clamped, so the outermost few pixels can smear slightly at
  high strength. Invisible on these gradients; a bleed margin was dropped when the framing
  moved into `composeFramed`, since the composed texture is exactly frame-sized.
- The service still type-checks params only (`media` is "must be a string"). Cross-field rules
  like "custom requires image" live in the scene, so they fail at render time rather than being
  rejected by `POST /render`. A `requiredWhen` rule in `meta.json` would move it earlier.

## Stage 14 — orbit-headline (parametric Bodymovin reconstruction)

An eighth component, rebuilt from `Simple headline.json` (After Effects via Bodymovin, 168
frames at 30fps, 1920x1080). Parametric, not a frame replay: every curve is a normalised
keyframe table ported from the export, so any duration keeps the source's timing character.

### What the file actually does, which is not what the layer names suggest

Two findings changed the spec before any code was written.

**It is two phrases in sequence, not one headline.** Four text layers: `You` (frames 0-84) and
`talk` (3.5-84), then `I'll` (84-168) and `listen` (84-168).

**The words never rotate.** Composing each word's full parent chain gives a world rotation of
~0 for the entire phrase:

```
t/dur:      0%     5%    10%    20%    30%    50%    70%    90%
'You':    0.00   0.02   0.01   0.00   0.00  -0.00  -0.00  -0.02
'listen':-0.00   0.02   0.01   0.00   0.00  -0.00  -0.00  -0.02
```

The 84 baked per-frame rotation keys on each text layer (15 -> 9.077 -> 6.044 -> ... ->
-59.815) are *exactly the counter-rotation of the parent nulls* — AE keeping each word upright
while the rig swings it. The giveaway is that all four words share one curve offset by a
constant: `You` = `listen` + 14, to the last decimal. So the "damped settle converging to zero"
those numbers look like is an artefact of the rig, and fitting a spring to it would have been
fitting nothing. What is actually visible is **positional**: each word travels a shallow arc
(net 130-264px) because its parent null rotates -29deg -> 0 -> +40deg about the group centre,
under a two-null group zoom of 0.969 -> 1.612 and a further 0 -> 27.833deg group rotation that
likewise only moves words rather than turning them.

Also inert: the `Plague of null layers.` / `© 2022 Battle Axe Inc` pseudo-effects on the nulls
are watermark data from the plugin that built the rig.

### Exact bezier port rather than approximated easing

Every property in a Lottie export is a keyframe track with bezier handles, and porting that
evaluation costs about thirty lines (`src/lib/curves.ts`). Fitting named easings instead was
measurably worse — for the per-word scale-in, handles `cubic-bezier(0.001, 0, 0.156, 1)`:

| candidate | RMS | max error |
|---|---|---|
| **exact bezier (ported)** | **0.0000** | **0.0000** |
| easeOutCubic | 0.0272 | 0.0591 |
| easeOutQuart | 0.0588 | 0.0976 |
| easeOutExpo | 0.1284 | 0.2232 |
| easeOutBack | 0.1631 | 0.2557 |
| easeOutElastic | 0.3565 | 0.9775 |

The orbit sweep is worse still for named easings: two segments, `(0.001,0,0,1)` then
`(1,0,1,1)`, whose closest named fit is *linear* at RMS 0.174. Bisection rather than Newton
in the solver, because handles like `(1, 0, 1, 1)` have vanishing derivatives at the ends.

### Font

`Widescreen-Bold` is Battle Axe commercial and absent from the render environment. Probing
with width comparison rather than `document.fonts.check()` — which returns `true` for every
family, including nonsense — showed Widescreen falling back to monospace metrics while
`Archivo Black` (665px for the probe string), `Arial Black` (683) and `Montserrat` (676) are
real. Default is `Archivo Black`, the closest wide heavy grotesque, with an
`"Arial Black", sans-serif` fallback. Condensed faces (Anton 490, Oswald 499, Impact 518) were
the wrong direction.

### Design decisions

- **Phrases in one text param.** The vocabulary has no array type, so `|` marks a phrase
  break: `"You talk | I'll listen"` is the original, `"Ship it"` is one phrase.
- **`settleAmount` defaults to 0**, so the default output matches the source's upright words.
  Non-zero adds a decaying rotational wobble for anyone who wants the "orbit" reading.
- **Per-phrase fit-to-frame**, measured from the laid-out text. One global scale is set by the
  longest phrase, which leaves a one-word phrase rendering tiny beside a three-word one.
- Stagger is capped at a quarter of the phrase divided by the word count, so a short duration
  cannot push the last word's entry past the point where it still has time to arrive.

### Verification

**Curve-fit accuracy** — the component's tables against the JSON's baked values, at matched
proportional timestamps (source frame `ip + (op - ip) * p`), two words each:

| quantity | max abs error |
|---|---|
| orbit sweep, `You` and `listen` | **0.000e+00 deg** |
| per-word scale-in, `You` and `listen` | 1.11e-16 x |
| group zoom (both nulls multiplied) | 2.32e-13 x |
| group rotation | 0.000e+00 deg |
| word world rotation vs component's 0 | 1.75e-02 deg |

The last row is the source's own bake residual (its composed chain wobbles by up to 0.017deg),
not the component's error — the component is exactly 0.

**Generalisation** — different word counts, phrase counts and durations, frame-sampled:

| render | frames | behaviour |
|---|---|---|
| source, 5.6s, 2x2 words | 170 (168+2) | phrase swap at t=0.5: ink 48005 -> 36504, centre jumps 964 -> 1025 |
| `Ship it fast`, 3.0s, 1 phrase | 92 (90+2) | three staggered entries, ink 11621 -> 110189 |
| `Design \| Build \| Ship it now`, 9.0s, 3 phrases | 272 (270+2) | swaps at t=0.35 and t=0.70, ink dropping 38263 -> 22869 and 47972 -> 69059 |
| four long words, 4.0s | 122 | fit engages: max bbox 1552x723 inside 1920x1080, never touching an edge |

Frame counts are exactly `duration * 30 + trailing`, so the timing is proportional rather
than clipped.

**Two defects caught by that sampling and fixed:**

- The final frame rendered **empty**. The visibility window used `progress < phraseEnd`, and
  the last phrase's end is exactly 1, so everything vanished on the last frame. The final
  phrase now runs inclusive of 1.
- Single-word phrases rendered much smaller than multi-word ones, because the fit was computed
  once over every word in the headline. Now per phrase.

`lower-third` still renders 89 frames at 1920x1080, unchanged; the service catalogue lists all
eight components.

### Deferred

- Word layout is a fixed diagonal step (0.82 x fontSize across, 0.85 down) derived from the
  source's hand-placed positions. Longer phrases therefore shrink to fit rather than rewrapping;
  a wrap-to-lines mode would suit long headlines better.
- The source's last two frames dip (linear null 125% -> 120%, eased 130% at 167.5). The tables
  keep it, so the reconstruction inherits a one-frame scale dip at the very end.
- The 3.5-frame entry offset of `talk` puts its orbit mid-key at 52.2% of its own span rather
  than 50%; the component uses 50% for every word. Difference is under half a degree.

## Stage 15 — `-Rep` suffix on custom components

Renamed the two components built in Stages 13 and 14:

| before | after (id) | after (name) |
|---|---|---|
| `turbulent-background` | `turbulent-background-Rep` | Turbulent Background Rep |
| `orbit-headline` | `orbit-headline-Rep` | Orbit Headline Rep |

The request named the first one `turbulent-bg-new`; no such id existed — the actual id was
`turbulent-background`, and that is what was renamed.

Each rename touched: the component directory (which `listComponents` requires to equal the
id), `meta.json`'s `id`, `name` and `project`, the project and scene filenames, the scene's
bundled-asset import path (`components/turbulent-background-Rep/assets/`), the `?scene` import
inside the project, the harness import and `PROJECTS` key, the `vite.config.ts` project list,
and two comments that named the old id. Uppercase in an id is safe: nothing on the
componentId path lowercases or sanitises it (the only `toLowerCase` in the service is on a
file extension).

Historical stage prose above still refers to the old ids, which is left as-is — those sections
record what was built at the time, and rewriting them would falsify the log. The convention
itself is at the top of this file.
