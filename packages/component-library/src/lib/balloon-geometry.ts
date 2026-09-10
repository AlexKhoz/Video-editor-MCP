/**
 * Balloon chat-bubble geometry — a port of ui-animation's
 * `ui-snap/src/components/balloon-bubble/geometry.ts` (v2, sagitta-driven).
 *
 * Ported rather than approximated, for the same reason curves.ts keeps Lottie handles as
 * data: the silhouette is not a rounded rectangle and `border-radius` cannot express it.
 * A closed path of 8 cubic Béziers around 8 anchors, alternating EDGE -> CORNER clockwise
 * from the top-left:
 *
 *        a0 ───(top edge)─── a1
 *       /                      \
 *     a7        (corner)        a2
 *      |                        |
 *   (left edge)            (right edge)
 *      |                        |
 *     a6                        a3
 *       \                      /
 *        a5 ──(bottom edge)── a4
 *
 * G1 smoothness holds by construction: every anchor owns ONE tangent line and both the
 * segment arriving and the segment leaving place their handle along it. Convexity holds by
 * the handle clamp near the end of buildBubble — neither handle may reach past the
 * intersection of the two handle rays, so the control polygon cannot fold into an S.
 *
 * Each edge is driven by a target bow height (sagitta) rather than an angle, keyed off the
 * PERPENDICULAR dimension, so a wide-flat bubble still puffs its top and bottom by an amount
 * tied to its height and reads as a puffed pill rather than a stadium:
 *
 *   top / bottom:  sH = min(bowFrac·H, bowMaxPx)      beta = 2·atan(2s / L), capped at 20°
 *   left / right:  sV = min(bowFrac·W, bowMaxPx)      then faded by smoothstep(0, bowRamp, L)
 *
 * Anchor collapse applies to BOTH axes independently at the same `sideCollapse` threshold.
 * Worth stating plainly, because it is counter-intuitive and the extraction report had it
 * backwards: with cornerInset 32 an axis collapses once that dimension drops to 72px or
 * less, and an ordinary single-line bubble is ~45px tall. So collapsed-vertical is the
 * NORMAL case, a short bubble ("Hi") is collapsed on both axes into a 4-anchor lens, and the
 * full 8-anchor topology only appears once the text runs to three lines or so.
 *
 * The one intentional divergence from the source: this file is pure math with no DOM, which
 * it already was — so the port can be checked by numeric identity against the original
 * rather than by eye. See NOTES.md Stage 23.
 */

export type Vec = [number, number];

/** Shape knobs — one shared set is used for every bubble regardless of size. */
export interface BubbleShape {
  /** Target bow height as a fraction of the perpendicular dimension (H for top/bottom, W for sides). */
  bowFrac: number;
  /** Hard cap (px) on the target bow height, so big bubbles do not over-inflate. */
  bowMaxPx: number;
  /** Multiplier on the ideal circular-arc edge handle length (1.0 = exact arc). */
  edgeFullness: number;
  /** Chord length (px) at which an edge's bow tilt reaches full strength; below it beta fades to 0. */
  bowRamp: number;
  /** Corner handle kappa, a fraction of each corner leg: lower reads circular, higher squarish. */
  cornerHandle: number;
  /** Anchor-collapse threshold (px), applied to both axes with the same value. */
  sideCollapse: number;
  /** Distance (px) from each true corner to its two anchors. */
  cornerInset: number;
}

/**
 * Designer-tuned defaults, calibrated at fontSize 16 — the px fields (bowMaxPx, bowRamp,
 * sideCollapse, cornerInset) are scaled by fontSize/16 at render; the ratios are not.
 * Verified against DEFAULT_BUBBLE_SHAPE in the source, 2026-09-10.
 */
export const DEFAULT_BUBBLE_SHAPE: BubbleShape = {
  bowFrac: 0.04,
  bowMaxPx: 4,
  edgeFullness: 0.4,
  bowRamp: 80,
  cornerHandle: 0.6,
  sideCollapse: 8,
  cornerInset: 32,
};

/**
 * Line-height multiple at which a text body counts as "multi-line" for vertical padding.
 *
 * A HEIGHT threshold, not a rounded line count — the source is explicit about why ("stays
 * honest when a line box renders taller than the nominal line-height"). The extraction
 * report described this as "3+ lines"; at lineHeight 1.32 the two happen to agree, but the
 * height form is what the source computes and what is ported here.
 */
export const MULTILINE_AT = 2.5;

/** Vertical padding (px at fontSize 16): `base` for 1–2 lines, `multi` from 3 lines up. */
export interface BubblePadY {
  base: number;
  multi: number;
}
export const DEFAULT_BUBBLE_PADY: BubblePadY = { base: 12, multi: 14 };

