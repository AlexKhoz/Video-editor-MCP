#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { SERVICE_URL, service } from "./service.js";

/**
 * MCP server for the browser video editor.
 *
 * Every tool is a thin wrapper over one render-service HTTP endpoint — no business logic
 * lives here. Long-running work (component renders, project exports) is polled inside the
 * tool so the model gets a single answer instead of having to poll itself.
 *
 * No authentication anywhere: this speaks to a localhost-only service. Do not expose it.
 */

const OPS_VOCABULARY = `
Each entry is an object with an "op" field plus that op's parameters. Ops are applied in
order, atomically: if any one fails, none are saved. Ids created along the way come back in
the response ("results"), so you can add a clip in one call and trim it in the next.

Timeline model: a project has tracks; each track holds clips positioned in seconds.
"Video 1" (the FIRST track) renders on TOP of later tracks — put overlays on an earlier
track than the footage they sit over.

Available ops:

- add_media { id, name?, metadata }
    Registers already-uploaded media in the project library. Pass the "mediaId" and
    "metadata" object exactly as returned by upload_media. Required before add_clip.

- add_track { name? }
    Appends a track. Returns { trackId }.

- add_clip { trackId, mediaId, startTime, duration?, inPoint?, metadata?, allowOverlap? }
    Places media on a track. startTime is where it begins on the timeline (seconds).
    duration defaults to the media's full length; inPoint (default 0) is how far into the
    source the clip starts, so { inPoint: 2, duration: 3 } uses source seconds 2-5.
    Overlapping an existing clip on the same track is rejected unless allowOverlap: true.
    Returns { clipId }.

- trim_clip { clipId, startTime?, duration?, inPoint? }
    Changes any of those; outPoint is kept consistent automatically. Cannot extend past the
    source media's length.

- move_clip { clipId, trackId?, startTime? }
    Moves a clip to another track and/or another time.

- split_clip { clipId, time }
    Splits at an absolute timeline time that must fall strictly inside the clip. Returns
    { clipId, newClipId } — the original keeps the earlier half.

- remove_clip { clipId }
    Deletes the clip and any transitions referencing it.

- set_effect { clipId, type, params?, enabled? }
    Adds or replaces an effect on a clip (replaced by type, so calling it twice with the
    same type updates rather than duplicates). Useful types: "chromaKey" (params:
    keyColor {r,g,b} 0-1, tolerance, edgeSoftness, spillSuppression), "brightness",
    "contrast", "saturation", "blur", "grayscale", "invert", "sepia", "vignette", "grain",
    "sharpen". Omitted params fall back to sensible defaults.

- remove_effect { clipId, type? | effectId? }

- set_clip_transform { clipId, transform?, opacity?, volume? }
    transform accepts { position:{x,y}, scale:{x,y}, rotation, anchor:{x,y}, fitMode }.
    fitMode is "contain" | "cover" | "stretch". opacity and volume are 0-1.

- add_text_clip { trackId, text, startTime, duration, style?, transform? }
    A text overlay. style accepts { fontFamily, fontSize, fontWeight, color, strokeColor,
    strokeWidth, textAlign, verticalAlign, lineHeight, letterSpacing }. transform.position
    is NORMALISED here (0-1, so { x: 0.5, y: 0.5 } is centred), unlike clip transforms
    which are pixel offsets. Returns { textClipId }.

- add_transition { clipAId, clipBId?, type, duration?, params?, edge? }
    A transition between two clips on the same track (or anchored to one clip's edge with
    edge: "in" | "out" and no clipBId). type is one of: crossfade, dipToBlack, dipToWhite,
    wipe, slide, zoom, push, circleReveal, blur, whipPan, radialWipe, pixelate, glitch,
    blinds, diamondReveal, spin, flip, splitReveal, flash, filmBurn, mosaic, ripple,
    pageTurn, colorSplit. params may be omitted entirely — every type has defaults (e.g.
    wipe/slide take { direction: "left"|"right"|"up"|"down" }, dipToBlack takes
    { holdDuration }).

- rename_project { name }
`.trim();

