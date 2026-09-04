import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/logo-reveal?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  primaryColor: "#4ade80",
  durationInSeconds: 3,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