/** Canonical text-box sizing. `fontSize` doubles as the geometry scale baseline. */
export const DEFAULT_BUBBLE_TEXTBOX = {
  maxWidth: 220,
  fontSize: 16,
  lineHeight: 1.32,
  padX: 20,
} as const;

/** The chat column's physical width — the hard ceiling on a bubble's outer padded width. */
export const COLUMN_W = 270;

/** Vertical rhythm: 6px inside one sender's burst, 12px across senders. */
export const GAP_SAME = 6;
export const GAP_CROSS = 12;

/** Pick vertical padding from the text-body height (no padding) against the line height. */
export function padYForTextHeight(
  textHeight: number,
  lineHeightPx: number,
  padY: BubblePadY,
): number {
  if (lineHeightPx <= 0) return padY.base;
  return textHeight < MULTILINE_AT * lineHeightPx ? padY.base : padY.multi;
}

/** Hard cap on the per-edge tangent angle (radians). */
const BETA_MAX = (20 * Math.PI) / 180;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface Anchor {
  p: Vec;
  /** Unit tangent in the direction of clockwise travel. */
  t: Vec;
  /** Bulge angle (radians) of the edge this anchor terminates. */
  beta: number;
  /**
   * Corner-handle leg length (px) at this anchor. Decoupled per anchor rather than one
   * shared inset, which is what lets a collapsed side corner be asymmetric: a full-inset
   * horizontal leg by an H/2 vertical leg.
   */
  hs: number;
}

export interface Segment {
  kind: "edge" | "corner";
  p0: Vec;
  c1: Vec;
  c2: Vec;
  p3: Vec;
}

export interface BubbleGeometry {
  anchors: Anchor[];
  segments: Segment[];
  betaH: number;
  betaV: number;
  sagittaH: number;
  sagittaV: number;
  cornerAngleDeg: number;
  /** SVG path data, in a 0,0..W,H coordinate space. */
  d: string;
}

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const scaleVec = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s];
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: Vec, b: Vec) => a[0] * b[1] - a[1] * b[0];

/**
 * Target bow height (sagitta `s`) on a chord of length `L` as an end-tangent angle, via the
 * circular-arc relation, capped and faded so short edges relax toward flat instead of
 * pinning at the cap (which would give the smallest bubbles the steepest tilt).
 */
function edgeBeta(L: number, s: number, ramp: number): number {
  if (L <= 0) return 0;
  const raw = 2 * Math.atan((2 * s) / L);
  const beta = Math.min(raw, BETA_MAX);
  return beta * smoothstep(0, ramp, L);
}

