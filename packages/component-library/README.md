# @video-editor/component-library

Motion Canvas scene-components, rendered to **transparent WebM (VP9, `yuva420p`)** for the video
editor's Component Library panel. Standalone npm project — no workspace coupling, so it can be lifted
out of this repo unchanged.

## Components

| id | params (`type` from OpenReel's `MotionVariable` vocabulary) |
|---|---|
| `animated-text` | `text: text`, `color: color`, `durationInSeconds: number` |
| `logo-reveal` | `primaryColor: color`, `durationInSeconds: number` |
| `color-transition` | `fromColor: color`, `toColor: color`, `durationInSeconds: number` |

Each one has a `components/<id>/meta.json` describing its params, defaults and ranges — that file is
the contract the editor UI and render-service read.

## Render one component

```bash
node scripts/render.mjs --component animated-text \
  --props '{"text":"Ship it","color":"#ffcc00","durationInSeconds":2}' \
  --out ../../storage/rendered/demo.webm
```

Flags: `--component` `--props` `--out` `--fps` (30) `--width` (1920) `--height` (1080)
`--keep-frames`.

Requirements: `ffmpeg` on PATH, and an installed Chrome/Chromium/Edge (`puppeteer-core` uses the
system browser — override the path with `CHROME_PATH`). Everything runs locally; no cloud services.

## Preview while authoring

```bash
npm run dev
```

Opens the Motion Canvas editor at <http://localhost:9000> with all three projects, using each
component's default props.

## How rendering works

Motion Canvas has no CLI renderer, and its `@motion-canvas/ffmpeg` exporter is hardcoded to MP4 /
`yuv420p` (no alpha). So `scripts/render.mjs` assembles the pipeline itself: a programmatic Vite dev
server, headless Chrome loading `render-harness.html`, Motion Canvas's built-in image-sequence
exporter writing PNGs with alpha through Vite's HMR channel, then ffmpeg muxing them to VP9 +
`yuva420p`. See the Stage 2 section of the repo's `NOTES.md` for the details and for a known
limitation: OpenReel imports these files cleanly but currently drops the alpha channel when
compositing.

## Adding a component

1. `src/scenes/<id>.tsx` — the animation. Read params via
   `useScene().variables.get("key", default)()`.
2. `src/projects/<id>.ts` — `makeProject({scenes:[scene], variables: resolveProps(DEFAULT_PROPS)})`.
3. `components/<id>/meta.json` — param schema.
4. Register the project in `vite.config.ts` and in `PROJECTS` in `src/render-harness.ts`.
