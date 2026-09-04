import ffmpegModule from "@motion-canvas/ffmpeg";
import motionCanvasModule from "@motion-canvas/vite-plugin";
import { defineConfig } from "vite";

// Both plugins are CJS, so under ESM config loading the callable lands on `.default`
// depending on how Vite bundles the config file. Normalise defensively.
const motionCanvas = (motionCanvasModule as never as { default?: unknown }).default ?? motionCanvasModule;
const ffmpeg = (ffmpegModule as never as { default?: unknown }).default ?? ffmpegModule;

export default defineConfig({
  plugins: [
    (motionCanvas as typeof motionCanvasModule)({
      project: [
        "./src/projects/animated-text.ts",
        "./src/projects/logo-reveal.ts",
        "./src/projects/color-transition.ts",
        "./src/projects/lower-third.ts",
        "./src/projects/logo-reveal-v2.ts",
        "./src/projects/stat-counter.ts",
      ],
      output: "./output",
    }),
    // Bundled for completeness; the render pipeline uses the built-in image-sequence
    // exporter plus our own ffmpeg call, because this exporter hardcodes MP4/yuv420p
    // (see node_modules/@motion-canvas/ffmpeg/lib/server/FFmpegExporterServer.js) and
    // therefore cannot produce an alpha channel.
    (ffmpeg as typeof ffmpegModule)(),
  ],
  server: {
    port: 9000,
  },
});
