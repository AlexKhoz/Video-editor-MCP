import { Layout, Rect, Txt, makeScene2D } from "@motion-canvas/2d";
import { all, createRef, easeInCubic, easeOutCubic, useScene, waitFor } from "@motion-canvas/core";

const IN_DURATION = 0.55;
const OUT_DURATION = 0.45;
const MIN_HOLD = 0.3;

/**
 * Broadcast-style lower third: an accent bar and a text block slide in from the left,
 * hold, then slide back out. Positioned in the lower-left safe area.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const title = String(variables.get("title", "Jane Doe")());
  const subtitle = String(variables.get("subtitle", "Head of Product")());
  const accentColor = String(variables.get("accentColor", "#38bdf8")());
  const totalDuration = Number(variables.get("durationInSeconds", 4)());

  const hold = Math.max(MIN_HOLD, totalDuration - IN_DURATION - OUT_DURATION);

  const group = createRef<Layout>();
  const bar = createRef<Rect>();
  const plate = createRef<Rect>();
  const titleRef = createRef<Txt>();
  const subtitleRef = createRef<Txt>();

  view.add(
    <Layout ref={group} x={-1400} y={300} layout={false}>
      <Rect ref={bar} width={12} height={0} radius={6} fill={accentColor} x={-460} />
      <Rect
        ref={plate}
        width={880}
        height={0}
        radius={10}
        fill={"#0b0f14"}
        opacity={0.86}
        x={10}
      />
      <Txt
        ref={titleRef}
        text={title}
        fill={"#ffffff"}
        fontFamily={"Inter, Segoe UI, Helvetica, Arial, sans-serif"}
        fontSize={64}
        fontWeight={700}
        opacity={0}
        x={-410}
        y={-26}
        textAlign={"left"}
        offsetX={-1}
      />
      <Txt
        ref={subtitleRef}
        text={subtitle}
        fill={accentColor}
        fontFamily={"Inter, Segoe UI, Helvetica, Arial, sans-serif"}
        fontSize={36}
        fontWeight={500}
        opacity={0}
        x={-410}
        y={34}
        textAlign={"left"}
        offsetX={-1}
      />
    </Layout>,
  );

  // Slide the whole group in, then open the plate and fade the text up.
  yield* group().x(0, IN_DURATION, easeOutCubic);
  yield* all(
    bar().height(150, IN_DURATION * 0.6, easeOutCubic),
    plate().height(150, IN_DURATION * 0.6, easeOutCubic),
  );
  yield* all(
    titleRef().opacity(1, 0.3, easeOutCubic),
    subtitleRef().opacity(1, 0.3, easeOutCubic),
  );

  yield* waitFor(hold);

  yield* all(
    titleRef().opacity(0, OUT_DURATION * 0.6, easeInCubic),
    subtitleRef().opacity(0, OUT_DURATION * 0.6, easeInCubic),
  );
  yield* group().x(-1400, OUT_DURATION, easeInCubic);
});
