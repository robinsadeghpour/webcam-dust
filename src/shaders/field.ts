// Mask -> signed distance field -> surface normal and body velocity.
// Every texture here treats v = 0 as the top of the stage.

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
`;

/** Soften the incoming mask and ease it towards the newest frame. */
export const MASK_INGEST_FS = HEAD + /* glsl */ `
uniform sampler2D uRaw;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uRise;
uniform float uFall;
out vec4 o;
void main() {
  float sum = texture(uRaw, vUv).r * 0.25;
  sum += 0.125 * (
    texture(uRaw, vUv + vec2(uTexel.x, 0.0)).r + texture(uRaw, vUv - vec2(uTexel.x, 0.0)).r +
    texture(uRaw, vUv + vec2(0.0, uTexel.y)).r + texture(uRaw, vUv - vec2(0.0, uTexel.y)).r);
  sum += 0.0625 * (
    texture(uRaw, vUv + uTexel).r + texture(uRaw, vUv - uTexel).r +
    texture(uRaw, vUv + vec2(uTexel.x, -uTexel.y)).r + texture(uRaw, vUv + vec2(-uTexel.x, uTexel.y)).r);
  // Follow new coverage almost at once, let go of old coverage more slowly:
  // a fast limb then never drops out of the mask, and flicker is damped.
  float prev = texture(uPrev, vUv).r;
  o = vec4(mix(prev, sum, sum > prev ? uRise : uFall), 0.0, 0.0, 1.0);
}
`;

/**
 * Seeds for the flood: wherever the mask crosses one half between a pixel and
 * a neighbour, store the sub-pixel position of that crossing.
 */
export const SEED_FS = HEAD + /* glsl */ `
uniform sampler2D uMask;
out vec4 o;
void main() {
  ivec2 size = textureSize(uMask, 0);
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec2 centre = gl_FragCoord.xy;
  float here = texelFetch(uMask, cell, 0).r - 0.5;
  float best = 2.0;
  vec2 hit = vec2(0.0);
  const ivec2 STEP[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  for (int k = 0; k < 4; k++) {
    ivec2 other = clamp(cell + STEP[k], ivec2(0), size - 1);
    float there = texelFetch(uMask, other, 0).r - 0.5;
    if (here * there < 0.0) {
      float along = here / (here - there);
      if (along < best) {
        best = along;
        hit = centre + vec2(STEP[k]) * along;
      }
    }
  }
  o = best < 1.5 ? vec4(hit, 1.0, 0.0) : vec4(0.0, 0.0, -1.0, 0.0);
}
`;

/** One jump-flood step: adopt the nearest seed found among nine probes. */
export const FLOOD_FS = HEAD + /* glsl */ `
uniform sampler2D uSeeds;
uniform int uJump;
out vec4 o;
void main() {
  ivec2 size = textureSize(uSeeds, 0);
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec2 centre = gl_FragCoord.xy;
  float bestDist = 1e12;
  vec3 best = vec3(0.0, 0.0, -1.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 probe = cell + ivec2(i, j) * uJump;
      if (probe.x < 0 || probe.y < 0 || probe.x >= size.x || probe.y >= size.y) continue;
      vec4 s = texelFetch(uSeeds, probe, 0);
      if (s.z < 0.0) continue;
      vec2 delta = s.xy - centre;
      float dist = dot(delta, delta);
      if (dist < bestDist) {
        bestDist = dist;
        best = vec3(s.xy, 1.0);
      }
    }
  }
  o = vec4(best, 0.0);
}
`;

/** Signed distance in simulation units, positive inside the body. */
export const DISTANCE_FS = HEAD + /* glsl */ `
uniform sampler2D uSeeds;
uniform sampler2D uMask;
uniform float uUnit;
out vec4 o;
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSeeds, cell, 0);
  float inside = texelFetch(uMask, cell, 0).r > 0.5 ? 1.0 : -1.0;
  float dist = s.z < 0.0 ? 1.0 : length(s.xy - gl_FragCoord.xy) * uUnit;
  o = vec4(dist * inside, 0.0, 0.0, 1.0);
}
`;

/** Nine-tap separable blur; uStep is one tap of travel in uv. */
export const BLUR_FS = HEAD + /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uStep;
out vec4 o;
void main() {
  vec4 sum = texture(uSrc, vUv) * 0.2042;
  sum += (texture(uSrc, vUv + uStep) + texture(uSrc, vUv - uStep)) * 0.1802;
  sum += (texture(uSrc, vUv + uStep * 2.0) + texture(uSrc, vUv - uStep * 2.0)) * 0.1238;
  sum += (texture(uSrc, vUv + uStep * 3.0) + texture(uSrc, vUv - uStep * 3.0)) * 0.0663;
  sum += (texture(uSrc, vUv + uStep * 4.0) + texture(uSrc, vUv - uStep * 4.0)) * 0.0276;
  o = sum;
}
`;

