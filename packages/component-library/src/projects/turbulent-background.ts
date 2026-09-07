import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/turbulent-background?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  backgroundPreset: "brand-1",
  image: "",
  scale: 1.05,
  offsetX: 0,
  offsetY: 0,
  displacementAmount: 45,
  noiseScale: 2.2,
  durationInSeconds: 6,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
  // Node shaders are gated behind this flag: `parseShader` silently throws the shader away
  // when it is off (and only says so through Motion Canvas's own logger, which the headless
  // Renderer never surfaces). Without it the background renders as a still image.
  experimentalFeatures: true,
});
