import { Txt, makeScene2D } from "@motion-canvas/2d";
import { all, createRef, easeInCubic, easeOutCubic, useScene, waitFor } from "@motion-canvas/core";

const IN_DURATION = 0.6;
const OUT_DURATION = 0.5;
const MIN_HOLD = 0.2;

export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const text = variables.get("text", "Hello")();
  const color = variables.get("color", "#ffffff")();
  const totalDuration = Number(variables.get("durationInSeconds", 3)());

  const hold = Math.max(MIN_HOLD, totalDuration - IN_DURATION - OUT_DURATION);

  const label = createRef<Txt>();

  view.add(
    <Txt
      ref={label}
      text={String(text)}
      fill={String(color)}
      fontFamily={"Inter, Segoe UI, Helvetica, Arial, sans-serif"}
      fontSize={140}
      fontWeight={700}
      opacity={0}
      y={60}
      scale={0.9}
    />,
  );

  yield* all(
    label().opacity(1, IN_DURATION, easeOutCubic),
    label().y(0, IN_DURATION, easeOutCubic),
    label().scale(1, IN_DURATION, easeOutCubic),
  );

  yield* waitFor(hold);

  yield* all(
    label().opacity(0, OUT_DURATION, easeInCubic),
    label().y(-40, OUT_DURATION, easeInCubic),
  );
});
