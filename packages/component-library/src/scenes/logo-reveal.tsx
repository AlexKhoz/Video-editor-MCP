import { Circle, Rect, makeScene2D } from "@motion-canvas/2d";
import { all, createRef, easeInCubic, easeOutBack, easeOutCubic, useScene, waitFor } from "@motion-canvas/core";

const IN_DURATION = 0.7;
const OUT_DURATION = 0.5;
const MIN_HOLD = 0.2;

export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const primaryColor = String(variables.get("primaryColor", "#4ade80")());
  const totalDuration = Number(variables.get("durationInSeconds", 3)());

  const hold = Math.max(MIN_HOLD, totalDuration - IN_DURATION - OUT_DURATION);

  const badge = createRef<Rect>();
  const ring = createRef<Circle>();
  const bar = createRef<Rect>();

  view.add(
    <Rect ref={badge} width={0} height={280} radius={48} fill={primaryColor} opacity={0}>
      <Circle
        ref={ring}
        width={160}
        height={160}
        stroke={"#0b0f14"}
        lineWidth={22}
        scale={0}
        x={-60}
      />
      <Rect ref={bar} width={0} height={22} radius={11} fill={"#0b0f14"} x={70} />
    </Rect>,
  );

  yield* all(
    badge().opacity(1, IN_DURATION * 0.4, easeOutCubic),
    badge().width(560, IN_DURATION, easeOutBack),
  );
  yield* all(
    ring().scale(1, IN_DURATION * 0.6, easeOutBack),
    bar().width(180, IN_DURATION * 0.6, easeOutCubic),
  );

  yield* waitFor(hold);

  yield* all(
    badge().opacity(0, OUT_DURATION, easeInCubic),
    badge().scale(0.92, OUT_DURATION, easeInCubic),
  );
});
