import assert from "node:assert/strict";
import fs from "node:fs";
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
 *
 * The staleness tests below read the component catalogue straight off disk rather than
 * through `list_components`, to keep the suite runnable with no services up. That is the
 * same ground truth: `listComponents()` in render-service reads these very meta.json files
 * on every call, and a round-trip comparison confirmed the tool returns them field for field.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "src", "index.js");
const CATALOGUE_DIR = path.resolve(HERE, "..", "..", "..", "packages", "component-library", "components");

/**
 * Component ids that have existed and been removed or renamed. A tool description naming one
 * of these is stale by definition, which is exactly the bug this guards: `generate_component`
 * carried `{ "title": "Jane Doe" }` for two catalogue changes after `lower-third` was deleted,
 * so an agent following the example would have sent a prop no component accepts.
 */
const RETIRED_COMPONENT_IDS = [
  "animated-text",
  "color-transition",
  "logo-reveal",
  "logo-reveal-v2",
  "lower-third",
  "orbit-headline",       // pre -Rep rename
  "turbulent-background", // pre -Rep rename
  "turbulent-bg-new",     // pre -Rep rename
];

/** The live catalogue, read the way render-service reads it. */
function readCatalogue() {
  return fs
    .readdirSync(CATALOGUE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(CATALOGUE_DIR, entry.name, "meta.json"))
    .filter((metaPath) => fs.existsSync(metaPath))
    .map((metaPath) => JSON.parse(fs.readFileSync(metaPath, "utf8")));
}

/** Every description string a model actually sees for one tool. */
function describedStrings(tool) {
  const strings = [tool.description ?? ""];
  for (const property of Object.values(tool.inputSchema?.properties ?? {})) {
    if (property.description) strings.push(property.description);
  }
  return strings;
}

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

test("component params used as examples exist in the live catalogue", () => {
  const catalogue = readCatalogue();
  const liveParamKeys = new Set(catalogue.flatMap((meta) => meta.params.map((param) => param.key)));
  assert.ok(liveParamKeys.size > 0, "catalogue should expose some params");

  // Scoped to generate_component, the one tool whose examples are component props. The
  // quoted keys in apply_project_ops belong to the op vocabulary (op, trackId, mediaId,
  // startTime), not to any component, so a blanket sweep would fail on them.
  const tool = tools.find((item) => item.name === "generate_component");
  const quotedKeys = describedStrings(tool)
    .flatMap((text) => [...text.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]));

  assert.ok(quotedKeys.length > 0, "generate_component should show at least one prop example");
  for (const key of quotedKeys) {
    assert.ok(
      liveParamKeys.has(key),
      `generate_component's description uses prop "${key}", which no live component accepts` +
        ` (live: ${[...liveParamKeys].sort().join(", ")})`,
    );
  }
});

test("no tool description names a retired component id", () => {
  const catalogue = readCatalogue();
  const liveIds = new Set(catalogue.map((meta) => meta.id));
  const retired = new Set(RETIRED_COMPONENT_IDS.filter((id) => !liveIds.has(id)));

  for (const tool of tools) {
    for (const text of describedStrings(tool)) {
      // Whole hyphenated tokens, so that "orbit-headline-Rep" is never mistaken for the
      // retired "orbit-headline" it contains.
      const tokens = [...text.matchAll(/\b([a-z][a-z0-9]*(?:-[A-Za-z0-9]+)+)\b/g)].map((m) => m[1]);
      for (const token of tokens) {
        assert.ok(
          !retired.has(token),
          `${tool.name} still names the retired component "${token}"`,
        );
      }
    }
  }
});

test("every component id a description names is a live component", () => {
  const catalogue = readCatalogue();
  const liveIds = new Set(catalogue.map((meta) => meta.id));

  // Only tokens shaped like a custom component id are judged, so ordinary prose compounds
  // ("render-service", "server-side") are left alone. Every custom component carries the
  // -Rep suffix by convention (see NOTES.md), which makes them identifiable.
  for (const tool of tools) {
    for (const text of describedStrings(tool)) {
      const candidates = [...text.matchAll(/\b([a-z][a-z0-9]*(?:-[A-Za-z0-9]+)*-Rep)\b/g)].map((m) => m[1]);
      for (const id of candidates) {
        assert.ok(
          liveIds.has(id),
          `${tool.name} names component "${id}", which is not in the catalogue` +
            ` (live: ${[...liveIds].sort().join(", ")})`,
        );
      }
    }
  }
});
