import assert from "node:assert/strict";
import { test } from "node:test";

import { MCP_PROJECT_SUFFIX, withMcpProjectSuffix } from "../src/naming.js";

/**
 * The suffix rule is enforced server-side so it cannot be forgotten by a calling agent, which
 * means the rule itself is the thing worth pinning down.
 */

test("appends the suffix to a plain name", () => {
  assert.equal(withMcpProjectSuffix("Summer Sale Promo"), "Summer Sale Promo-MCP");
  assert.equal(withMcpProjectSuffix("Q4 product launch teaser"), "Q4 product launch teaser-MCP");
});

test("does not double an already-suffixed name", () => {
  assert.equal(withMcpProjectSuffix("Launch teaser-MCP"), "Launch teaser-MCP");
});

test("recognises an existing suffix regardless of case, and normalises it", () => {
  // Normalised so a case-sensitive filter over the project list still finds every one of them.
  for (const variant of ["-mcp", "-Mcp", "-mCp", "-MCP"]) {
    assert.equal(withMcpProjectSuffix(`Launch teaser${variant}`), "Launch teaser-MCP");
  }
});

test("still marks a missing or blank name", () => {
  // project-kit would fall back to "Untitled", and an unsuffixed project is the whole thing
  // this prevents.
  for (const empty of [undefined, null, "", "   ", 42, {}]) {
    assert.equal(withMcpProjectSuffix(empty), "Untitled-MCP");
  }
});

test("trims surrounding whitespace before appending", () => {
  assert.equal(withMcpProjectSuffix("  Launch teaser  "), "Launch teaser-MCP");
});

test("a name that merely contains the suffix mid-string is still suffixed", () => {
  assert.equal(withMcpProjectSuffix("-MCP rollout plan"), "-MCP rollout plan-MCP");
});

test("the exported suffix constant is what gets applied", () => {
  assert.ok(withMcpProjectSuffix("anything").endsWith(MCP_PROJECT_SUFFIX));
});
