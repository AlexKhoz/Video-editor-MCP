import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/stat-counter?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  label: "Active users",
  targetNumber: 1250,
  accentColor: "#34d399",
  durationInSeconds: 3,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
