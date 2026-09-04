import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/lower-third?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  title: "Jane Doe",
  subtitle: "Head of Product",
  accentColor: "#38bdf8",
  durationInSeconds: 4,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
