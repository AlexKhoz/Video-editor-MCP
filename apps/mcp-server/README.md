# @video-editor/mcp-server

An [MCP](https://modelcontextprotocol.io) server that lets Claude build and export video
projects in this editor: render animated components, upload footage, lay out a timeline,
and export an MP4 — all over stdio, with no browser interaction.

Every tool is a thin wrapper over one **render-service HTTP endpoint**. This package holds
no editing logic and never imports render-service internals, so the two can move
independently as long as the HTTP contract holds.

## Requirements

The server itself only needs Node 22+ and this package's two dependencies. The tools,
however, call render-service, so the same processes as a normal editing session must be
running (see the root [README](../../README.md)):

| Process | Needed by |
| --- | --- |
| Redis (Docker) | every queued job |
| render-service (`:3001`) | all tools |
| component render worker | `generate_component` |
| export worker + editor dev server (`:5173`) | `export_project` |

`service_health` reports whether render-service and Redis are up; a stopped worker only
shows up as a job that never leaves `waiting`.

```bash
node src/index.js        # or: npm start
npm test                 # stdio round-trip smoke tests over the tool surface
```

`RENDER_SERVICE_URL` overrides the service address (default `http://127.0.0.1:3001`).

## Registering it locally

### Claude Code

```bash
claude mcp add video-editor --scope user -- node E:/Replika/Tools/video-editor/apps/mcp-server/src/index.js
```

Or, equivalently, in `.mcp.json` at a project root (checked in, shared with the repo):

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["E:/Replika/Tools/video-editor/apps/mcp-server/src/index.js"],
      "env": {
        "RENDER_SERVICE_URL": "http://127.0.0.1:3001"
      }
    }
  }
}
```

### Claude Desktop

Same block, in `claude_desktop_config.json`:

- Windows — `%APPDATA%\Claude\claude_desktop_config.json`
- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["E:/Replika/Tools/video-editor/apps/mcp-server/src/index.js"],
      "env": {
        "RENDER_SERVICE_URL": "http://127.0.0.1:3001"
      }
    }
  }
}
```

Use an absolute path to `src/index.js` and forward slashes on Windows. Restart the client
after editing the config. Startup logging goes to **stderr** on purpose — stdout is the
protocol channel, and one stray `console.log` there corrupts the session.

## Tools

| Tool | What it does |
| --- | --- |
| `list_components` | Lists the animated overlay components with their parameter schemas. Call it before `generate_component`. |
| `generate_component` | Renders one component to a transparent-background WebM. **Blocks** until the render finishes (20–60s); optionally downloads it locally. |
| `upload_media` | Uploads a local video/audio/image to the server store and probes it with ffprobe. Returns `mediaId` + `metadata` for the `add_media` op. |
| `list_projects` | Saved projects, newest first. |
| `create_project` | Creates an empty project with one video track; returns `projectId` and that `trackId`. |
| `load_project` | Current state: tracks, clips (ids, times, effects), text clips, media library, timeline duration. `includeRaw` for the full JSON. |
| `apply_project_ops` | The main editing tool. Applies a list of ops **atomically**; its description carries the whole op vocabulary. |
| `export_project` | Renders the project to MP4 in a headless browser. **Blocks** until done; optionally downloads it. |
| `service_health` | render-service reachable, Redis up. Distinguishes a stopped service from a bad request. |

Two deliberate design choices:

**Long jobs are polled inside the tool.** `generate_component` and `export_project` queue
the job and then poll until it finishes, returning a single answer. A model that has to
poll a job itself burns turns and tends to give up early or declare success on a
`waiting` status.

**Descriptions carry the domain knowledge, not the code.** The things that cost us real
debugging time in earlier stages are stated where the model reads them:

- `apply_project_ops` spells out that **"Video 1" (the first track) renders on TOP** —
  reversed from the intuitive reading, and the single easiest way to build a timeline
  where the overlay is invisible.
- `add_text_clip`'s `transform.position` is **normalised 0–1**, unlike clip transforms
  which are pixel offsets. Same field name, different units.
- `upload_media` says to pass *both* `mediaId` and `metadata` to `add_media`, because a
  clip built from media with no metadata has no duration to fall back on.
- Every op's optional params are described as optional with their defaults, so the model
  doesn't invent parameter objects for `dipToBlack`.

### Concurrency

Ops are written through render-service's optimistic-concurrency guard. `apply_project_ops`
does a **load-then-write**: it reads the project's current `updatedAt` and sends it as
`expectedUpdatedAt`, so a save that would overwrite a newer change — someone editing the
same project in the browser — fails with a 409 instead of silently clobbering it. The tool
translates that into an explicit instruction ("call `load_project`, then apply your
operations again") rather than an HTTP status.

This means the guard protects against *stale-read* conflicts within a call, not against a
change landing between two of the model's calls. Retrying is always safe; the ops
themselves are not idempotent, so a retry after a *successful* call would apply twice.

Invalid ops come back as `isError` with the failing index, the message, the project-kit
error code, and the words "nothing was saved":

```
Error: ops[1] (add_clip): Track ghost-track not found [TRACK_NOT_FOUND] — nothing was saved.
```

## Known limitations

- **No authentication, anywhere.** This server calls a localhost-only, no-auth
  render-service, so any tool call can read or overwrite any project. Unchanged from
  Stage 10 and still a hard blocker: it must be closed before render-service is reachable
  by anyone outside this machine.
- `filePath` on `upload_media` is read from *this machine's* filesystem — the server has
  whatever access the user running it has.
- Exports are one headless Chrome each, run at concurrency 1, with no cancellation. A
  queued export waits for the one ahead of it.
- Edits made through these tools bypass the editor's undo/redo history; a browser with the
  project already open will not see them until it reloads.
