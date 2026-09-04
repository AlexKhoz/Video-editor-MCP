import { Rect, Txt, makeScene2D } from "@motion-canvas/2d";
import {
  all,
  createRef,
  createSignal,
  easeInCubic,
  easeOutCubic,
  useScene,
  waitFor,
} from "@motion-canvas/core";

const IN_DURATION = 0.35;
const OUT_DURATION = 0.4;
const MIN_COUNT = 0.4;

/**
 * Data-style stat card: a number counts up to its target while a label sits beneath it.
 * Whole numbers are rendered without decimals; fractional targets keep one decimal.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const label = String(variables.get("label", "Active users")());
  const target = Number(variables.get("targetNumber", 1250)());
  const accentColor = String(variables.get("accentColor", "#34d399")());
  const totalDuration = Number(variables.get("durationInSeconds", 3)());

  const countDuration = Math.max(
    MIN_COUNT,
    totalDuration - IN_DURATION - OUT_DURATION - 0.35,
  );

  const value = createSignal(0);
  const decimals = Number.isInteger(target) ? 0 : 1;
  const formatted = () =>
    value().toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

  const card = createRef<Rect>();
  const number = createRef<Txt>();
  const rule = createRef<Rect>();
  const caption = createRef<Txt>();

  view.add(
    <Rect ref={card} opacity={0} scale={0.94} layout={false}>
      <Txt
        ref={number}
        text={formatted}
        fill={"#ffffff"}
        fontFamily={"Inter, Segoe UI, Helvetica, Arial, sans-serif"}
        fontSize={200}
        fontWeight={800}
        y={-40}
      />
      <Rect ref={rule} width={0} height={8} radius={4} fill={accentColor} y={78} />
      <Txt
        ref={caption}
        text={label}
        fill={accentColor}
        fontFamily={"Inter, Segoe UI, Helvetica, Arial, sans-serif"}
        fontSize={48}
        fontWeight={600}
        letterSpacing={2}
        y={140}
      />
    </Rect>,
  );

  yield* all(
    card().opacity(1, IN_DURATION, easeOutCubic),
    card().scale(1, IN_DURATION, easeOutCubic),
    rule().width(260, IN_DURATION * 1.4, easeOutCubic),
  );

  yield* value(target, countDuration, easeOutCubic);
  yield* waitFor(0.35);

  yield* all(
    card().opacity(0, OUT_DURATION, easeInCubic),
    card().scale(0.96, OUT_DURATION, easeInCubic),
  );
});
