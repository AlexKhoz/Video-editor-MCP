import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/logo-reveal-v2?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  primaryColor: "#f472b6",
  durationInSeconds: 3,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
