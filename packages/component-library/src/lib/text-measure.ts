/**
 * Text measurement for the balloon bubbles, plus the font-readiness gate.
 *
 * ## Why measure at all
 *
 * The bubble's silhouette is drawn from the measured size of its text box, so W and H are
 * not decoration — they are inputs to the geometry. In the source the browser wraps the
 * text, a ResizeObserver reads the padded box, and PreText re-runs the wrap off-DOM via
 * canvas so the box hugs its widest rendered line instead of staying stretched to maxWidth
 * (a wrapped bubble otherwise keeps 50–100px of dead space on the right). Motion Canvas
 * gives no equivalent, so the wrap is reproduced here: greedy, canvas-measured, with the
 * source's +1px subpixel guard.
 *
 * ## Why the font gate is here
 *
 * A missing @font-face fails silently — the text renders in a fallback, every bubble
 * measures to a different width, and the silhouette is drawn to match, so nothing looks
 * broken enough to notice. The source guards against this at capture time (its readiness
 * check waits on `document.fonts.load` and then polls geometry until it stops moving,
 * precisely because "capture too early and every bubble is a fallback-font width"). This
 * render pipeline had no such gate at all, so `ensureFont` adds one and throws rather than
 * quietly rendering in Arial. See NOTES.md Stage 23.
 */

export interface MeasureOptions {
  fontFamily: string;
  fontSize: number;
  /** Unitless multiplier, as CSS `line-height: 1.32`. */
  lineHeight: number;
  fontWeight: number;
  /** Tracking in px (the source's -0.01em at fontSize 16 is -0.16px). */
  letterSpacing: number;
  /** Widest the text column may become, before padding. */
  maxWidth: number;
  fontStyle?: "normal" | "italic";
}

export interface Measured {
  /** Width of the text column: the widest wrapped line, capped at maxWidth. */
  width: number;
  /** Height of the text body, carrying no padding. */
  height: number;
  lines: string[];
  lineHeightPx: number;
}

let ctx: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D {
  if (ctx) return ctx;
  const canvas = document.createElement("canvas");
  const found = canvas.getContext("2d");
  if (!found) throw new Error("[chat-bubble] no 2D context for text measurement");
  ctx = found;
  return ctx;
}

function fontString(o: MeasureOptions): string {
  return `${o.fontStyle ?? "normal"} ${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`;
}

/**
 * Width of one run of text.
 *
 * Chrome's canvas honours `ctx.letterSpacing`, and where it does we use it so the tracking
 * is applied exactly as the DOM would. Where it does not, tracking is added per character —
 * CSS adds it after every character including the last, and Chrome's canvas implementation
 * agrees, so the manual path matches rather than being one space short.
 */
function widthOf(text: string, o: MeasureOptions): number {
  const c = context();
  c.font = fontString(o);
  const spacing = `${o.letterSpacing}px`;
  let manual = false;
  if ("letterSpacing" in c) {
    (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = spacing;
    manual =
      (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing !== spacing;
  } else {
    manual = true;
  }
  const base = c.measureText(text).width;
  return manual ? base + o.letterSpacing * text.length : base;
}

/**
 * Greedy wrap, modelling the browser's own: break at spaces, and break inside a word only
 * when it cannot fit a line by itself (the source's text element carries `break-words`).
 * Explicit newlines are honoured, as `white-space: pre-wrap` requires.
 */
function wrap(text: string, o: MeasureOptions): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    const push = () => {
      out.push(line);
      line = "";
    };
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (widthOf(candidate, o) <= o.maxWidth || line === "") {
        // A single word wider than the whole column has to break mid-word.
        if (line === "" && widthOf(word, o) > o.maxWidth) {
          let chunk = "";
          for (const ch of word) {
            if (chunk !== "" && widthOf(chunk + ch, o) > o.maxWidth) {
              line = chunk;
              push();
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
          continue;
        }
        line = candidate;
      } else {
        push();
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export function measureText(text: string, o: MeasureOptions): Measured {
  const lines = wrap(text.length > 0 ? text : " ", o);
  const widest = lines.reduce((max, line) => Math.max(max, widthOf(line, o)), 0);
  // +1: canvas widths are subpixel, and rounding a hair under the DOM's own measurement
  // would make the browser wrap one word earlier than predicted. The source errs one pixel
  // wide for the same reason; kept so the two agree.
  const width = Math.min(o.maxWidth, Math.ceil(widest) + 1);
  const lineHeightPx = o.fontSize * o.lineHeight;
  return { width, height: lines.length * lineHeightPx, lines, lineHeightPx };
}

/** A string with enough varied glyphs that two different typefaces cannot measure it alike. */
const PROBE = "Hamburgefonstiv 0123 @&%";

/** Faces already registered in this page, so a second scene does not re-add one. */
const registered = new Set<string>();

/**
 * Registers a font from a URL and proves it actually rendered.
 *
 * The proof is a width probe: measure the probe string in `family` with a fallback behind
 * it, then measure it in a family that certainly does not exist with the same fallback.
 * Both resolve down the same chain, so equal widths mean the real face never arrived.
 *
 * `document.fonts.check()` is deliberately NOT used as the gate. It returns **true for a
 * family that does not exist at all** — measured here: before anything was added,
 * `check('400 16px "DM Sans Rep"')` answered true, which made an earlier version of this
 * function skip the load entirely and then fail its own probe. It reports whether the query
 * can be rendered *somehow*, fallback included, which is the exact question that does not
 * need asking.
 *
 * Throws on failure. A render in the wrong font is worse than no render: it looks fine, and
 * every measured dimension — so every silhouette drawn from one — is wrong.
 */
export async function ensureFont(
  family: string,
  url: string,
  weights: readonly number[] = [400],
): Promise<void> {
  if (typeof document === "undefined") return;

  const key = `${family}|${url}`;
  if (!registered.has(key)) {
    const face = new FontFace(family, `url(${url})`, { weight: "100 1000" });
    try {
      await face.load();
    } catch (error) {
      // FontFace rejects with a bare "A network error occurred" that names neither the font
      // nor the URL, which is a poor thing to find in a render log.
      throw new Error(
        `[chat-bubble] could not fetch font "${family}" from ${url} — ${String(error)}. ` +
          `The asset is imported by chat-font.ts; check it exists and that the dev server ` +
          `serves it.`,
      );
    }
    document.fonts.add(face);
    registered.add(key);
  }

  for (const weight of weights) {
    await document.fonts.load(`${weight} 16px "${family}"`, PROBE);
  }
  await document.fonts.ready;

  const withFamily = widthOf(PROBE, {
    fontFamily: `"${family}", monospace`,
    fontSize: 64,
    lineHeight: 1,
    fontWeight: 400,
    letterSpacing: 0,
    maxWidth: Infinity,
  });
  const fallbackOnly = widthOf(PROBE, {
    fontFamily: `"__definitely_not_a_font_${Date.now()}__", monospace`,
    fontSize: 64,
    lineHeight: 1,
    fontWeight: 400,
    letterSpacing: 0,
    maxWidth: Infinity,
  });

  if (Math.abs(withFamily - fallbackOnly) < 0.5) {
    throw new Error(
      `[chat-bubble] font "${family}" did not load from ${url} — text measured identically ` +
        `to the fallback (${withFamily.toFixed(2)}px vs ${fallbackOnly.toFixed(2)}px). ` +
        `Rendering would silently use a substitute font and every bubble would be the ` +
        `wrong width.`,
    );
  }
}
