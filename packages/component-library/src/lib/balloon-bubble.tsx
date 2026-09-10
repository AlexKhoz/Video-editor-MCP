/**
 * One balloon bubble as a Motion Canvas node tree: the Bézier silhouette, its shadow, and
 * the text laid out on the lines the measurement decided.
 *
 * The bubble is built with its rect centred on the node's origin. `Path` subtracts its own
 * bbox centre from its computed layout (Curve.js), so the drawn silhouette centres on the
 * node position; the bow is symmetric on all four sides, so that centre coincides with the
 * centre of the W x H rect the text is measured into. The text is positioned from the same
 * centre, which keeps the two in register without either one depending on how the bbox
 * happens to sample.
 *
 * Everything here is built at fontSize 16 (scale 1), where every constant in
 * balloon-geometry.ts is exactly as the designer tuned it. Larger output comes from scaling
 * the whole node, never from raising fontSize — `maxWidth` is deliberately absolute in the
 * source, so a bigger font would wrap into more lines inside the same 220px column instead
 * of enlarging the bubble.
 */
import { Circle, Node, Path, Txt } from "@motion-canvas/2d";

import {
  COLUMN_W,
  DEFAULT_BUBBLE_PADY,
  DEFAULT_BUBBLE_SHAPE,
  DEFAULT_BUBBLE_TEXTBOX,
  type Vec,
  buildBubble,
  padYForTextHeight,
  scaleShape,
} from "./balloon-geometry";
import {
  DOT_GAP,
  DOT_ROW_HEIGHT,
  DOT_SIZE,
  type Sender,
  dotState,
} from "./chat-timeline";
import { measureText, type MeasureOptions } from "./text-measure";

/** Verified against chat-bubble.tsx: the only visual difference between senders. */
export const PALETTE: Record<Sender, { fill: string; text: string }> = {
  received: { fill: "#ffffff", text: "#242433" },
  sent: { fill: "#00004D", text: "#ffffff" },
};

/** drop-shadow(0 8px 16px rgba(0,0,0,0.16)) — canvas shadowBlur is the same 2-sigma scale. */
const SHADOW = { color: "rgba(0,0,0,0.16)", blur: 16, offset: [0, 8] as [number, number] };

/** Tracking: the source's -0.01em, resolved against the font size. */
const TRACKING_EM = -0.01;

export interface BuiltBubble {
  node: Node;
  width: number;
  height: number;
}

export interface BubbleOptions {
  fontFamily: string;
  fontSize?: number;
}

function measureOptions(o: BubbleOptions, italic: boolean): MeasureOptions {
  const fontSize = o.fontSize ?? DEFAULT_BUBBLE_TEXTBOX.fontSize;
  const scale = fontSize / DEFAULT_BUBBLE_TEXTBOX.fontSize;
  const padX = DEFAULT_BUBBLE_TEXTBOX.padX * scale;
  return {
    fontFamily: o.fontFamily,
    fontSize,
    lineHeight: DEFAULT_BUBBLE_TEXTBOX.lineHeight,
    fontWeight: 400,
    letterSpacing: TRACKING_EM * fontSize,
    // maxWidthCap is a ceiling on the OUTER padded width, so room for the padding is
    // reserved before the cap is applied. maxWidth itself does not scale with fontSize.
    maxWidth: Math.min(DEFAULT_BUBBLE_TEXTBOX.maxWidth, Math.max(0, COLUMN_W - 2 * padX)),
    fontStyle: italic ? "italic" : "normal",
  };
}

/**
 * The silhouette, drawn behind content of the given size, centred on the node's origin.
 *
 * The path data is rebuilt here with the rect centred rather than using `geo.d` as-is,
 * which keeps the placement independent of how `Path` treats its own bounding box. It does
 * subtract `childrenBBox().center` from its computed layout (Curve.js), and the first
 * attempt at this relied on that plus a symmetric bow to land the rect centre on the node
 * position — it did not: the silhouette rendered a full half-size down and to the right of
 * the text. Pre-centring the coordinates makes the bbox centre ~(0,0), so whatever the
 * component does with it is a no-op and the geometry lands where the arithmetic says.
 */
function centredPathData(w: number, h: number, scale: number): string {
  const geo = buildBubble(w, h, scaleShape(DEFAULT_BUBBLE_SHAPE, scale));
  const dx = -w / 2;
  const dy = -h / 2;
  const p = (v: Vec) => `${v[0] + dx} ${v[1] + dy}`;
  return (
    `M ${p(geo.anchors[0].p)} ` +
    geo.segments.map((s) => `C ${p(s.c1)} ${p(s.c2)} ${p(s.p3)}`).join(" ") +
    " Z"
  );
}

/** The silhouette, drawn behind content of the given size. */
function silhouette(w: number, h: number, fill: string, scale: number): Node {
  return (
    <Path
      data={centredPathData(w, h, scale)}
      fill={fill}
      shadowColor={SHADOW.color}
      shadowBlur={SHADOW.blur * scale}
      shadowOffset={[SHADOW.offset[0] * scale, SHADOW.offset[1] * scale]}
    />
  ) as unknown as Node;
}

