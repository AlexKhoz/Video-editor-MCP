import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/color-transition?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  fromColor: "#0ea5e9",
  toColor: "#a855f7",
  durationInSeconds: 2,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
