/**
 * Thread pacing and the house ease-out, ported from ui-animation's
 * `ui-snap/src/lib/timeline.ts`, plus the multi-message text encoding.
 *
 * Every constant below is verified against that file (2026-09-10). One correction to the
 * extraction report that fed this work: HOLD_OUT was missing from it, and the total duration
 * is `cursor + HOLD_OUT`, so a thread built without it finishes 1.6s early.
 */

/** A beat of empty screen before anything arrives. */
export const LEAD_IN = 0.35;
/** Beat after one of your lines before her typing dots appear. */
export const SHE_REACTS = 0.45;
/** Still frames at the end, so the last line can be read. */
export const HOLD_OUT = 1.6;
/** Seconds before one of your messages appears — you, thinking and typing. */
export const USER_DELAY = 0.5;

/**
 * How long a bubble takes to land: 240ms.
 *
 * Deliberately NOT scaled by `durationInSeconds`, which breaks this library's usual
 * everything-scales-proportionally convention. The source is explicit that UI motion stays
 * under 300ms and that "a dropdown that takes 400ms feels broken" — the pacing of a
 * conversation is meant to come from the pauses, not from slowing the bubbles down. A 2x
 * stretch would put the entrance at 480ms and lose the thing being ported.
 */
export const ENTER = 0.24;

/**
 * How long she "types" before a line lands: longer messages take longer, clamped at both
 * ends so a one-word reply still reads as a pause and an essay does not stall the clip.
 * Computed per message from its own word count — never a manual parameter.
 */
export function typingFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(2.4, Math.max(0.7, 0.55 + words * 0.13));
}

export type Sender = "sent" | "received";

export interface ChatMessage {
  from: Sender;
  /** Body with the action asterisks already stripped. */
  text: string;
  /** Whole-message roleplay action — renders italic. */
  action: boolean;
}

export interface TimedMessage {
  message: ChatMessage;
  /** When the bubble starts landing. */
  appearAt: number;
  /** Received lines only: when the typing dots appear. They give way at `appearAt`. */
  typingFrom: number | null;
}

export interface Timeline {
  items: TimedMessage[];
  /** Total length including the hold at the end. */
  duration: number;
}

/**
 * Replika's roleplay convention, from the source: physical actions in *single asterisks*,
 * dialogue plain, never mixed. "Never mixed" makes it a whole-message question rather than
 * an inline one, so an action is a message that is entirely wrapped and renders italic with
 * the asterisks removed. The inner match rejects asterisks on purpose — a greedy one would
 * read "*waves* then *grins*" as one action and swallow the middle pair; that line breaks
 * the convention, so it is left exactly as typed.
 */
const ACTION = /^\*([^*]+)\*$/;

export function readAction(text: string): { body: string; action: boolean } {
  const m = text.trim().match(ACTION);
  return m ? { body: m[1].trim(), action: true } : { body: text, action: false };
}

const PREFIX = /^(sent|received|s|r)::?\s*/i;

/**
 * Parses the multi-message `text` param.
 *
 * The param vocabulary has no array type, so several messages ride in one string — the same
 * problem orbit-headline-Rep solves with "|" for phrase breaks. Here each message is one
 * line (or one "|"-separated part, since not every path into a text param is guaranteed to
 * preserve newlines), optionally prefixed with its sender:
 *
 *     received: hey, are you around?
 *     sent: just got back - what's up
 *     received: tell me everything
 *
 * - `received:` / `sent:`, or the short `r:` / `s:`, case-insensitive.
 * - No prefix: alternate from the previous message, starting with `received`. So a bare
 *   list of lines is a back-and-forth without any markup at all.
 * - A doubled colon escapes: `sent:: no really` is a message whose text is "sent: no really".
 * - Blank lines are ignored, so paragraph spacing in the param does not create empty bubbles.
 * - `*wrapped in asterisks*` marks a roleplay action (see readAction).
 */
