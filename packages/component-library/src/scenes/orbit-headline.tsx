import { Txt, makeScene2D } from "@motion-canvas/2d";
import { createRef, createSignal, tween, useScene, waitFor } from "@motion-canvas/core";

import { clamp, progressOf, sampleCurve, type CurveKey } from "../lib/curves";

/*
 * Parametric reconstruction of "Simple headline" (After Effects -> Bodymovin), 168 frames
 * at 30fps, 1920x1080.
 *
 * What the source actually does, established by composing each word's full parent chain
 * rather than by reading the layer names:
 *
 *   - The words never rotate. Their world rotation is ~0 for the whole phrase (measured:
 *     0.00, 0.02, 0.01, 0.00, ... ). The 84 baked per-frame rotation keys on each text layer
 *     are exactly the counter-rotation of the parent nulls - AE keeping the word upright
 *     while the rig swings it. All four words share one curve offset by a constant
 *     ("You" = "listen" + 14 exactly), which is the giveaway.
 *   - So the visible motion is POSITIONAL: each word travels along a shallow arc, because it
 *     is parented to a null that rotates -29deg -> 0 -> +40deg about the group centre.
 *   - Under that, a two-null group zoom runs 0.969 -> 1.612 over the whole comp, and the
 *     second null adds a 0 -> 27.833deg rotation that also only moves words, never turns them.
 *   - Each word scales in 75% -> 100% over a third of its phrase, staggered by entry time.
 *   - It is two phrases in sequence, not one headline: "You talk" (frames 0-84) then
 *     "I'll listen" (84-168).
 *
 * Everything below is driven by normalised curve tables ported from the file, so the whole
 * animation stretches or compresses to any `durationInSeconds`.
 */

/** Per-word scale-in: 75% -> 100%, source handles cubic-bezier(0.001, 0, 0.156, 1). */
const SCALE_IN: readonly CurveKey[] = [
  { t: 0, v: 0.75, out: [0.001, 0], in: [0.156, 1] },
  { t: 1, v: 1 },
];

/** Fraction of a phrase the scale-in occupies (28 of 84 frames in the source). */
const SCALE_IN_FRACTION = 28 / 84;

/**
 * The orbit sweep that carries a word along its arc, in degrees, over the span from that
 * word's entry to the end of its phrase. Source: -29 -> 0 -> +40 with handles
 * (0.001, 0, 0, 1) then (1, 0, 1, 1) - fast out of the start, slow through zero, then
 * accelerating away. The closest named easing is linear at RMS 0.174, which is why this is
 * a table and not an easing.
 */
const ORBIT_SWEEP: readonly CurveKey[] = [
  { t: 0, v: -29, out: [0.001, 0], in: [0, 1] },
  { t: 0.5, v: 0, out: [1, 0], in: [1, 1] },
  { t: 1, v: 40 },
];

/** "[Null] Linear scale": 100% -> 125% -> 120%, AE default ease. Times over the whole comp. */
const GROUP_SCALE_LINEAR: readonly CurveKey[] = [
  { t: 0, v: 1, out: [0.167, 0.167], in: [0.833, 0.833] },
  { t: 167.5 / 168, v: 1.25, out: [0.167, 0.167], in: [0.833, 0.833] },
  { t: 1, v: 1.2 },
];

/** "[Null] Eased scale": 96.9% -> 100% -> 120% -> 130%, with its own handles. */
const GROUP_SCALE_EASED: readonly CurveKey[] = [
  { t: 0, v: 0.969, out: [0, 0], in: [1, 1] },
  { t: 45 / 168, v: 1, out: [0.9, 0.241], in: [0.1, 0.753] },
  { t: 123 / 168, v: 1.2, out: [1, 0.302], in: [1, 1] },
  { t: 167.5 / 168, v: 1.3 },
];

