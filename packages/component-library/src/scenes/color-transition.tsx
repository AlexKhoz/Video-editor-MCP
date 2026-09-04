import { Rect, makeScene2D } from "@motion-canvas/2d";
import { createRef, easeInOutCubic, easeInCubic, easeOutCubic, useScene } from "@motion-canvas/core";

const FADE_IN_RATIO = 0.25;
const FADE_OUT_RATIO = 0.25;

/**
 * A full-frame colour overlay that fades in, tweens from one colour to another,
 * then fades out — usable as a transition wipe over a cut on the timeline.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const fromColor = String(variables.get("fromColor", "#0ea5e9")());
  const toColor = String(variables.get("toColor", "#a855f7")());
  const totalDuration = Number(variables.get("durationInSeconds", 2)());

  const fadeIn = totalDuration * FADE_IN_RATIO;
  const fadeOut = totalDuration * FADE_OUT_RATIO;
  const middle = Math.max(0.1, totalDuration - fadeIn - fadeOut);

  const overlay = createRef<Rect>();

  view.add(
    <Rect
      ref={overlay}
      width={"100%"}
      height={"100%"}
      fill={fromColor}
      opacity={0}
    />,
  );

  yield* overlay().opacity(1, fadeIn, easeOutCubic);
  yield* overlay().fill(toColor, middle, easeInOutCubic);
  yield* overlay().opacity(0, fadeOut, easeInCubic);
});
