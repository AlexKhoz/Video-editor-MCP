/**
 * chat-thread-Rep — a Replika conversation playing out, bubble by bubble.
 *
 * The pacing is ported from ui-animation's timeline.ts: a 0.35s lead-in, 0.5s before each of
 * your lines, a 0.45s beat before her typing dots, typing scaled to her message's own word
 * count, and a 1.6s hold at the end so the last line can be read. See lib/chat-timeline.ts.
 *
 * The column is bottom-anchored and grows upward, which is what the source's scroll pin
 * produces: the newest bubble sits at the baseline and the thread shifts up as each one
 * lands — including the temporary shift when the typing bubble appears and is then replaced
 * in place by the line it was standing in for.
 */
import { Node, makeScene2D } from "@motion-canvas/2d";
import { createSignal, tween, useScene } from "@motion-canvas/core";

import {
  COLUMN_W,
  buildBubbleNode,
  buildTypingNode,
  entranceTransform,
} from "../lib/balloon-bubble";
import { GAP_CROSS, GAP_SAME } from "../lib/balloon-geometry";
import { FONT_FAMILY, FONT_URL } from "../lib/chat-font";
import {
  buildTimeline,
  dotState,
  easeOut,
  enterProgress,
  isTyping,
  paceFor,
  parseThread,
  type Sender,
} from "../lib/chat-timeline";
import { ensureFont } from "../lib/text-measure";

/** Share of the frame the column is allowed to occupy. */
const FIT_MARGIN = 0.9;

const DEFAULT_THREAD = [
  "received: hey! how did it go?",
  "sent: better than I expected",
  "received: I knew it would",
].join("\n");

interface Row {
  from: Sender;
  height: number;
  /** Centre y once the stack is anchored. */
  y: number;
}

