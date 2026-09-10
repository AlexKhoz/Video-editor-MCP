import { makeProject } from "@motion-canvas/core";

import scene from "../scenes/chat-thread-Rep?scene";
import { resolveProps } from "../lib/props";

export const DEFAULT_PROPS = {
  text: "received: hey! how did it go?\nsent: better than I expected\nreceived: I knew it would",
  durationInSeconds: 8,
};

export default makeProject({
  scenes: [scene],
  variables: resolveProps(DEFAULT_PROPS),
});
