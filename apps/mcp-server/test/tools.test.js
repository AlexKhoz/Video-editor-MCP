import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Smoke tests over a real stdio round-trip: the server must start, advertise its tools and
 * describe them well enough for a model to use them. Deliberately does not touch
 * render-service — tool *behaviour* is covered by the end-to-end run in NOTES.md.
 */

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

const EXPECTED_TOOLS = [
  "list_components",
  "generate_component",
  "upload_media",
  "list_projects",
  "create_project",
  "load_project",
  "apply_project_ops",
  "export_project",
  "render_preview_frame",
  "service_health",
];

let client;
let tools;

before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: "pipe",
  });
  client = new Client({ name: "mcp-server-tests", version: "1.0.0" });
  await client.connect(transport);
  ({ tools } = await client.listTools());
});

after(async () => {
  await client?.close();
});

test("advertises exactly the expected tools", () => {
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
});

test("every tool has a title and a substantial description", () => {
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 80, `${tool.name} needs a real description`);
    assert.ok(tool.title, `${tool.name} needs a title`);
  }
});

test("apply_project_ops documents the whole operation vocabulary", () => {
  const tool = tools.find((item) => item.name === "apply_project_ops");
  for (const op of [
    "add_media", "add_track", "add_clip", "trim_clip", "move_clip", "split_clip",
    "remove_clip", "set_effect", "remove_effect", "set_clip_transform", "set_audio_fade", "add_text_clip",
    "add_transition", "rename_project",
  ]) {
    assert.match(tool.description, new RegExp(op), `description should document ${op}`);
  }
  // The two things easiest to get wrong, per earlier stages.
  assert.match(tool.description, /Video 1.*TOP|TOP.*Video 1/s, "track order must be explained");
  assert.match(tool.description, /atomic/i, "atomicity must be explained");
});

test("tools that create or mutate declare their required parameters", () => {
  const required = {
    generate_component: ["componentId"],
    upload_media: ["filePath"],
    load_project: ["projectId"],
    apply_project_ops: ["projectId", "ops"],
    export_project: ["projectId"],
  };
  for (const [name, keys] of Object.entries(required)) {
    const tool = tools.find((item) => item.name === name);
    for (const key of keys) {
      assert.ok(
        tool.inputSchema?.properties?.[key],
        `${name} should accept ${key}`,
      );
      assert.ok(
        (tool.inputSchema.required ?? []).includes(key),
        `${name}.${key} should be required`,
      );
    }
  }
});

test("long-running tools promise to block rather than ask the caller to poll", () => {
  for (const name of ["generate_component", "export_project", "render_preview_frame"]) {
    const tool = tools.find((item) => item.name === name);
    assert.match(tool.description, /blocks until|waits for/i, `${name} should say it waits`);
  }
});
