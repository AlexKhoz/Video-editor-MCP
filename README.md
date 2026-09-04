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
apps/render-service          Fastify + BullMQ: componentId + props -> rendered webm
packages/component-library   Motion Canvas scene-components + meta.json param schemas
infra/docker-compose.yml     Redis (job queue)
storage/rendered/            rendered output files
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
| npm | render-service + component library | both are standalone npm projects |
| Docker + Compose | Redis for the job queue | Docker Desktop must actually be running |
| ffmpeg on PATH | encodes the rendered frames | tested with 8.1.1 |
| Chrome / Chromium / Edge | headless renderer | already-installed browser; override with `CHROME_PATH` |

## Run it from scratch

Four terminals (or run the first three in the background).

**1. Redis**

```bash
docker compose -f infra/docker-compose.yml up -d
```

**2. Component library dependencies** (once)

```bash
cd packages/component-library && npm install
```

**3. Render service**

```bash
cd apps/render-service && npm install && npm start
```

```bash
cd apps/render-service && npm run worker
```

The API listens on <http://127.0.0.1:3001>; `GET /health` should report `"redis":"up"`. Server and
worker are separate processes because a render occupies a headless Chrome and an ffmpeg for tens of
seconds.

**4. The editor**

```bash
cd apps/editor && pnpm install --filter "@openreel/web..." && pnpm --filter @openreel/web dev
```

Open <http://localhost:5173>, pick a format, and the editor loads. The **Component Library** tab is in
the left rail.

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

Renders `animated-text` through the real API and checks the file exists, is non-empty, matches the
reported byte count, downloads as `video/webm` and starts with WebM's EBML magic. Needs Redis, ffmpeg
and Chrome.

```bash
cd packages/component-library && node scripts/render.mjs --component animated-text \
  --props '{"text":"Hello","color":"#ffcc00","durationInSeconds":2}' \
  --out ../../storage/rendered/demo.webm
```

Renders a component straight from the CLI, bypassing the queue. Add `--background "#00ff00"` for a
chroma render; omit it for a transparent (VP9 + `yuva420p`) one.

## Known limitations

Documented with evidence in [NOTES.md](NOTES.md):

- **The preview does not apply clip effects after a project reload** (or after a re-render swaps a
  clip's media). The exported video is correct; only the live preview is affected. Re-applying the
  Chroma Key effect in-session refreshes it. The cause is pinned — the preview reads effects from an
  in-memory bridge that nothing rehydrates (see Stage 7 in NOTES.md) — but the obvious fix made the
  preview worse and was reverted, so this is still open.
- **Alpha is fixed** (Stage 7): a one-line `alpha: true` on the export decoder's mediabunny sink means
  transparent (VP9 `alpha_mode=1`) clips now composite over lower tracks in the export instead of
  arriving as a black rectangle; the preview always handled them. Components are still rendered on
  chroma green because that is the path Stages 4-6 verified end to end — switching the panel to true
  transparency is now a one-line change, pending re-verification.

## Licences

OpenReel Video is MIT. Motion Canvas is MIT. Added dependencies: Fastify (MIT), BullMQ (MIT), ioredis
(MIT), puppeteer-core (Apache-2.0). Redis 7 is BSD-3-Clause.
