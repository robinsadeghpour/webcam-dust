// Bloom chain and the final grade.

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 o;
`;

/** Halve the image; the first level also keeps only light above a soft knee. */
export const SHRINK_FS = HEAD + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uKnee;
void main() {
  vec4 sum = texture(uSrc, vUv) * 0.25;
  sum += 0.125 * (
    texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)) + texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)) +
    texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)) + texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)));
  sum += 0.0625 * (
    texture(uSrc, vUv + uTexel * vec2(2.0, 0.0)) + texture(uSrc, vUv + uTexel * vec2(-2.0, 0.0)) +
    texture(uSrc, vUv + uTexel * vec2(0.0, 2.0)) + texture(uSrc, vUv + uTexel * vec2(0.0, -2.0)));
  if (uKnee > 0.0) {
    float peak = max(sum.r, max(sum.g, sum.b));
    sum.rgb *= peak / (peak + uKnee);
  }
  o = sum;
}
`;

/** Grow a level back up with a tent filter and add the sharper level to it. */
export const GROW_FS = HEAD + /* glsl */ `
uniform sampler2D uWide;
uniform sampler2D uSharp;
uniform vec2 uTexel;
uniform float uSpread;
void main() {
  vec4 sum = texture(uWide, vUv) * 0.25;
  sum += 0.125 * (
    texture(uWide, vUv + vec2(uTexel.x, 0.0)) + texture(uWide, vUv - vec2(uTexel.x, 0.0)) +
    texture(uWide, vUv + vec2(0.0, uTexel.y)) + texture(uWide, vUv - vec2(0.0, uTexel.y)));
  sum += 0.0625 * (
    texture(uWide, vUv + uTexel) + texture(uWide, vUv - uTexel) +
    texture(uWide, vUv + vec2(uTexel.x, -uTexel.y)) + texture(uWide, vUv + vec2(-uTexel.x, uTexel.y)));
  o = texture(uSharp, vUv) + sum * uSpread;
}
`;

export const GRADE_FS = HEAD + /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uHaze;
uniform vec2 uResolution;
uniform uint uTick;
uniform float uExposure;
uniform float uBloomAmount;
uniform float uHazeAmount;
uniform vec3 uCore;
uniform vec3 uRoomCentre;
uniform vec3 uRoomEdge;
uniform vec3 uHazeTint;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Soft-shouldered curve: near linear in the shadows, rolling off towards one.
float shoulder(float x) {
  return 1.0 - exp(-x * (1.0 + 0.3 * x) / (1.0 + 0.12 * x));
}

uint stir(uint x) {
  x ^= x >> 15;
  x *= 2246822519u;
  x ^= x >> 13;
  x *= 3266489917u;
  x ^= x >> 16;
  return x;
}

// One fresh random number per pixel per frame, for dither and film grain.
float speckle(vec2 at, uint tick) {
  uint n = stir(uint(at.x) + stir(uint(at.y) + stir(tick)));
  return float(n) * (1.0 / 4294967296.0);
}

void main() {
  vec2 uv = vUv;
  vec4 scene = texture(uScene, uv);
  vec3 bloom = texture(uBloom, uv).rgb;
  vec4 haze = texture(uHaze, uv);

  // Where dust is piled deep, lean the light towards the palette's core tint
  // so density reads as richer colour instead of as white.
  float pile = smoothstep(0.5, 3.5, haze.a);
  vec3 light = scene.rgb + bloom * uBloomAmount;
  float level = luma(light);
  vec3 tinted = uCore * level * 1.25;
  light = mix(light, tinted, pile * 0.5);
  light *= uExposure;

  // Compress brightness while holding on to hue, then let only the very
  // brightest points drift towards white.
  float lum = max(luma(light), 1e-5);
  float mapped = shoulder(lum);
  vec3 held = light * (mapped / lum);
  vec3 split = vec3(shoulder(light.r), shoulder(light.g), shoulder(light.b));
  vec3 color = mix(held, split, 0.38);
  color = min(color, vec3(1.0));

  // The room: a faint warm pool behind the figure, darker at the corners.
  vec2 centred = (vec2(uv.x, 1.0 - uv.y) - vec2(0.5, 0.46)) * vec2(uResolution.x / uResolution.y, 1.0);
  float radius = length(centred);
  vec3 room = mix(uRoomCentre, uRoomEdge, smoothstep(0.0, 0.62, radius));
  room += uHazeTint * shoulder(luma(haze.rgb) * 1.6) * uHazeAmount;

  color = room + color * (1.0 - room);
  color *= mix(1.0, 0.62, smoothstep(0.32, 0.86, radius));

  color = pow(max(color, 0.0), vec3(1.0 / 2.2));
  float speck = speckle(gl_FragCoord.xy, uTick);
  color += (speck - 0.5) * (2.2 / 255.0);
  o = vec4(color, 1.0);
}
`;