export function parseThread(text: string): ChatMessage[] {
  const parts = text
    .split(/\r?\n|\|/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const messages: ChatMessage[] = [];
  for (const part of parts) {
    const match = part.match(PREFIX);
    let from: Sender;
    let body: string;
    if (match) {
      const escaped = match[0].includes("::");
      if (escaped) {
        // Doubled colon: strip one colon, keep the word as literal text, and fall through
        // to the alternating rule for the sender.
        body = part.replace("::", ":");
        from = nextSender(messages);
      } else {
        const marker = match[1].toLowerCase();
        from = marker === "s" || marker === "sent" ? "sent" : "received";
        body = part.slice(match[0].length);
      }
    } else {
      from = nextSender(messages);
      body = part;
    }
    const { body: stripped, action } = readAction(body);
    if (stripped.length === 0) continue;
    messages.push({ from, text: stripped, action });
  }
  return messages;
}

/** Alternate from the previous message; an unmarked thread opens with a received line. */
function nextSender(messages: ChatMessage[]): Sender {
  const last = messages[messages.length - 1];
  if (!last) return "received";
  return last.from === "received" ? "sent" : "received";
}

/**
 * Lays the messages out on the clock.
 *
 * The pause belongs to the message that is ABOUT to arrive, not to the one that just did,
 * which is what lets a delay mean one thing wherever it lands. The first message skips its
 * pause — the lead-in already covers it.
 *
 * `pace` scales the pauses only (lead-in, reaction beats, user delays, typing, and the tail
 * hold). The 240ms entrance is fixed; see ENTER.
 */
export function buildTimeline(messages: ChatMessage[], pace = 1): Timeline {
  let cursor = LEAD_IN * pace;
  const items: TimedMessage[] = [];

  messages.forEach((message, i) => {
    if (message.from === "received") {
      if (i > 0) cursor += SHE_REACTS * pace;
      const typingFrom = cursor;
      const appearAt = cursor + typingFor(message.text) * pace;
      items.push({ message, appearAt, typingFrom });
      cursor = appearAt + ENTER;
    } else {
      if (i > 0) cursor += USER_DELAY * pace;
      items.push({ message, appearAt: cursor, typingFrom: null });
      cursor += ENTER;
    }
  });

  return { items, duration: cursor + HOLD_OUT * pace };
}

/**
 * The pace factor that makes a thread last exactly `target` seconds.
 *
 * Solved rather than applied blind, because the entrances do not scale: the fixed cost is
 * ENTER per message, and only the remainder is elastic. Below the fixed cost there is
 * nothing left to compress, so the factor floors at a small positive value and the clip
 * simply runs longer than asked — reporting a wrong duration would be worse than
 * overrunning one.
 */
export function paceFor(messages: ChatMessage[], target: number): number {
  const natural = buildTimeline(messages, 1).duration;
  const fixed = messages.length * ENTER;
  const elastic = natural - fixed;
  if (elastic <= 0) return 1;
  return Math.max(0.05, (target - fixed) / elastic);
}

// ── Easing ──────────────────────────────────────────────────────────────────
// The house ease-out, cubic-bezier(0.23, 1, 0.32, 1), evaluated in JS because the render
// samples the animation at arbitrary instants. A real solver fed the real control points,
// not an approximation of the curve's shape — a hand-rolled cubic or a back-out formula
// would drift from what the rest of the interface does.
//
// Newton-Raphson, four iterations, exactly as the source (and the browser) does it. This
// library's curves.ts uses bisection instead, because the Lottie handles it carries include
// cubic-bezier(1, 0, 1, 1), whose vanishing derivative makes Newton wander; that is not a
// risk at (0.23, 1, 0.32, 1), and matching the source's method keeps the two numerically
// identical rather than merely close.

const bezier = (t: number, a: number, b: number) => {
  const c = 3 * a;
  const d = 3 * (b - a) - c;
  const e = 1 - c - d;
  return ((e * t + d) * t + c) * t;
};
const bezierSlope = (t: number, a: number, b: number) => {
  const c = 3 * a;
  const d = 3 * (b - a) - c;
  const e = 1 - c - d;
  return (3 * e * t + 2 * d) * t + c;
};

export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  return (p: number): number => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 4; i += 1) {
      const slope = bezierSlope(t, x1, x2);
      if (slope === 0) break;
      t -= (bezier(t, x1, x2) - p) / slope;
    }
    return bezier(t, y1, y2);
  };
}

/** cubic-bezier(0.23, 1, 0.32, 1) — the house ease-out. */
export const easeOut = cubicBezier(0.23, 1, 0.32, 1);

/** 0 -> 1 over the bubble's entrance, then pinned at 1. */
export function enterProgress(t: number, appearAt: number): number {
  if (t <= appearAt) return 0;
  if (t >= appearAt + ENTER) return 1;
  return (t - appearAt) / ENTER;
}

/** Is she typing at time t, and has that line not landed yet? */
export function isTyping(item: TimedMessage, t: number): boolean {
  return item.typingFrom !== null && t >= item.typingFrom && t < item.appearAt;
}

// ── Typing dots ─────────────────────────────────────────────────────────────

/** Seconds for one dot to complete its cycle. */
export const DOT_PERIOD = 1.15;
/**
 * Per-dot offset — a fraction of a CYCLE, not seconds.
 *
 * The source adds it to the phase, `(t/PERIOD + index*STAGGER) % 1`, so the wall-clock
 * offset is 0.16 x 1.15 = 0.184s. The extraction report read it as 0.16s; kept in phase
 * units here so the arithmetic matches the source exactly.
 */
export const DOT_STAGGER = 0.16;
export const DOT_SIZE = 7;
/** Gap between the dots, and the height of the row they sit in. */
export const DOT_GAP = 5;
export const DOT_ROW_HEIGHT = 19;

/** Opacity and scale of one dot at time `t`. */
export function dotState(t: number, index: number): { opacity: number; scale: number } {
  const phase = (t / DOT_PERIOD + index * DOT_STAGGER) % 1;
  // A cosine, shifted so the dot is at its dimmest when its cycle starts.
  const wave = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
  return { opacity: 0.32 + 0.68 * wave, scale: 0.7 + 0.3 * wave };
}
