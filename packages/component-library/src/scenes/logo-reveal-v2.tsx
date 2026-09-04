import { Circle, Rect, makeScene2D } from "@motion-canvas/2d";
import {
  all,
  createRef,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  useScene,
  waitFor,
} from "@motion-canvas/core";

const IN_DURATION = 0.9;
const OUT_DURATION = 0.5;
const MIN_HOLD = 0.3;

/** Number of shards that fly in to assemble the mark. */
const SHARDS = 12;

/**
 * A geometric build-up, deliberately different from `logo-reveal`'s badge wipe: shards
 * spiral in from outside the frame and converge into a ring, which then locks in with a
 * scale snap. Gives the library visual variety for the same kind of slot.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const primaryColor = String(variables.get("primaryColor", "#f472b6")());
  const totalDuration = Number(variables.get("durationInSeconds", 3)());

  const hold = Math.max(MIN_HOLD, totalDuration - IN_DURATION - OUT_DURATION);

  const ring = createRef<Circle>();
  const core = createRef<Circle>();
  const shards: ReturnType<typeof createRef<Rect>>[] = [];

  for (let i = 0; i < SHARDS; i += 1) {
    shards.push(createRef<Rect>());
  }

  view.add(
    <>
      <Circle
        ref={ring}
        width={340}
        height={340}
        stroke={primaryColor}
        lineWidth={16}
        scale={0}
        opacity={0}
      />
      <Circle ref={core} width={90} height={90} fill={primaryColor} scale={0} />
      {shards.map((ref, index) => {
        const angle = (index / SHARDS) * Math.PI * 2;
        const radius = 1200;
        return (
          <Rect
            ref={ref}
            key={`shard-${index}`}
            width={90}
            height={14}
            radius={7}
            fill={primaryColor}
            x={Math.cos(angle) * radius}
            y={Math.sin(angle) * radius}
            rotation={(angle * 180) / Math.PI}
            opacity={0}
          />
        );
      })}
    </>,
  );

  // Shards spiral inward, staggered, and land on the ring's circumference.
  yield* all(
    ...shards.map((ref, index) => {
      const angle = (index / SHARDS) * Math.PI * 2;
      const landing = 170;
      const delay = (index / SHARDS) * 0.28;
      return (function* () {
        yield* waitFor(delay);
        yield* all(
          ref().opacity(1, 0.12),
          ref().x(Math.cos(angle) * landing, IN_DURATION * 0.6, easeOutCubic),
          ref().y(Math.sin(angle) * landing, IN_DURATION * 0.6, easeOutCubic),
          ref().rotation((angle * 180) / Math.PI + 90, IN_DURATION * 0.6, easeOutCubic),
        );
      })();
    }),
  );

  // The ring materialises over the landed shards, then the core snaps in.
  yield* all(
    ring().opacity(1, 0.2),
    ring().scale(1, 0.35, easeOutBack),
    ...shards.map((ref) => ref().opacity(0.35, 0.35, easeOutCubic)),
  );
  yield* core().scale(1, 0.3, easeOutBack);

  yield* waitFor(hold);

  yield* all(
    ring().scale(1.15, OUT_DURATION, easeInCubic),
    ring().opacity(0, OUT_DURATION, easeInCubic),
    core().scale(0, OUT_DURATION * 0.7, easeInCubic),
    ...shards.map((ref) => ref().opacity(0, OUT_DURATION * 0.6, easeInCubic)),
  );
});
