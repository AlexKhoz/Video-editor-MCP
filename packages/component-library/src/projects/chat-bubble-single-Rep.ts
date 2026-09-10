import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/chat-bubble-single-Rep?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  text: "Hey, are you around?",
  sender: "received",
  durationInSeconds: 2.5,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