/** The same null's rotation, 0 -> 27.833deg. Moves words around the centre; never turns them. */
const GROUP_ROTATION: readonly CurveKey[] = [
  { t: 0, v: 0, out: [0, 0], in: [1, 1] },
  { t: 167 / 168, v: 27.833 },
];

/** Source layout: words step diagonally, ~0.82 x fontSize across and ~0.85 down. */
const STEP_X_EM = 0.82;
const STEP_Y_EM = 0.85;

/** Source text block: 145px type with -60/1000em tracking. */
const FONT_SIZE = 145;
const TRACKING_EM = -0.06;

/** Keep the arranged block inside this fraction of the frame. */
const FIT_MARGIN = 0.9;

interface WordPlan {
  readonly text: string;
  readonly phrase: number;
  readonly indexInPhrase: number;
  /** Normalised global times. */
  readonly enter: number;
  readonly phraseStart: number;
  readonly phraseEnd: number;
  /** The final phrase stays on screen through progress 1 instead of blinking out. */
  readonly isLastPhrase: boolean;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Splits the headline into phrases on "|" and words on whitespace.
 *
 * A single text param has to carry the source's two-phrase structure somehow, and the param
 * vocabulary has no array type, so "|" marks a phrase break: "You talk | I'll listen" is the
 * original, "Ship it" is simply one phrase.
 */
function planWords(text: string, staggerSeconds: number, duration: number): WordPlan[] {
  const phrases = text
    .split("|")
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);

  const safePhrases = phrases.length > 0 ? phrases : [["Headline"]];
  const phraseSpan = 1 / safePhrases.length;

  const plan: WordPlan[] = [];
  safePhrases.forEach((words, phraseIndex) => {
    const phraseStart = phraseIndex * phraseSpan;
    const phraseEnd = phraseStart + phraseSpan;

    // Stagger in seconds, but capped so a short duration cannot push the last word's entry
    // past the point where it still has time to arrive.
    const maxStagger = (phraseSpan * duration * 0.25) / Math.max(1, words.length - 1);
    const stagger = Math.min(staggerSeconds, maxStagger) / duration;

    words.forEach((word, wordIndex) => {
      const centred = wordIndex - (words.length - 1) / 2;
      plan.push({
        text: word,
        phrase: phraseIndex,
        indexInPhrase: wordIndex,
        enter: phraseStart + stagger * wordIndex,
        phraseStart,
        phraseEnd,
        isLastPhrase: phraseIndex === safePhrases.length - 1,
        offsetX: centred * STEP_X_EM * FONT_SIZE,
        offsetY: centred * STEP_Y_EM * FONT_SIZE,
      });
    });
  });
  return plan;
}

