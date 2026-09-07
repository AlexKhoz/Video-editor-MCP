/**
 * Turbulent displacement shader.
 *
 * Motion Canvas runs a node's `shaders` as a post-process over that node's rasterised
 * output: `sourceTexture` holds the pixels as already drawn, `sourceUV` is 0..1 across it
 * and `screenUV` is the same point in frame space (see core/lib/scenes/Shaders.js — the
 * vertex stage computes `position_source = position * 0.5 + 0.5`).
 *
 * Two consequences shape this shader:
 *
 * 1. The image's zoom and pan are already baked into `sourceTexture`, so the noise field is
 *    computed in **frame space** (`screenUV`), not image space. That is what keeps the
 *    turbulence identical at any zoom: feature size and push distance are both measured in
 *    frame pixels, so zooming the background does not magnify the churn, and panning does
 *    not drag the field along with it. Sampling in `sourceUV` would do exactly the opposite.
 *
 * 2. Displacement can reach outside the drawn image and pick up transparent pixels, so the
 *    sample coordinate is clamped to the texture. The scene also over-scales the image by a
 *    small bleed margin, so in practice the clamp is a backstop rather than the mechanism.
 *
 * The uniforms and varyings below mirror `@motion-canvas/core/shaders/common.glsl`. They are
 * declared by hand rather than `#include`d so the source is self-contained and does not
 * depend on include resolution inside the plugin chain.
 */
export const TURBULENCE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 screenUV;
in vec2 sourceUV;
in vec2 destinationUV;

out vec4 outColor;

uniform sampler2D sourceTexture;
uniform vec2 resolution;

uniform float phase;        // 0 .. 2*PI, one full turn per loop
uniform float loopRadius;   // radius of the circle walked through noise space
uniform float noiseScale;   // turbulence features across the frame height
uniform float displacement; // maximum push, in frame pixels

/*
 * Four-dimensional gradient noise.
 *
 * Four dimensions, because a seamless loop needs the time axis to be a *circle*: feeding
 * (x, y, r*cos(theta), r*sin(theta)) returns to precisely the same value at theta = 2*PI,
 * which no amount of scrolling through a 2D or 3D field can do. Perlin-style gradients
 * rather than value noise, because value noise reads as soft blobs where this needs the
 * directional, fluid character of simplex; written out here rather than vendoring a
 * third-party simplex implementation so there is no external licence to carry.
 */
vec4 hash4(vec4 p) {
  p = fract(p * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.xxyz + p.yzzw) * p.zywx) * 2.0 - 1.0;
}

float gradientNoise4(vec4 x) {
  vec4 cell = floor(x);
  vec4 f = x - cell;
  // Quintic fade: zero first and second derivatives at the lattice, so no visible seams.
  vec4 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float total = 0.0;
  for (int corner = 0; corner < 16; corner++) {
    vec4 o = vec4(
      float(corner & 1),
      float((corner >> 1) & 1),
      float((corner >> 2) & 1),
      float((corner >> 3) & 1)
    );
    vec4 gradient = normalize(hash4(cell + o) + 1e-5);
    vec4 weights = mix(1.0 - u, u, o);
    total += dot(gradient, f - o) * weights.x * weights.y * weights.z * weights.w;
  }
  return total;
}

/* Three octaves of it. Scaling the point scales the loop circle too, which is still a
 * closed circle, so the exact periodicity survives. */
float fbm4(vec4 p) {
  float amplitude = 0.5;
  float sum = 0.0;
  for (int octave = 0; octave < 3; octave++) {
    sum += amplitude * gradientNoise4(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return sum;
}

void main() {
  // Aspect-corrected so features stay round on a 9:16 frame instead of being stretched.
  vec2 field = screenUV * vec2(resolution.x / resolution.y, 1.0) * noiseScale;
  vec4 onCircle = vec4(field, loopRadius * cos(phase), loopRadius * sin(phase));

  // A second, decorrelated field for the other axis; sampling one field twice would push
  // every pixel along the diagonal.
  float pushX = fbm4(onCircle);
  float pushY = fbm4(onCircle + vec4(19.7, 7.3, 3.1, 11.9));

  vec2 offsetPixels = vec2(pushX, pushY) * displacement;
  vec2 uv = clamp(sourceUV + offsetPixels / resolution, vec2(0.0), vec2(1.0));

  outColor = texture(sourceTexture, uv);
}
`;
