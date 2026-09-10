/**
 * chat-bubble-single-Rep — one Replika chat bubble, arriving.
 *
 * A port of ui-animation's balloon bubble: the 8-anchor Bézier silhouette (see
 * lib/balloon-geometry.ts) with the house entrance — 240ms on cubic-bezier(0.23, 1, 0.32, 1),
 * fading, rising 10px and growing from 0.94, anchored to the corner the bubble belongs to.
 *
 * There is no exit. The source's `enterStyle` returns an empty style once the entrance
 * finishes and nothing else ever touches the bubble again, so the clip holds the settled
 * frame for the rest of its duration rather than inventing a way out.
 *
 * The entrance is a fixed 240ms and does NOT stretch with durationInSeconds — see ENTER in
 * lib/chat-timeline.ts for why.
 */
import { Node, makeScene2D } from "@motion-canvas/2d";
import { createSignal, tween, useScene, waitFor } from "@motion-canvas/core";

import {
  COLUMN_W,
  buildBubbleNode,
  entranceTransform,
} from "../lib/balloon-bubble";
import { ENTER, easeOut, enterProgress, readAction, type Sender } from "../lib/chat-timeline";
import { FONT_FAMILY, FONT_URL } from "../lib/chat-font";
import { ensureFont } from "../lib/text-measure";

/** Share of the frame the column is allowed to occupy. */
const FIT_MARGIN = 0.9;

function readSender(raw: string): Sender {
  return raw.trim().toLowerCase().startsWith("s") ? "sent" : "received";
}

export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const rawText = String(variables.get("text", "Hey, are you around?")());
  const sender = readSender(String(variables.get("sender", "received")()));
  const totalDuration = Number(variables.get("durationInSeconds", 2.5)());

  // Before anything is measured: a fallback font would give the text a different width and
  // the silhouette would be drawn to match, with nothing visibly wrong. Throws rather than
  // rendering in the wrong typeface.
  yield ensureFont(FONT_FAMILY, FONT_URL);

  const { body, action } = readAction(rawText);
  const bubble = buildBubbleNode(body, sender, action, { fontFamily: FONT_FAMILY });

  const frame = view.size();
  const zoom = Math.min(
    (frame.x * FIT_MARGIN) / COLUMN_W,
    (frame.y * FIT_MARGIN) / bubble.height,
  );

  /** Seconds into the clip. Every property below reads this. */
  const now = createSignal(0);

  // Aligned to its own side of the column, exactly as the thread lays it out, so a single
  // bubble sits where the same message would in a conversation.
  const restX =
    sender === "sent" ? COLUMN_W / 2 - bubble.width / 2 : -COLUMN_W / 2 + bubble.width / 2;

  const enter = () =>
    entranceTransform(easeOut(enterProgress(now(), 0)), sender, bubble.width, bubble.height);

  bubble.node.x(() => restX + enter().x);
  bubble.node.y(() => enter().y);
  bubble.node.scale(() => enter().scale);
  bubble.node.opacity(() => enter().opacity);

  view.add(<Node scale={zoom}>{bubble.node}</Node>);

  // A clip shorter than the entrance truncates it rather than compressing it: the 240ms is
  // the thing being ported, so a 0.1s clip shows the first 0.1s of the arrival.
  const span = Math.min(ENTER, totalDuration);
  yield* tween(span, (value) => now(value * span));
  now(span);
  yield* waitFor(Math.max(0, totalDuration - span));
});