export function buildBubble(W: number, H: number, params: BubbleShape): BubbleGeometry {
  // Decoupled corner insets: the horizontal one is limited only by width, the vertical only
  // by height. They diverge only on a small bubble — exactly where the collapse below makes
  // the corner asymmetric.
  const cH = Math.max(1, Math.min(params.cornerInset, W / 2 - 1));
  const cV = Math.max(1, Math.min(params.cornerInset, H / 2 - 1));

  const topLen = W - 2 * cH;
  const sideLen = H - 2 * cV;

  const targetSH = Math.min(params.bowFrac * H, params.bowMaxPx);
  const targetSV = Math.min(params.bowFrac * W, params.bowMaxPx);

  const betaH = edgeBeta(topLen, targetSH, params.bowRamp);
  const betaV = edgeBeta(sideLen, targetSV, params.bowRamp);

  // Achieved bow height after cap and ramp.
  const sagittaH = (Math.max(0, topLen) / 2) * Math.tan(betaH / 2);
  const sagittaV = (Math.max(0, sideLen) / 2) * Math.tan(betaV / 2);

  const chH = Math.cos(betaH);
  const shH = Math.sin(betaH);
  const chV = Math.cos(betaV);
  const shV = Math.sin(betaV);

  // Anchor collapse, both axes independently. A hard toggle at the threshold, no easing
  // band: the moment an axis's gap crosses it, the two pair anchors become one mid-edge
  // anchor whose tangent runs straight along the edge, so the curve passes through it
  // without a tilt that would unbalance the opposite side.
  const sideGap = H - 2 * params.cornerInset;
  const topGap = W - 2 * params.cornerInset;
  const collapsedV = sideGap <= params.sideCollapse;
  const collapsedH = topGap <= params.sideCollapse;
  const midX = W / 2;
  const midY = H / 2;

  const kappa = params.cornerHandle;

  const topAnchors: Anchor[] = collapsedH
    ? [{ p: [midX, 0], t: [1, 0], beta: betaH, hs: midX }]
    : [
        { p: [cH, 0], t: [chH, -shH], beta: betaH, hs: cH },
        { p: [W - cH, 0], t: [chH, shH], beta: betaH, hs: cH },
      ];
  const rightAnchors: Anchor[] = collapsedV
    ? [{ p: [W, midY], t: [0, 1], beta: betaV, hs: midY }]
    : [
        { p: [W, cV], t: [shV, chV], beta: betaV, hs: cV },
        { p: [W, H - cV], t: [-shV, chV], beta: betaV, hs: cV },
      ];
  const bottomAnchors: Anchor[] = collapsedH
    ? [{ p: [midX, H], t: [-1, 0], beta: betaH, hs: midX }]
    : [
        { p: [W - cH, H], t: [-chH, shH], beta: betaH, hs: cH },
        { p: [cH, H], t: [-chH, -shH], beta: betaH, hs: cH },
      ];
  const leftAnchors: Anchor[] = collapsedV
    ? [{ p: [0, midY], t: [0, -1], beta: betaV, hs: midY }]
    : [
        { p: [0, H - cV], t: [-shV, -chV], beta: betaV, hs: cV },
        { p: [0, cV], t: [shV, -chV], beta: betaV, hs: cV },
      ];

  // A segment is an "edge" only when it joins the two anchors of a non-collapsed pair;
  // everything else, including any link touching a collapsed mid anchor, is a corner. The
  // four topologies fall out: neither collapsed -> 8 anchors, one axis -> 6, both -> 4.
  const anchors: Anchor[] = [];
  const order: { kind: "edge" | "corner"; from: number; to: number }[] = [];
  for (const group of [topAnchors, rightAnchors, bottomAnchors, leftAnchors]) {
    for (let k = 0; k < group.length; k += 1) anchors.push(group[k]);
  }
  {
    let base = 0;
    for (const group of [topAnchors, rightAnchors, bottomAnchors, leftAnchors]) {
      for (let k = 0; k < group.length; k += 1) {
        const from = base + k;
        const to = (from + 1) % anchors.length;
        const kind = group.length === 2 && k === 0 ? "edge" : "corner";
        order.push({ kind, from, to });
      }
      base += group.length;
    }
  }

  const segments: Segment[] = order.map(({ kind, from, to }) => {
    const A = anchors[from];
    const B = anchors[to];
    let c1len: number;
    let c2len: number;
    if (kind === "edge") {
      // Handle length matched to a clean circular-arc bow for this beta.
      const arc = 1 / (3 * Math.cos(A.beta / 2) ** 2);
      c1len = c2len = params.edgeFullness * arc * dist(A.p, B.p);
    } else {
      // Per-END handle length, so an asymmetric collapsed corner stays smooth.
      c1len = kappa * A.hs;
      c2len = kappa * B.hs;
    }
    // Convexity guard — see the header. If the rays are parallel or diverge there is no
    // forward intersection and no fold is possible, so leave the lengths alone.
    const hB: Vec = [-B.t[0], -B.t[1]];
    const den = cross(A.t, hB);
    if (Math.abs(den) > 1e-9) {
      const dAB = sub(B.p, A.p);
      const reachA = cross(dAB, hB) / den;
      const reachB = cross(dAB, A.t) / den;
      if (reachA > 0 && reachB > 0) {
        c1len = Math.min(c1len, reachA);
        c2len = Math.min(c2len, reachB);
      }
    }
    return {
      kind,
      p0: A.p,
      c1: add(A.p, scaleVec(A.t, c1len)),
      c2: sub(B.p, scaleVec(B.t, c2len)),
      p3: B.p,
    };
  });

  const cornerAngleDeg = 90 + ((betaH + betaV) * 180) / Math.PI;

  const d =
    `M ${anchors[0].p[0]} ${anchors[0].p[1]} ` +
    segments
      .map((s) => `C ${s.c1[0]} ${s.c1[1]} ${s.c2[0]} ${s.c2[1]} ${s.p3[0]} ${s.p3[1]}`)
      .join(" ") +
    " Z";

  return { anchors, segments, betaH, betaV, sagittaH, sagittaV, cornerAngleDeg, d };
}

/**
 * The shape with its px fields scaled for a given font size. The ratios (bowFrac,
 * edgeFullness, cornerHandle) pass through untouched — they already resolve against a
 * dimension that scales on its own, so multiplying them would double-count.
 */
export function scaleShape(shape: BubbleShape, scale: number): BubbleShape {
  return {
    ...shape,
    cornerInset: shape.cornerInset * scale,
    sideCollapse: shape.sideCollapse * scale,
    bowMaxPx: shape.bowMaxPx * scale,
    bowRamp: shape.bowRamp * scale,
  };
}
