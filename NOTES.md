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
