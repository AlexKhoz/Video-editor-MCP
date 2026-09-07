import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/orbit-headline?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  text: "You talk | I'll listen",
  fontFamily: "Archivo Black",
  textColor: "#00004d",
  durationInSeconds: 5.6,
  zoomAmount: 1,
  driftAmount: 1,
  settleAmount: 0,
  staggerSeconds: 0.12,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