/**
 * Packs what the particles read: distance, inward normal, and the distance
 * one frame ago. The difference of the two distances is how far the surface
 * moved along its normal, which is what lets settled grains ride with it.
 */
export const SURFACE_FS = HEAD + /* glsl */ `
uniform sampler2D uSdf;
uniform sampler2D uSdfBefore;
uniform float uUnit;
out vec4 o;
void main() {
  vec2 size = vec2(textureSize(uSdf, 0));
  vec2 texel = 1.0 / size;
  float d = texture(uSdf, vUv).r;
  float dx = texture(uSdf, vUv + vec2(texel.x, 0.0)).r - texture(uSdf, vUv - vec2(texel.x, 0.0)).r;
  float dy = texture(uSdf, vUv + vec2(0.0, texel.y)).r - texture(uSdf, vUv - vec2(0.0, texel.y)).r;
  vec2 grad = vec2(dx, dy) * 0.5 / uUnit;
  vec2 normal = grad / max(length(grad), 0.35);
  o = vec4(d, normal, texture(uSdfBefore, vUv).r);
}
`;

/**
 * Local mass and first moments of the mask at a quarter of the resolution.
 * After a wide blur, moments / mass is the centre of the body within a window.
 */
export const MOMENTS_FS = HEAD + /* glsl */ `
uniform sampler2D uMask;
uniform vec2 uTexel;
uniform vec2 uExtent;
out vec4 o;
void main() {
  float mass = 0.25 * (
    texture(uMask, vUv + uTexel * vec2(1.0, 1.0)).r + texture(uMask, vUv + uTexel * vec2(-1.0, 1.0)).r +
    texture(uMask, vUv + uTexel * vec2(1.0, -1.0)).r + texture(uMask, vUv + uTexel * vec2(-1.0, -1.0)).r);
  vec2 at = vUv * uExtent;
  o = vec4(mass, mass * at, 1.0);
}
`;

/**
 * How the body is moving. The local centre of mass is tracked from one frame
 * to the next; unlike edge-based flow this still works when a limb travels
 * further than its own width between frames, and mask flicker averages out.
 */
export const TRACK_FS = HEAD + /* glsl */ `
uniform sampler2D uNow;
uniform sampler2D uBefore;
uniform sampler2D uPrev;
uniform float uInvDt;
uniform float uLimit;
uniform float uBlend;
out vec4 o;
void main() {
  vec4 now = texture(uNow, vUv);
  vec4 before = texture(uBefore, vUv);
  vec2 velocity = (now.yz / max(now.x, 1e-4) - before.yz / max(before.x, 1e-4)) * uInvDt;
  velocity *= smoothstep(0.004, 0.03, min(now.x, before.x));
  float speed = length(velocity);
  velocity *= min(1.0, uLimit / max(speed, 1e-5));
  velocity = mix(texture(uPrev, vUv).xy, velocity, uBlend);
  o = vec4(velocity, length(velocity), 1.0);
}
`;

/**
 * How far the surface moved this frame under each point. Along the normal
 * that is exactly the change in distance, so a grain moved by it keeps its
 * depth below the surface. Stored weighted, ready for a wide blur: the blur
 * lets the two sides of the torso agree on one movement instead of each
 * following its own edge and sliding against the other down the middle.
 */
export const RIDE_FS = HEAD + /* glsl */ `
uniform sampler2D uSurface;
uniform float uRideMax;
out vec4 o;
void main() {
  vec4 s = texture(uSurface, vUv);
  float change = s.x - s.w;
  vec2 ride = abs(change) > uRideMax * 4.0 ? vec2(0.0) : -clamp(change, -uRideMax, uRideMax) * s.yz;
  float weight = 0.04 + smoothstep(-0.03, 0.004, s.x);
  o = vec4(ride * weight, weight, 1.0);
}
`;

/**
 * How far the body's surface has carried each point from where it started,
 * fading back to nothing over a second or two. The contour lines are laid
 * out in these carried coordinates, so they travel with a moving body
 * instead of staying fixed in space.
 */
export const DRIFT_FS = HEAD + /* glsl */ `
uniform sampler2D uRide;
uniform sampler2D uPrev;
uniform vec2 uExtent;
uniform float uKeep;
out vec4 o;
void main() {
  vec4 r = texture(uRide, vUv);
  vec2 ride = r.xy / max(r.z, 1e-4);
  // Ignore shimmer at the edge of a noisy mask; only real movement carries.
  float size = length(ride);
  ride *= smoothstep(0.0004, 0.0012, size);
  vec2 carried = texture(uPrev, vUv - ride / uExtent).xy - ride;
  o = vec4(carried * uKeep, 0.0, 1.0);
}
`;
