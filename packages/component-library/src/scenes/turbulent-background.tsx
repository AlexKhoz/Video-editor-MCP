import { Img, makeScene2D } from "@motion-canvas/2d";
import { createSignal, tween, useScene } from "@motion-canvas/core";

import { TURBULENCE_FRAGMENT } from "../shaders/turbulence";

import brand1 from "../../components/turbulent-background/assets/brand-1.jpg";
import brand2 from "../../components/turbulent-background/assets/brand-2.jpg";
import brand3 from "../../components/turbulent-background/assets/brand-3.jpg";
import brand4 from "../../components/turbulent-background/assets/brand-4.jpg";
import brand5 from "../../components/turbulent-background/assets/brand-5.jpg";

const TAU = Math.PI * 2;

/**
 * Radius of the circle walked through the noise field. Bigger means the loop travels
 * further before returning, so more of the field is seen per cycle; too big and a short
 * loop churns visibly fast. 0.6 reads as a slow swell at the default 6s.
 */
const LOOP_RADIUS = 0.6;

/** The bundled brand gradients. Vite hashes and serves these, so nothing resolves a
 * filesystem path at render time and the component works wherever it is checked out. */
const PRESETS: Record<string, string> = {
  "brand-1": brand1,
  "brand-2": brand2,
  "brand-3": brand3,
  "brand-4": brand4,
  "brand-5": brand5,
};

function resolveSource(preset: string, custom: string): string {
  if (preset === "custom") {
    if (!custom) {
      throw new Error(
        'backgroundPreset is "custom" but no image was supplied. Set the "image" parameter ' +
          "to a URL the renderer can fetch (http/https or data:), for example " +
          "http://127.0.0.1:3001/media/<mediaId>.",
      );
    }
    return custom;
  }

  const bundled = PRESETS[preset];
  if (!bundled) {
    throw new Error(
      `Unknown backgroundPreset "${preset}". Use ${Object.keys(PRESETS).join(", ")} or "custom".`,
    );
  }
  return bundled;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Loads an image with CORS enabled.
 *
 * Motion Canvas's own `loadImage` does not set `crossOrigin`, so a remote custom image loaded
 * through it taints the canvas we compose on and `toDataURL` throws SecurityError. Its `Img`
 * node does set it (Img.js), which is why the node path never hit this. render-service replies
 * with `access-control-allow-origin: *`, so an anonymous request is enough; for the bundled
 * presets, which are same-origin, this changes nothing.
 */
function loadImageWithCors(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Could not load the background image: ${source}`));
    image.src = source;
  });
}

/**
 * Composes the positioned background into a frame-sized texture.
 *
 * This exists because of how Motion Canvas feeds a shader: the source texture is the node's
 * *cache*, and a node's cache bounding box grows to contain its children even when the node
 * clips them. Putting an over-sized image inside a frame-sized clipping Rect therefore handed
 * the shader a source space the size of the whole picture rather than the frame — which
 * silently made zoom and pan invisible in the output (the shader always sampled the entire
 * image) and broke the frame-space assumption the turbulence relies on. Measured: the Rect's
 * cacheBBox came back 2068x3072 for a 1080x1920 frame.
 *
 * Flattening the framing here makes the shader node exactly frame-sized, so `sourceUV` and
 * `screenUV` agree and the zoom/pan are already baked in. Runs once per render, not per frame.
 */
function composeFramed(
  image: HTMLImageElement,
  frameWidth: number,
  frameHeight: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
) {
  const naturalWidth = image.naturalWidth || frameWidth;
  const naturalHeight = image.naturalHeight || frameHeight;

  // Cover the frame, then apply the zoom. 1.0 covers exactly; the 1.05 default leaves a
  // little slack so panning has somewhere to go on both axes.
  const cover = Math.max(frameWidth / naturalWidth, frameHeight / naturalHeight);
  const drawScale = cover * Math.max(1, zoom);
  const drawWidth = naturalWidth * drawScale;
  const drawHeight = naturalHeight * drawScale;

  // Pan as a fraction of half the frame, clamped to the overflow that actually exists, so
  // the image edge is never pulled into view.
  const slackX = Math.max(0, (drawWidth - frameWidth) / 2);
  const slackY = Math.max(0, (drawHeight - frameHeight) / 2);
  const panX = clamp((offsetX * frameWidth) / 2, -slackX, slackX);
  const panY = clamp((offsetY * frameHeight) / 2, -slackY, slackY);

  const canvas = document.createElement("canvas");
  canvas.width = frameWidth;
  canvas.height = frameHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not get a 2d context to compose the background");

  context.drawImage(
    image,
    (frameWidth - drawWidth) / 2 + panX,
    (frameHeight - drawHeight) / 2 + panY,
    drawWidth,
    drawHeight,
  );

  return {
    dataUrl: canvas.toDataURL("image/png"),
    panX,
    panY,
    drawWidth,
    drawHeight,
    slackX,
    slackY,
  };
}

/**
 * A still background warped by a churning turbulence field, looping seamlessly.
 *
 * The framing is flattened into a frame-sized texture (see composeFramed), then a fragment
 * shader displaces every pixel per frame — noise computed in frame space, so the turbulence
 * looks the same at any zoom (see ../shaders/turbulence.ts). The loop closes exactly because
 * the shader's `phase` walks one full circle through 4D noise over `durationInSeconds`.
 */
export default makeScene2D(function* (view) {
  const variables = useScene().variables;
  const preset = String(variables.get("backgroundPreset", "brand-1")());
  const customImage = String(variables.get("image", "")());
  const zoom = Number(variables.get("scale", 1.05)());
  const offsetX = Number(variables.get("offsetX", 0)());
  const offsetY = Number(variables.get("offsetY", 0)());
  const displacementAmount = Number(variables.get("displacementAmount", 45)());
  const noiseScale = Number(variables.get("noiseScale", 2.2)());
  const totalDuration = Number(variables.get("durationInSeconds", 6)());

  const source = resolveSource(preset, customImage);

  // Yielding a promise from a scene generator is supported (GeneratorScene handles it), and
  // the natural size is needed up front to frame the image exactly.
  const image = (yield loadImageWithCors(source)) as unknown as HTMLImageElement;

  const frame = view.size();
  const framed = composeFramed(image, frame.x, frame.y, zoom, offsetX, offsetY);

  const phase = createSignal(0);

  view.add(
    <Img
      src={framed.dataUrl}
      width={frame.x}
      height={frame.y}
      shaders={{
        fragment: TURBULENCE_FRAGMENT,
        uniforms: {
          phase,
          loopRadius: LOOP_RADIUS,
          noiseScale,
          displacement: displacementAmount,
        },
      }}
    />,
  );

  yield* tween(totalDuration, (progress) => phase(progress * TAU));
});
