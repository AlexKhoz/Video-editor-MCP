/**
 * Headless render harness.
 *
 * Motion Canvas has no official CLI renderer: rendering runs in a browser, and the
 * built-in image-sequence exporter ships frames to the Vite dev server over the HMR
 * channel, which writes them into ./output. This page is the piece a headless browser
 * loads to drive that pipeline without the editor UI.
 *
 * Query parameters:
 *   project  component id (animated-text | logo-reveal | color-transition)
 *   props    URL-encoded JSON, read by src/lib/props.ts inside the project module
 *   fps      frames per second (default 30)
 *   width    frame width in px (default 1920)
 *   height   frame height in px (default 1080)
 *   bg       solid background colour, e.g. %2300ff00 for chroma-key renders.
 *            Omit for a transparent (alpha) render.
 *
 * Completion is reported on `window.__mcRender` for the driver to poll.
 */
import { Renderer, Vector2 } from "@motion-canvas/core";
import type { Project } from "@motion-canvas/core";

import animatedText from "./projects/animated-text?project";
import colorTransition from "./projects/color-transition?project";
import logoReveal from "./projects/logo-reveal?project";
import logoRevealV2 from "./projects/logo-reveal-v2?project";
import lowerThird from "./projects/lower-third?project";
import statCounter from "./projects/stat-counter?project";
import turbulentBackground from "./projects/turbulent-background?project";

const PROJECTS: Record<string, Project> = {
  "animated-text": animatedText,
  "logo-reveal": logoReveal,
  "color-transition": colorTransition,
  "lower-third": lowerThird,
  "logo-reveal-v2": logoRevealV2,
  "stat-counter": statCounter,
  "turbulent-background": turbulentBackground,
};

interface RenderReport {
  status: "working" | "done" | "error";
  frames?: number;
  error?: string;
}

declare global {
  interface Window {
    __mcRender: RenderReport;
  }
}

const status = document.getElementById("status");
const params = new URLSearchParams(location.search);
const projectName = params.get("project") ?? "animated-text";
const fps = Number(params.get("fps") ?? 30);
const width = Number(params.get("width") ?? 1920);
const height = Number(params.get("height") ?? 1080);
const background = params.get("bg");

window.__mcRender = { status: "working" };

function report(next: RenderReport) {
  window.__mcRender = next;
  if (status) {
    status.textContent = JSON.stringify(next);
  }
}

async function main() {
  const project = PROJECTS[projectName];
  if (!project) {
    throw new Error(
      `Unknown project "${projectName}". Known: ${Object.keys(PROJECTS).join(", ")}`,
    );
  }

  // Motion Canvas reports scene errors and diagnostics through its own logger, which the
  // editor UI would display and a headless run otherwise throws away. Forwarding it to the
  // console puts it in the render log, and keeping the error-level ones lets the failure
  // report say what actually went wrong instead of just "no frames were written".
  const logged: string[] = [];
  project.logger.onLogged.subscribe((payload) => {
    const line = [payload.level ?? "info", payload.message, payload.stack]
      .filter(Boolean)
      .join(" | ");
    console.log(`[mc] ${line}`);
    if (payload.level === "error") logged.push(payload.message ?? line);
  });

  const renderer = new Renderer(project);
  let lastFrame = 0;
  renderer.onFrameChanged.subscribe((frame) => {
    lastFrame = frame;
  });

  await renderer.render({
    name: projectName,
    range: [0, Infinity],
    fps,
    size: new Vector2(width, height),
    resolutionScale: 1,
    colorSpace: "srgb",
    // null keeps the canvas transparent (the components' native mode). A solid colour is
    // used for chroma-key renders, because OpenReel's decoder drops the alpha channel.
    background: background ?? null,
    exporter: {
      name: "@motion-canvas/core/image-sequence",
      options: {
        fileType: "image/png",
        quality: 100,
        groupByScene: false,
      },
    },
  });

  if (logged.length > 0) {
    throw new Error(logged.join(" | "));
  }

  report({ status: "done", frames: lastFrame + 1 });
}

main().catch((error: unknown) => {
  report({
    status: "error",
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  });
});
