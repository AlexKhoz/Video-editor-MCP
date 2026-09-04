import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/animated-text?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  text: "Hello",
  color: "#ffffff",
  durationInSeconds: 3,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