export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const rawText = String(variables.get("text", DEFAULT_THREAD)());
  const totalDuration = Number(variables.get("durationInSeconds", 8)());

  // A fallback font would give the text a different width and the silhouette would be drawn
  // to match, with nothing visibly wrong. Throws rather than rendering in the wrong face.
  yield ensureFont(FONT_FAMILY, FONT_URL);

  const parsed = parseThread(rawText);
  const messages = parsed.length > 0 ? parsed : parseThread(DEFAULT_THREAD);

  // Solved rather than applied blind: the 240ms entrances do not scale, so only the pauses
  // take up the slack. See paceFor.
  const pace = paceFor(messages, totalDuration);
  const timeline = buildTimeline(messages, pace);

  const bubbles = messages.map((message) =>
    buildBubbleNode(message.text, message.from, message.action, { fontFamily: FONT_FAMILY }),
  );
  const typing = buildTypingNode({ fontFamily: FONT_FAMILY });

  /**
   * Which rows are on screen at time `t`, and how tall the stack is.
   *
   * Gaps follow the source's rhythm: 6px within one sender's burst, 12px when the sender
   * changes. The typing bubble is always hers, so its gap is measured against whoever spoke
   * last — 6px after one of her lines, 12px after one of yours.
   */
  const stackAt = (t: number) => {
    const indices: number[] = [];
    let typingActive = false;

    for (let i = 0; i < timeline.items.length; i += 1) {
      const item = timeline.items[i];
      if (t >= item.appearAt) {
        indices.push(i);
      } else if (isTyping(item, t)) {
        typingActive = true;
        break;
      } else {
        break;
      }
    }

    const heights: { from: Sender; height: number }[] = indices.map((i) => ({
      from: messages[i].from,
      height: bubbles[i].height,
    }));
    if (typingActive) heights.push({ from: "received", height: typing.height });

    let total = 0;
    heights.forEach((row, i) => {
      if (i > 0) total += heights[i - 1].from === row.from ? GAP_SAME : GAP_CROSS;
      total += row.height;
    });

    return { indices, heights, typingActive, total };
  };

  // The zoom has to suit the tallest the column ever gets. It only grows, so the settled
  // layout is the worst case — with the typing states checked too, since a typing bubble
  // taller than the line it precedes would briefly exceed it.
  const probes = [timeline.duration];
  for (const item of timeline.items) {
    probes.push(item.appearAt);
    if (item.typingFrom !== null) probes.push(item.typingFrom + 1e-6);
  }
  const tallest = Math.max(...probes.map((t) => stackAt(t).total), 1);

  /**
   * The stack laid out, with the LAST row's bottom edge pinned to the baseline — the bottom
   * of the region the settled thread will fill. Earlier rows therefore sit above it and
   * shift up as new ones arrive, which is the upward growth the source's pin produces.
   */
  const layoutAt = (t: number) => {
    const { indices, heights, typingActive, total } = stackAt(t);
    const rows: Row[] = [];
    let cursor = tallest / 2 - total;
    heights.forEach((row, i) => {
      if (i > 0) cursor += heights[i - 1].from === row.from ? GAP_SAME : GAP_CROSS;
      rows.push({ from: row.from, height: row.height, y: cursor + row.height / 2 });
      cursor += row.height;
    });
    return { rows, indices, typingActive };
  };

  /** Seconds into the clip. Every property below reads this. */
  const now = createSignal(0);

  const frame = view.size();
  const zoom = Math.min((frame.x * FIT_MARGIN) / COLUMN_W, (frame.y * FIT_MARGIN) / tallest);
  const column = (<Node scale={zoom} />) as unknown as Node;

  bubbles.forEach((bubble, i) => {
    const item = timeline.items[i];
    const from = messages[i].from;
    const restX =
      from === "sent" ? COLUMN_W / 2 - bubble.width / 2 : -COLUMN_W / 2 + bubble.width / 2;

    /** This bubble's row in the current stack, or null while it has not arrived. */
    const row = () => {
      const { rows, indices } = layoutAt(now());
      const at = indices.indexOf(i);
      return at === -1 ? null : rows[at];
    };

    const enter = () =>
      entranceTransform(
        easeOut(enterProgress(now(), item.appearAt)),
        from,
        bubble.width,
        bubble.height,
      );

    bubble.node.x(() => restX + enter().x);
    bubble.node.y(() => (row()?.y ?? 0) + enter().y);
    bubble.node.scale(() => enter().scale);
    bubble.node.opacity(() => (row() === null ? 0 : enter().opacity));
    column.add(bubble.node);
  });

  // One typing node, reused for every pending line: only one line can be pending at a time,
  // and the source relies on the same fact.
  const pending = () => timeline.items.find((item) => isTyping(item, now())) ?? null;

  /** The typing bubble's entrance, from when the dots appeared. Hers, so bottom-left. */
  const typingEnter = () => {
    const item = pending();
    if (!item || item.typingFrom === null) {
      return { x: 0, y: 0, scale: 1, opacity: 0 };
    }
    const eased = easeOut(enterProgress(now(), item.typingFrom));
    return entranceTransform(eased, "received", typing.width, typing.height);
  };

  const typingRestX = -COLUMN_W / 2 + typing.width / 2;
  typing.node.x(() => typingRestX + typingEnter().x);
  typing.node.y(() => {
    const { rows, typingActive } = layoutAt(now());
    return (typingActive ? rows[rows.length - 1].y : 0) + typingEnter().y;
  });
  typing.node.scale(() => typingEnter().scale);
  typing.node.opacity(() => typingEnter().opacity);

  // The dots pulse on their own clock, from the moment they appeared. Driven as reactive
  // properties rather than written from inside another property's getter, so nothing
  // depends on which order Motion Canvas happens to evaluate them in.
  typing.dots.forEach((dot, index) => {
    const state = () => {
      const item = pending();
      return dotState(item?.typingFrom != null ? now() - item.typingFrom : 0, index);
    };
    dot.opacity(() => state().opacity);
    dot.scale(() => state().scale);
  });
  column.add(typing.node);

  view.add(column);

  yield* tween(timeline.duration, (value) => now(value * timeline.duration));
  now(timeline.duration);
});
