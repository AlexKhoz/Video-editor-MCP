# @video-editor/render-service

Takes `{ componentId, props }`, renders the matching Motion Canvas component from
`packages/component-library` to a transparent WebM, and serves the file. Fastify + BullMQ + Redis,
local filesystem storage. No cloud services, no API keys.

## Running

```bash
docker compose -f ../../infra/docker-compose.yml up -d   # Redis on 127.0.0.1:6379
npm install
npm start        # API on http://127.0.0.1:3001
npm run worker   # in a second terminal — the render worker
```

Server and worker are separate processes on purpose: a render occupies a headless Chrome and an
ffmpeg for tens of seconds, and the API must stay responsive.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | service + Redis status (503 when Redis is down) |
| `GET` | `/components` | the component catalogue, straight from each `meta.json` |
| `POST` | `/render` | `{ componentId, props, fps?, width?, height? }` → `202 { jobId, status: "pending", props }` |
| `GET` | `/render/:jobId` | `{ status: pending \| processing \| done \| failed, progress, … }`; when done also `file`, `url`, `bytes`, `frames` |
| `GET` | `/files/:name.webm` | the rendered file |

Props are validated against the component's `meta.json` before a job is queued: unknown keys are
ignored (and reported as `ignoredProps`), missing keys take their defaults, numbers are range-checked
and colours must be hex. Invalid props get a `400` listing every problem.

```bash
curl -X POST http://127.0.0.1:3001/render \
  -H 'content-type: application/json' \
  -d '{"componentId":"animated-text","props":{"text":"Ship it","color":"#ffcc00","durationInSeconds":2}}'

curl http://127.0.0.1:3001/render/1
```

## Worker

On each job the worker shells out to `packages/component-library/scripts/render.mjs` — the Stage 2
pipeline (programmatic Vite server → headless Chrome → PNG frames with alpha → ffmpeg to
VP9/`yuva420p`) — and writes the result to `storage/rendered/<jobId>.webm`. That script is reused
rather than reimplemented because it is already verified to produce a correct alpha channel.

Concurrency is 1 by default; a render is Chrome- and ffmpeg-heavy.

## Configuration

Environment variables, all optional: `PORT` (3001), `HOST` (127.0.0.1), `REDIS_HOST`, `REDIS_PORT`,
`QUEUE_NAME`, `RENDER_STORAGE_DIR`, `COMPONENT_LIBRARY_DIR`, `WORKER_CONCURRENCY`,
`RENDER_TIMEOUT_MS`, `RENDER_FPS`, `RENDER_WIDTH`, `RENDER_HEIGHT`, `LOG_LEVEL`.

## Test

```bash
npm test
```

Renders `animated-text` with custom text through the real API and asserts the file exists, is
non-empty, matches the reported byte count, downloads over HTTP and starts with WebM's EBML magic
bytes. Requires Redis, ffmpeg and Chrome. `KEEP_TEST_OUTPUT=1` leaves the rendered file behind.
