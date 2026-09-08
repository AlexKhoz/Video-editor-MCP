import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard against one specific bug that has now shipped four times: a mediabunny
 * `CanvasSink` created without `alpha: true`.
 *
 * CanvasSink defaults to an *opaque* canvas, so a transparent (VP9 `alpha_mode=1`) clip comes
 * back with black baked into every transparent pixel. When such a frame is composited it does
 * not merely lose its own transparency — on the top track it paints over every track below.
 *
 *   Stage 7  the export's decode dropped alpha entirely
 *   Stage 19 the same decoder lost antialiased alpha detail (a different mechanism)
 *   Stage 20 `getFrameAtTime`, the frame source `renderFrame` falls back to when no
 *            ExportFrameDecoder has been primed, still had no `alpha: true` — so
 *            render_preview_frame returned a frame with the footage painted over
 *
 * Each time it was diagnosed from scratch, and the Stage 20 instance was first pinned on the
 * wrong line entirely (a legitimate black base fill in video-engine.ts). So rather than hope
 * nobody adds a fifth call site, this asserts on the source text: every construction either
 * passes `alpha: true` or is named here as deliberately opaque, with a reason. A new,
 * unclassified call site fails until someone decides which it is.
 *
 * This reads the file rather than executing it because the point is to cover *every*
 * construction, including ones no test happens to exercise.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "mediabunny-engine.ts");

/**
 * Methods whose CanvasSink is deliberately opaque, and why. These produce standalone images
 * rather than layers composited over other tracks, so an opaque canvas is correct — and for
 * thumbnails it is what the timeline UI expects to draw. If any of these ever starts feeding
 * the compositor, it belongs on the other side of this list.
 */
const DELIBERATELY_OPAQUE: Record<string, string> = {
  generateThumbnails: "timeline thumbnails, drawn standalone in the UI",
  generateFilmstripThumbnails: "filmstrip thumbnails, drawn standalone in the UI",
  exportImageSequence: "writes independent image files, not composited layers",
};

/** Finds each `new CanvasSink(` and the method that contains it. */
function findCanvasSinkSites(source: string) {
  const lines = source.split(/\r?\n/);
  // Class members are indented 2-4 spaces; the negative lookahead keeps control-flow
  // keywords from being mistaken for a method declaration.
  const methodPattern =
    /^\s{2,4}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  const controlFlow = /^\s*(?:if|for|while|switch|catch|return|await|const|let|var)\b/;

  const sites: Array<{ line: number; method: string }> = [];
  const methodStarts: Array<{ line: number; method: string }> = [];
  let current = "(top level)";

  lines.forEach((line, index) => {
    const match = methodPattern.exec(line);
    if (match && !controlFlow.test(line)) {
      current = match[1]!;
      methodStarts.push({ line: index, method: current });
    }
    if (line.includes("new CanvasSink(")) sites.push({ line: index, method: current });
  });

  return sites.map((site) => {
    // The options can sit before the call (a `sinkOptions` object) or inside it (an inline
    // literal), so the whole enclosing method body is searched. Every method in this file
    // builds at most one sink, which is what makes that sound.
    const startIndex = methodStarts.filter((m) => m.line <= site.line).pop()?.line ?? 0;
    const nextStart = methodStarts.find((m) => m.line > site.line)?.line ?? lines.length;
    return {
      line: site.line + 1,
      method: site.method,
      body: lines.slice(startIndex, nextStart).join("\n"),
    };
  });
}

describe("CanvasSink alpha handling", () => {
  const source = fs.readFileSync(ENGINE, "utf8");
  const sites = findCanvasSinkSites(source);

  it("finds the CanvasSink construction sites", () => {
    // A guard that silently matched nothing would pass forever.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it("every compositing CanvasSink passes alpha: true", () => {
    const offenders = sites
      .filter((site) => !(site.method in DELIBERATELY_OPAQUE))
      .filter((site) => !/alpha:\s*true/.test(site.body))
      .map((site) => `${site.method} (line ${site.line})`);

    expect(
      offenders,
      `CanvasSink without alpha: true bakes black into transparent clips (Stage 7/19/20 in ` +
        `NOTES.md). Add alpha: true, or add the method to DELIBERATELY_OPAQUE with a reason ` +
        `if it produces standalone images rather than composited layers.`,
    ).toEqual([]);
  });

  it("every deliberately-opaque exemption still exists", () => {
    // Keeps the exemption list from rotting into a list of methods that no longer exist,
    // which would quietly widen what the guard permits.
    const methods = new Set(sites.map((site) => site.method));
    for (const name of Object.keys(DELIBERATELY_OPAQUE)) {
      expect(methods, `${name} is exempted but constructs no CanvasSink`).toContain(name);
    }
  });

  it("the two frame sources the compositor uses both request alpha", () => {
    // Named explicitly because these are the ones that feed renderFrame: the primed
    // decoder, and the fallback that render_preview_frame actually hits.
    for (const method of ["initialize", "getFrameAtTime"]) {
      const site = sites.find((entry) => entry.method === method);
      expect(site, `expected a CanvasSink in ${method}`).toBeDefined();
      expect(site!.body, `${method} must request alpha`).toMatch(/alpha:\s*true/);
    }
  });
});
