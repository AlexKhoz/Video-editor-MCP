# Browser Video Editor Prototype

A multi-track browser video editor — a fork of [OpenReel Video](https://github.com/Augani/openreel-video)
— with a **Component Library** of programmatic animated components rendered by
[Motion Canvas](https://github.com/motion-canvas/motion-canvas).

Pick an animated component, fill in its parameters, and a self-hosted render service turns it into a
video file that lands in the editor's media library as an ordinary clip: drag it onto a track, trim it,
composite it over other footage, export.

Everything is open source and self-hosted. No paid SaaS, no cloud APIs, no API keys. Storage is the
local filesystem; the job queue is Redis in Docker.

## Layout

```
apps/editor                  fork of OpenReel Video (MIT) + the Component Library panel
apps/render-service          Fastify + BullMQ: renders, storage API, ops API, exports
apps/mcp-server              MCP server exposing all of it as tools for Claude
packages/component-library   Motion Canvas scene-components + meta.json param schemas
packages/project-kit         pure-JSON project manipulation (no browser, no DOM)
infra/docker-compose.yml     Redis (job queue)
storage/rendered/            rendered component files
storage/media/               uploaded media, keyed by mediaId
storage/exports/             finished MP4 exports
storage/video-editor.sqlite  SQLite: projects, media, component_metadata
NOTES.md                     engineering notes, findings and verification per stage
```

Data flow:

```
Component Library panel
  -> POST /render { componentId, props, background }        (render-service)
  -> BullMQ job on Redis
  -> worker runs packages/component-library/scripts/render.mjs
       (Vite dev server -> headless Chrome -> Motion Canvas image-sequence exporter -> ffmpeg)
  -> storage/rendered/<jobId>.webm
  -> panel polls GET /render/:jobId, downloads the file, calls the editor's importMedia()
  -> the clip carries componentId + props + renderedFileId in clip.metadata, so it can be re-rendered
```

## Prerequisites

| Tool | Why | Notes |
|---|---|---|
| Node.js 18+ | everything | built and tested on 22.14 |
| pnpm | the editor workspace | the fork pins `pnpm@11.7.0` via `packageManager` |
| npm | render-service, component library, MCP server | standalone npm projects, outside the pnpm workspace |
| Docker + Compose | Redis for the job queue | Docker Desktop must actually be running |
| ffmpeg on PATH | encodes the rendered frames | tested with 8.1.1 |
| Chrome / Chromium / Edge | headless renderer | already-installed browser; override with `CHROME_PATH` |

## Run it from scratch

### The lazy way

```powershell
.\start-all.ps1
```

Starts Docker Desktop if it is not running, brings up Redis, opens one Windows Terminal window
with four titled tabs (Render API, Render Worker, Export Worker, Editor), then waits until
`/health` reports `{"status":"ok","redis":"up"}` and prints a summary. `start-all.bat` is a
double-click wrapper. Tear it down with `.\stop-all.ps1`, which stops the four node processes,
closes their tabs and runs `docker compose down`.

The rest of this section is what those scripts do, for when you want the processes yourself.

### One-time install

```bash
cd packages/component-library && npm install
```

```bash
cd apps/render-service && npm install
```

```bash
cd apps/mcp-server && npm install
```

```bash
cd apps/editor && pnpm install --filter "@openreel/web..."
```

### Cold start

One detached container plus **four long-running processes**, each in its own terminal, in this
order. All paths are relative to the repo root. (These blocks use `&&`; PowerShell 5.1 does not
support it — run the `cd` and the command as two lines there, or use Git Bash.)

**1. Redis** — the job queue. Detached, so this terminal is free afterwards.

```bash
docker compose -f infra/docker-compose.yml up -d
```

Docker Desktop must actually be running. Check with `docker ps`: `video-editor-redis` on
`127.0.0.1:6379`.

**2. render-service API** — HTTP on <http://127.0.0.1:3001>.

```bash
cd apps/render-service && npm start
```

Verify: `curl http://127.0.0.1:3001/health` reports `"status":"ok"` and `"redis":"up"`.

**3. Component render worker** — consumes `/render` jobs.

```bash
cd apps/render-service && npm run worker
```

Separate from the API because a render occupies a headless Chrome and an ffmpeg for tens of
seconds. Without it, renders queue forever and `/health` still says ok.

**4. Export worker** — consumes `/projects/:id/export` jobs (the ops API and MCP export path).

```bash
cd apps/render-service && npm run export-worker
```

It drives the real editor in a headless Chrome, so the dev server below must be up **before an
export job runs** — not before this worker starts. Override its target with `EDITOR_URL`.

**5. Editor dev server** — <http://localhost:5173>.

```bash
cd apps/editor && pnpm --filter @openreel/web dev
```

Open it, pick a format, and the editor loads. The **Component Library** tab is in the left rail;
**Projects** is the server-side project list.

Only doing manual editing in the browser? Steps 1, 2, 3 and 5 are enough — step 4 is only for
headless exports.

## Driving it from Claude (MCP)

```bash
claude mcp add video-editor --scope user -- node E:/Replika/Tools/video-editor/apps/mcp-server/src/index.js
```

Nine tools — render a component, upload footage, create a project, edit the timeline, export an MP4 —
all over the render-service HTTP API. Tool list, `claude_desktop_config.json` snippet and the
concurrency story: [apps/mcp-server/README.md](apps/mcp-server/README.md).

## The end-to-end flow

1. Import a video (Media tab) and drop it on a track; trim it with **Trim end to playhead (W)**.
2. Open **Component Library**, pick a component, set its params, press **Generate**. The render takes
   ~20s and the result appears in Project Media.
3. Hover the media card and press **Add to timeline**. Note two OpenReel behaviours: clips insert at
   the **playhead**, and **"Video 1" is the topmost layer** — put the component above the footage.
4. That's it — components render with a **true alpha channel**, so the animation composites over the
   clip below with no further step.
   *Chroma fallback:* set `DEFAULT_BACKGROUND` to `CHROMA_BACKGROUND` in `ComponentLibraryPanel.tsx`
   to render on `#00ff00` instead, then select the clip, open **Effects** and **double-click** the
   *Chroma Key* card. Needed on OpenReel builds without the Stage 7 alpha fix. (Use the effect card,
   not the inspector's Green Screen toggle — see NOTES.md.)
5. Select a generated clip and reopen **Component Library** to edit its params and **Re-render clip**;
   the clip keeps its effects, trim and position.
6. **Export** from the toolbar.

Transitions between two clips are a different job: OpenReel has 24 native transition types
(`crossfade`, `wipe`, `flash`, …) in the **Transitions** tab, and those blend outgoing and incoming
footage properly. This library is for overlays and graphics, not transitions.

## Tests

```bash
cd apps/render-service && npm test
```

Renders `stat-counter` through the real API and checks the file exists, is non-empty, matches the
reported byte count, downloads as `video/webm` and starts with WebM's EBML magic. Needs Redis, ffmpeg
and Chrome.

```bash
cd packages/component-library && node scripts/render.mjs --component stat-counter \
  --props '{"label":"Active users","targetNumber":1250,"durationInSeconds":3}' \
  --out ../../storage/rendered/demo.webm
```

Renders a component straight from the CLI, bypassing the queue. Add `--background "#00ff00"` for a
chroma render; omit it for a transparent (VP9 + `yuva420p`) one.

```bash
cd packages/project-kit && npm test    # 13 tests, pure JSON, no services needed
cd apps/mcp-server && npm test         # 5 tests over a real stdio round-trip
```

## Known limitations

Documented with evidence in [NOTES.md](NOTES.md):

- **The preview does not apply clip effects after a project reload** (or after a re-render swaps a
  clip's media). The exported video is correct; only the live preview is affected. Re-applying the
  Chroma Key effect in-session refreshes it. The cause is pinned — the preview reads effects from an
  in-memory bridge that nothing rehydrates (see Stage 7 in NOTES.md) — but the obvious fix made the
  preview worse and was reverted, so this is still open.
- **No authentication anywhere.** Every project on the server is readable and writable by anyone who
  can reach render-service — including through the ops API and the MCP server. That is deliberate
  while everything is localhost-only, and it is the one item that **must be closed before any of this
  is reachable from another machine**.
- **Last-save-wins by default.** The editor and the MCP server send the `updatedAt` they last saw and
  get a 409 on a conflict, but a client that omits the guard still overwrites.
- Uploads are whole-file and not resumable: an interrupted upload starts over. The ceiling is
  `UPLOAD_LIMIT_BYTES` (2 GB); over it the server answers **413** and deletes the partial file,
  rather than filling the disk quietly. Exports run one headless Chrome at a time, with no
  cancellation.
- Disk is swept on service start and on `POST /storage/sweep` (send `{"dryRun":true}` to see
  what would go). Media orphaned by editing, unreferenced component renders older than
  `RENDERED_GRACE_MINUTES` (60), and exports beyond the newest `EXPORT_KEEP_COUNT` (10) and
  older than `EXPORT_MAX_AGE_HOURS` (168) are removed. `SWEEP_ON_START=0` disables the
  startup pass.
- Edits made through the ops API or MCP bypass the editor's undo/redo, and an open editor tab needs a
  reload to see them.

## Licences

OpenReel Video is MIT. Motion Canvas is MIT. Added dependencies: Fastify (MIT), BullMQ (MIT), ioredis
(MIT), puppeteer-core (Apache-2.0), `@modelcontextprotocol/sdk` (MIT), zod (MIT). Redis 7 is
BSD-3-Clause. SQLite is via `node:sqlite`, in Node core — no dependency.
