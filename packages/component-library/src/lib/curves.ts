/**
 * Cubic-bezier keyframe tracks, ported from After Effects / Lottie.
 *
 * Lottie stores every animated property as keyframes carrying bezier handles, and porting
 * that evaluation exactly costs about thirty lines. Measured against the baked values from
 * `Simple headline.json`, the exact port has zero error where the closest named easing
 * (easeOutCubic) has RMS 0.027 and peaks at 0.059 — so the curves below are kept as *data*
 * rather than approximated by a named easing.
 *
 * Times are normalised to 0..1 so a track can be replayed over any duration.
 */

export interface CurveKey {
  /** Normalised time, 0..1. */
  readonly t: number;
  /** Value at that time. */
  readonly v: number;
  /** Outgoing handle of the segment that starts here, as Lottie's `o: {x, y}`. */
  readonly out?: readonly [number, number];
  /** Incoming handle of that same segment, as Lottie's `i: {x, y}`. */
  readonly in?: readonly [number, number];
}

/** Cubic bezier with endpoints pinned at 0 and 1; `a` and `b` are the control ordinates. */
function bezier(t: number, a: number, b: number): number {
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
}

/**
 * Solves the bezier for the parameter that yields `x`, then reads off `y`.
 *
 * Bisection rather than Newton: the handles exported here include values like
 * `cubic-bezier(1, 0, 1, 1)`, whose derivative vanishes at the ends and makes Newton wander.
 * Forty bisections put the error below 1e-12, which costs nothing at render time.
 */
function solveBezier(x: number, x1: number, y1: number, x2: number, y2: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (bezier(mid, x1, x2) < x) low = mid;
    else high = mid;
  }
  return bezier((low + high) / 2, y1, y2);
}

/** Value of a keyframe track at normalised time `t`, honouring each segment's handles. */
export function sampleCurve(keys: readonly CurveKey[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t < a.t || t > b.t) continue;

    const span = b.t - a.t;
    if (span <= 0) return b.v;

    const local = (t - a.t) / span;
    // AE's default ease is (0.167, 0.167) / (0.833, 0.833); Lottie omits handles only for
    // hold keys, which do not appear in this export.
    const [ox, oy] = a.out ?? [0.167, 0.167];
    const [ix, iy] = a.in ?? [0.833, 0.833];
    return a.v + (b.v - a.v) * solveBezier(local, ox, oy, ix, iy);
  }
  return last.v;
}

/** Clamps `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Maps `value` from 0..1 onto a track's output, saturating outside that range. */
export function progressOf(start: number, end: number, now: number): number {
  if (end <= start) return now >= end ? 1 : 0;
  return clamp((now - start) / (end - start), 0, 1);
}