const server = new McpServer(
  { name: "video-editor", version: "0.1.0" },
  {
    instructions:
      "Build and export browser-video-editor projects. Typical flow: list_components to " +
      "see what animated overlays exist, generate_component to render one, upload_media " +
      "for any footage on disk, create_project, apply_project_ops to lay out the timeline, " +
      "then export_project. Component renders and exports are polled internally and only " +
      "return when finished, so a single call can take tens of seconds.",
  },
);

/** Every tool returns text plus a machine-readable copy of the same payload. */
function ok(summary, data) {
  return {
    content: [
      { type: "text", text: data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}` },
    ],
    structuredContent: data === undefined ? undefined : { result: data },
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

server.registerTool(
  "list_components",
  {
    title: "List animated components",
    description:
      "Lists the animated overlay components available to render (animated text, lower " +
      "thirds, logo reveals, a stat counter, a colour transition). Returns each component's " +
      "id, name, description and parameter schema — parameter types follow the editor's " +
      "vocabulary: text, number, color, boolean, media. Call this before generate_component " +
      "so you know which ids and props exist.",
    inputSchema: {},
  },
  async () => {
    try {
      const { components } = await service.listComponents();
      return ok(`${components.length} components available.`, components);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "generate_component",
  {
    title: "Render an animated component",
    description:
      "Renders one animated component to a video file with a transparent background and " +
      "waits for it to finish (typically 20-60 seconds — this call blocks until done, you " +
      "do not need to poll). Props must match the component's schema from list_components; " +
      "anything omitted uses its default. Returns the rendered file's id, byte size and a " +
      "local file path you can pass straight to upload_media. Pass background as a hex " +
      "colour only if you specifically want a solid backdrop instead of transparency.",
    inputSchema: {
      componentId: z.string().describe('Component id from list_components, e.g. "lower-third".'),
      props: z
        .record(z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Component parameters, e.g. { "title": "Jane Doe", "durationInSeconds": 4 }.'),
      background: z
        .string()
        .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
        .optional()
        .describe('Optional solid backdrop hex colour (e.g. "#00ff00"). Omit for transparency.'),
      downloadTo: z
        .string()
        .optional()
        .describe("Optional local directory to save the rendered file into."),
    },
  },
  async ({ componentId, props, background, downloadTo }) => {
    try {
      const queued = await service.startRender({ componentId, props: props ?? {}, background: background ?? null });
      const job = await service.waitForJob(() => service.renderStatus(queued.jobId), {
        timeoutMs: 10 * 60_000,
        label: `Component render for "${componentId}"`,
      });

      let saved = null;
      if (downloadTo) {
        saved = await service.downloadToFile(job.url, path.join(downloadTo, job.file));
      }

      return ok(
        `Rendered ${componentId} → ${job.file} (${job.bytes} bytes, ${job.frames} frames).`,
        {
          renderedFileId: job.file,
          bytes: job.bytes,
          frames: job.frames,
          durationInSeconds: job.durationInSeconds,
          serviceUrl: `${SERVICE_URL}${job.url}`,
          localPath: saved?.path ?? null,
          props: job.props,
        },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "upload_media",
  {
    title: "Upload a media file",
    description:
      "Uploads a local video, audio or image file to the editor's server-side media store " +
      "and probes it with ffprobe. Returns the mediaId plus a metadata object (duration, " +
      "width, height, frameRate, codec, hasAudio …). Pass BOTH of those to the add_media op " +
      "in apply_project_ops before placing the media on a timeline. Use this for footage on " +
      "disk and for the file returned by generate_component (pass its localPath).",
    inputSchema: {
      filePath: z.string().describe("Absolute path to a file on this machine."),
      mediaId: z
        .string()
        .optional()
        .describe("Optional id to store it under; a uuid is generated when omitted."),
      mimeType: z.string().optional().describe("Optional MIME type override."),
    },
  },
  async ({ filePath, mediaId, mimeType }) => {
    try {
      const record = await service.uploadMedia({ filePath, mediaId, mimeType });
      return ok(
        `Uploaded ${record.filename} as ${record.id} (${record.size} bytes).`,
        {
          mediaId: record.id,
          name: record.filename,
          size: record.size,
          metadata: record.metadata,
          hint: "Pass { id: mediaId, name, metadata } to the add_media op.",
        },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_projects",
  {
    title: "List saved projects",
    description:
      "Lists projects saved on the server, newest first, with id, name and last-updated " +
      "time. Use it to find an existing project to modify or export.",
    inputSchema: {},
  },
  async () => {
    try {
      const { projects } = await service.listProjects();
      return ok(`${projects.length} saved projects.`, projects);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "create_project",
  {
    title: "Create an empty project",
    description:
      "Creates and saves an empty project with one video track, returning its projectId and " +
      "that track's trackId — you need the trackId for add_clip and add_text_clip. Defaults " +
      "to 1920x1080 at 30fps.",
    inputSchema: {
      name: z.string().optional().describe('Project name, e.g. "Launch teaser".'),
      width: z.number().int().positive().optional().describe("Canvas width in pixels (default 1920)."),
      height: z.number().int().positive().optional().describe("Canvas height in pixels (default 1080)."),
      frameRate: z.number().positive().optional().describe("Frames per second (default 30)."),
    },
  },
  async ({ name, width, height, frameRate }) => {
    try {
      const created = await service.createProject({ name, width, height, frameRate });
      const tracks = created.project.timeline.tracks.map((track) => ({ trackId: track.id, name: track.name }));
      return ok(`Created project "${created.name}" (${created.id}).`, {
        projectId: created.id,
        name: created.name,
        updatedAt: created.updatedAt,
        tracks,
        settings: created.project.settings,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "load_project",
  {
    title: "Load a project",
    description:
      "Returns a saved project's current state: its tracks with their clips (id, mediaId, " +
      "startTime, duration, inPoint/outPoint, effects), text clips, media library and total " +
      "timeline duration. Use it to see what you are editing before calling " +
      "apply_project_ops, and to get clip ids. Set includeRaw for the full untrimmed JSON.",
    inputSchema: {
      projectId: z.string().describe("Project id from create_project or list_projects."),
      includeRaw: z
        .boolean()
        .optional()
        .describe("Include the complete project JSON as well as the summary (verbose)."),
    },
  },
  async ({ projectId, includeRaw }) => {
    try {
      const record = await service.getProject(projectId);
      const project = record.project;
      const summary = {
        projectId: record.id,
        name: record.name,
        updatedAt: record.updatedAt,
        settings: project.settings,
        timelineDuration: project.timeline.duration,
        tracks: project.timeline.tracks.map((track) => ({
          trackId: track.id,
          name: track.name,
          locked: track.locked,
          clips: track.clips.map((clip) => ({
            clipId: clip.id,
            mediaId: clip.mediaId,
            startTime: clip.startTime,
            duration: clip.duration,
            inPoint: clip.inPoint,
            outPoint: clip.outPoint,
            effects: (clip.effects ?? []).map((effect) => effect.type),
            componentId: clip.metadata?.componentId ?? null,
          })),
          transitions: (track.transitions ?? []).map((transition) => ({
            transitionId: transition.id,
            type: transition.type,
            duration: transition.duration,
          })),
        })),
        textClips: (project.textClips ?? []).map((clip) => ({
          textClipId: clip.id,
          text: clip.text,
          startTime: clip.startTime,
          duration: clip.duration,
        })),
        media: project.mediaLibrary.items.map((item) => ({
          mediaId: item.id,
          name: item.name,
          duration: item.metadata?.duration ?? null,
        })),
        ...(includeRaw ? { raw: project } : {}),
      };
      return ok(`Project "${record.name}" — ${summary.timelineDuration}s timeline.`, summary);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "apply_project_ops",
  {
    title: "Edit a project timeline",
    description:
      "Applies a list of editing operations to a saved project, atomically — if any " +
      "operation is invalid, nothing is saved and the error says which one failed. This is " +
      "the main editing tool: adding media to the library, placing and trimming clips, " +
      "adding text overlays, effects and transitions.\n\n" +
      `${OPS_VOCABULARY}\n\n` +
      "Concurrency: the tool reads the project's current updatedAt and sends it as a guard, " +
      "so a save that would overwrite someone else's newer change fails with a clear " +
      "conflict error rather than silently clobbering it. Re-run the call to retry against " +
      "the newer state.",
    inputSchema: {
      projectId: z.string().describe("Project id to edit."),
      ops: z
        .array(z.object({ op: z.string() }).passthrough())
        .min(1)
        .describe('Operations to apply in order, e.g. [{ "op": "add_clip", "trackId": "…", "mediaId": "…", "startTime": 0 }].'),
    },
  },
  async ({ projectId, ops }) => {
    try {
      // Load-then-write: fetch the current updatedAt and pass it as the guard, so a
      // concurrent change surfaces as a conflict instead of an overwrite.
      const current = await service.getProject(projectId);
      const applied = await service.applyOps(projectId, { ops, expectedUpdatedAt: current.updatedAt });
      return ok(
        `Applied ${ops.length} operation(s). Timeline is now ${applied.timelineDuration}s.`,
        {
          projectId,
          updatedAt: applied.updatedAt,
          timelineDuration: applied.timelineDuration,
          results: applied.results,
        },
      );
    } catch (error) {
      if (error?.status === 409) {
        return fail(
          new Error(
            "Conflict: the project changed on the server since this call read it " +
              `(server ${error.body?.serverUpdatedAt}, expected ${error.body?.yourUpdatedAt}). ` +
              "Call load_project to see the current state, then apply your operations again.",
          ),
        );
      }
      if (error?.status === 400) {
        return fail(
          new Error(
            `${error.body?.error ?? "Invalid operations"}` +
              (error.body?.code ? ` [${error.body.code}]` : "") +
              " — nothing was saved.",
          ),
        );
      }
      return fail(error);
    }
  },
);

server.registerTool(
  "export_project",
  {
    title: "Export a project to video",
    description:
      "Renders a saved project to an MP4 and waits for it to finish (roughly real time — a " +
      "10-second timeline takes tens of seconds; this call blocks until done). The export " +
      "runs the real editor in a headless browser, so it includes every clip, effect, text " +
      "overlay, transition and the audio mix. Returns the output file's server path plus a " +
      "URL, and a local copy when downloadTo is given. Requires the export worker to be " +
      "running.",
    inputSchema: {
      projectId: z.string().describe("Project id to export."),
      downloadTo: z
        .string()
        .optional()
        .describe("Optional local directory to save the finished MP4 into."),
    },
  },
  async ({ projectId, downloadTo }) => {
    try {
      const queued = await service.startExport(projectId, {});
      const job = await service.waitForJob(() => service.exportStatus(queued.jobId), {
        timeoutMs: 30 * 60_000,
        intervalMs: 3000,
        label: `Export of project ${projectId}`,
      });

      let saved = null;
      if (downloadTo) {
        saved = await service.downloadToFile(job.url, path.join(downloadTo, job.file));
      }

      return ok(
        `Exported ${job.file} (${job.bytes} bytes, took ${job.durationSeconds}s).`,
        {
          file: job.file,
          bytes: job.bytes,
          serverPath: job.filePath,
          serviceUrl: `${SERVICE_URL}${job.url}`,
          localPath: saved?.path ?? null,
          exportSeconds: job.durationSeconds,
        },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "service_health",
  {
    title: "Check the editor services",
    description:
      "Checks that render-service is reachable and Redis is up. Call this first if another " +
      "tool fails with a connection error, to tell a stopped service apart from a bad request.",
    inputSchema: {},
  },
  async () => {
    try {
      const health = await service.health();
      return ok(`Service ${health.status}, redis ${health.redis}.`, { serviceUrl: SERVICE_URL, ...health });
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the protocol channel — anything human-readable must go to stderr.
process.stderr.write(`[video-editor-mcp] connected, service ${SERVICE_URL}\n`);