export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const text = String(variables.get("text", "You talk | I'll listen")());
  const fontFamily = String(variables.get("fontFamily", "Archivo Black")());
  const textColor = String(variables.get("textColor", "#00004d")());
  const totalDuration = Number(variables.get("durationInSeconds", 5.6)());
  const zoomAmount = Number(variables.get("zoomAmount", 1)());
  const driftAmount = Number(variables.get("driftAmount", 1)());
  const settleAmount = Number(variables.get("settleAmount", 0)());
  const staggerSeconds = Number(variables.get("staggerSeconds", 0.12)());

  const plan = planWords(text, staggerSeconds, totalDuration);
  const frame = view.size();

  /** Global progress, 0..1 across the whole clip. Every property below reads this. */
  const progress = createSignal(0);

  const groupZoom = (now: number) => {
    const source =
      sampleCurve(GROUP_SCALE_LINEAR, now) * sampleCurve(GROUP_SCALE_EASED, now);
    // zoomAmount 1 reproduces the source, 0 holds still, >1 exaggerates.
    return 1 + (source - 1) * zoomAmount;
  };

  const refs = plan.map(() => createRef<Txt>());

  view.add(
    <>
      {plan.map((word, index) => (
        <Txt
          ref={refs[index]}
          key={`word-${word.phrase}-${word.indexInPhrase}`}
          text={word.text}
          fontFamily={`${fontFamily}, "Arial Black", sans-serif`}
          fontSize={FONT_SIZE}
          fontWeight={900}
          letterSpacing={TRACKING_EM * FONT_SIZE}
          fill={textColor}
        />
      ))}
    </>,
  );

  // Fit each phrase into the frame independently, measured from the laid-out text rather
  // than guessed from character counts. Per phrase rather than once for the whole headline:
  // a single global scale is set by the longest phrase, which leaves a one-word phrase
  // rendering tiny next to a three-word one.
  const peakZoom = Math.max(groupZoom(0), groupZoom(0.75), groupZoom(1));
  const phraseCount = plan.reduce((max, word) => Math.max(max, word.phrase + 1), 0);
  const fitScales = Array.from({ length: phraseCount }, (_unused, phraseIndex) => {
    let minX = 0;
    let maxX = 0;
    let minY = 0;
    let maxY = 0;
    plan.forEach((word, index) => {
      if (word.phrase !== phraseIndex) return;
      const size = refs[index]().size();
      minX = Math.min(minX, word.offsetX - size.x / 2);
      maxX = Math.max(maxX, word.offsetX + size.x / 2);
      minY = Math.min(minY, word.offsetY - size.y / 2);
      maxY = Math.max(maxY, word.offsetY + size.y / 2);
    });
    const blockWidth = Math.max(1, maxX - minX);
    const blockHeight = Math.max(1, maxY - minY);
    return Math.min(
      1,
      (frame.x * FIT_MARGIN) / (blockWidth * peakZoom),
      (frame.y * FIT_MARGIN) / (blockHeight * peakZoom),
    );
  });

  plan.forEach((word, index) => {
    const node = refs[index]();

    /** How far this word is through its own arc: entry -> end of its phrase. */
    const wordProgress = () => progressOf(word.enter, word.phraseEnd, progress());

    /** Total angle applied to this word's offset: its own orbit plus the group rotation. */
    const angle = () =>
      (sampleCurve(ORBIT_SWEEP, wordProgress()) * driftAmount +
        sampleCurve(GROUP_ROTATION, progress())) *
      (Math.PI / 180);

    const zoom = () => groupZoom(progress()) * fitScales[word.phrase];

    // Position is the layout offset rotated about the group centre - the words travel, and
    // (unless settleAmount says otherwise) never turn, exactly as the source does.
    node.x(() => (word.offsetX * Math.cos(angle()) - word.offsetY * Math.sin(angle())) * zoom());
    node.y(() => (word.offsetX * Math.sin(angle()) + word.offsetY * Math.cos(angle())) * zoom());

    node.scale(() => {
      const entry = progressOf(
        word.enter,
        word.enter + (word.phraseEnd - word.phraseStart) * SCALE_IN_FRACTION,
        progress(),
      );
      return sampleCurve(SCALE_IN, entry) * zoom();
    });

    // Off by default: the source keeps every word upright. Non-zero adds a decaying wobble
    // on entry for anyone who wants the rotating-settle reading of "orbit".
    node.rotation(() => {
      if (settleAmount === 0) return 0;
      const u = wordProgress();
      return settleAmount * Math.exp(-4 * u) * Math.cos(2 * Math.PI * 1.5 * u);
    });

    // A word exists only within its own phrase, which is what makes the second phrase
    // replace the first rather than pile on top of it.
    node.opacity(() => {
      const now = progress();
      if (now < word.enter - 1e-6) return 0;
      // Non-final phrases end where the next begins; the last one runs to the very end, so
      // the exported clip does not finish on an empty frame.
      return word.isLastPhrase || now < word.phraseEnd - 1e-6 ? 1 : 0;
    });
  });

  yield* tween(totalDuration, (value) => progress(clamp(value, 0, 1)));
  // Hold the final frame for an instant so the last phrase is not cut mid-pixel.
  yield* waitFor(0);
});