/**
 * A text bubble.
 *
 * The lines come from the measurement rather than from Motion Canvas's own wrapping, so the
 * silhouette is drawn around exactly the lines that get rendered. One Txt per line, placed
 * from the rect centre — a single multi-line Txt would leave the line box height up to the
 * font's own metrics instead of the 1.32 the source specifies.
 */
export function buildBubbleNode(
  text: string,
  from: Sender,
  italic: boolean,
  options: BubbleOptions,
): BuiltBubble {
  const o = measureOptions(options, italic);
  const scale = o.fontSize / DEFAULT_BUBBLE_TEXTBOX.fontSize;
  const padX = DEFAULT_BUBBLE_TEXTBOX.padX * scale;

  const measured = measureText(text, o);
  const padY =
    padYForTextHeight(measured.height, measured.lineHeightPx, DEFAULT_BUBBLE_PADY) * scale;

  const w = measured.width + 2 * padX;
  const h = measured.height + 2 * padY;
  const palette = PALETTE[from];

  const node = new Node({});
  node.add(silhouette(w, h, palette.fill, scale));

  measured.lines.forEach((line, i) => {
    node.add(
      (
        <Txt
          text={line}
          fontFamily={o.fontFamily}
          fontSize={o.fontSize}
          fontWeight={o.fontWeight}
          fontStyle={italic ? "italic" : "normal"}
          letterSpacing={o.letterSpacing}
          lineHeight={measured.lineHeightPx}
          fill={palette.text}
          // Anchored at its left edge so the lines share a left margin, as the source's
          // text element does (it is w-fit with no text-align).
          offset={[-1, 0]}
          x={-w / 2 + padX}
          y={-h / 2 + padY + (i + 0.5) * measured.lineHeightPx}
        />
      ) as unknown as Node,
    );
  });

  return { node, width: w, height: h };
}

/**
 * The "she's typing" bubble: three dots in her own bubble shape.
 *
 * Reuses the silhouette rather than drawing a rounded rect, so the shape, fill and shadow
 * are the ones every other bubble uses. Sized around the dot row exactly as the source is —
 * passing children puts its BalloonBubble on the plain shrink-to-fit path, with no text
 * measurement involved.
 */
export function buildTypingNode(
  options: BubbleOptions,
): BuiltBubble & { dots: Node[] } {
  const fontSize = options.fontSize ?? DEFAULT_BUBBLE_TEXTBOX.fontSize;
  const scale = fontSize / DEFAULT_BUBBLE_TEXTBOX.fontSize;
  const padX = DEFAULT_BUBBLE_TEXTBOX.padX * scale;
  const padY = DEFAULT_BUBBLE_PADY.base * scale;

  const rowWidth = (3 * DOT_SIZE + 2 * DOT_GAP) * scale;
  const rowHeight = DOT_ROW_HEIGHT * scale;
  const w = rowWidth + 2 * padX;
  const h = rowHeight + 2 * padY;

  const node = new Node({});
  node.add(silhouette(w, h, PALETTE.received.fill, scale));

  const dots: Node[] = [];
  for (let i = 0; i < 3; i += 1) {
    const dot = (
      <Circle
        size={DOT_SIZE * scale}
        fill={PALETTE.received.text}
        x={-rowWidth / 2 + (DOT_SIZE / 2 + i * (DOT_SIZE + DOT_GAP)) * scale}
        y={0}
      />
    ) as unknown as Node;
    dots.push(dot);
    node.add(dot);
  }

  return { node, width: w, height: h, dots };
}

/** Applies the dot pulse for time `t`. Kept next to the builder so the two cannot drift. */
export function applyDotState(dots: Node[], t: number): void {
  dots.forEach((dot, i) => {
    const { opacity, scale } = dotState(t, i);
    dot.opacity(opacity);
    dot.scale(scale);
  });
}

/**
 * The entrance transform, as a position offset, scale and opacity.
 *
 * The source anchors the growth to the corner the bubble belongs to, so it expands away
 * from its own side of the column rather than from the middle. Motion Canvas scales about
 * the node's origin, so the equivalent corner-anchored scale is applied here as an explicit
 * compensating translation: scaling by s about a corner at `c` (relative to the centre)
 * moves the centre to `c·(1 − s)`.
 */
export function entranceTransform(
  eased: number,
  from: Sender,
  width: number,
  height: number,
): { x: number; y: number; scale: number; opacity: number } {
  const scale = 0.94 + 0.06 * eased;
  const corner = {
    x: from === "sent" ? width / 2 : -width / 2,
    y: height / 2,
  };
  return {
    x: corner.x * (1 - scale),
    y: corner.y * (1 - scale) + (1 - eased) * 10,
    scale,
    opacity: eased,
  };
}

export { COLUMN_W };
