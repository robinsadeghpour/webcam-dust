// Particle simulation and drawing.
//
// State lives in two float textures, one texel per grain:
//   uPos: xy position (x in 0..aspect, y in 0..1, y down), zw velocity
//   uAux: xy homing target, z heat, w life
//
// heat <= 0  the grain is part of the figure (-1..0 is a newborn fading in)
// heat  > 0  the grain is loose in the air and cooling
// life <= 0  the grain is waiting to be reborn inside the silhouette

const COMMON = /* glsl */ `
precision highp float;
precision highp int;

const float MOTE_SHARE = 0.004;

uint scramble(uint x) {
  x ^= x >> 16;
  x *= 2654435761u;
  x ^= x >> 13;
  x *= 3266489917u;
  x ^= x >> 15;
  return x;
}

// Four unrelated numbers in 0..1 for a grain, optionally different each frame.
vec4 dice(ivec2 cell, uint salt) {
  uint a = scramble(uint(cell.x) + scramble(uint(cell.y) + scramble(salt * 747796405u + 12345u)));
  uint b = scramble(a + 0x51ed270bu);
  uint c = scramble(b + 0x51ed270bu);
  uint d = scramble(c + 0x51ed270bu);
  return vec4(a, b, c, d) * (1.0 / 4294967296.0);
}

uniform float uDome;
uniform float uSoftEdge;
uniform float uReserve;
uniform float uRim;
uniform float uRimFill;

// Whether a grain is one of those that trace the outline. Only as many are
// called up as the outline's length needs.
bool rimGrain(vec4 trait) {
  return trait.w >= uReserve && trait.w < uReserve + uRim && trait.y < uRimFill;
}

// Height of the body treated as a rounded relief, and its slope.
vec2 relief(float d) {
  float q = clamp(d / uDome, 0.0, 1.0);
  float root = sqrt(max(q * (2.0 - q), 1e-4));
  return vec2(uDome * root, (1.0 - q) / max(root, uSoftEdge));
}
`;

export const SIM_FS = /* glsl */ `#version 300 es
${COMMON}
uniform sampler2D uPos;
uniform sampler2D uAux;
uniform sampler2D uSurface;
uniform sampler2D uMotion;
uniform sampler2D uFlow;
uniform float uDt;
uniform float uTime;
uniform vec2 uExtent;
uniform uint uFrame;
uniform float uBurst;

uniform float uSpacing;
uniform float uWrap;
uniform float uSlice;
uniform float uTilt;
uniform float uWarp;
uniform float uStream;
uniform sampler2D uCarried;
uniform sampler2D uRide;
uniform sampler2D uCrowd;
uniform vec2 uCrowdTexel;
uniform float uCrowdCell;
uniform float uTearLow;
uniform float uTearHigh;
uniform float uTearRate;
uniform float uShed;
uniform float uLinger;
uniform float uCore;
uniform float uThrow;
uniform float uTurbulence;
uniform float uGravity;
uniform float uHomeSpeed;
uniform float uOnLine;
uniform float uActive;
uniform vec2 uSliceDir;

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oAux;

vec2 toUv(vec2 p) { return p / uExtent; }

// How far the body's surface moved this frame under a point. Moving a
// settled grain by this keeps it in place on the body, so the figure
// follows the live silhouette frame by frame.
vec2 rideAt(vec2 p) {
  vec4 r = texture(uRide, toUv(p));
  return r.xy / max(r.z, 1e-4);
}

// Divergence-free drift made of two layers sliding past each other.
vec2 swirl(vec2 p, float t) {
  vec2 a = texture(uFlow, p * 0.85 + vec2(0.011, -0.019) * t).xy;
  vec2 b = texture(uFlow, vec2(p.y, -p.x) * 2.3 + vec2(-0.027, 0.015) * t + 0.37).xy;
  return a + 0.55 * vec2(-b.y, b.x);
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, cell, 0);
  vec4 A = texelFetch(uAux, cell, 0);
  vec2 p = P.xy;
  vec2 v = P.zw;
  vec2 target = A.xy;
  float heat = A.z;
  float life = A.w;

  vec4 own = dice(cell, 0u);
  vec4 trait = dice(cell, 17u);
  vec4 roll = dice(cell, uFrame);
  vec4 roll2 = dice(cell, uFrame + 7919u);
  float dt = uDt;

  // ---- ambient motes: a few grains that simply drift through the room ----
  if (own.w < MOTE_SHARE) {
    if (life <= 0.0) {
      p = roll.xy * uExtent;
      v = vec2(0.0);
      heat = -1.0;
      life = mix(7.0, 16.0, roll.z);
    } else {
      v = swirl(p * 0.7, uTime * 0.6) * 0.012 + vec2(0.004, -0.006) * (0.5 + own.x);
      p += v * dt;
      heat = min(heat + dt / 1.6, 0.0);
      life -= dt;
      if (p.x < -0.03 || p.x > uExtent.x + 0.03 || p.y < -0.03 || p.y > uExtent.y + 0.03) life = 0.0;
    }
    oPos = vec4(p, v);
    oAux = vec4(target, heat, life);
    return;
  }

  // ---- waiting: try one random spot per frame ----
  if (life <= 0.0) {
    // Take the first of three random spots that lies on the body, so a limb
    // that has just moved is refilled within a few frames.
    vec2 spot = roll.xy * uExtent;
    vec4 under = texture(uSurface, toUv(spot));
    if (under.x < -0.02) {
      spot = roll2.xy * uExtent;
      under = texture(uSurface, toUv(spot));
    }
    if (under.x < -0.02) {
      spot = fract(roll.yx + roll2.zw) * uExtent;
      under = texture(uSurface, toUv(spot));
    }
    float depth = under.x;
    if (trait.w < uReserve) {
      // Held in reserve: only ever born as loose dust, shed by whatever part
      // of the body is moving fast, so a sweeping arm trails a full plume.
      vec3 moving = texture(uMotion, toUv(spot)).xyz;
      float shed = smoothstep(uTearLow, uTearHigh, moving.z);
      if (depth > -0.003 && (roll.z < shed * uShed || (uBurst > 0.0 && roll.z < 0.3))) {
        float tongue = texture(uFlow, spot * 2.7 + vec2(uTime * 0.05, 0.0)).w;
        float strand = texture(uFlow, spot * 7.1 - vec2(0.0, uTime * 0.07)).z;
        float carry = clamp(0.5 + 0.55 * tongue + 0.3 * strand + 0.22 * (roll.w - 0.5), 0.04, 1.35);
        float angle = roll2.y * 6.2831853;
        p = spot;
        v = moving.xy * carry * uThrow + vec2(cos(angle), sin(angle)) * (0.03 + 0.45 * uBurst * roll2.x * roll2.x);
        heat = mix(0.6, 1.0, roll2.w);
        target = vec2(-1.0);
        life = mix(0.5, 1.9, roll2.z * roll2.z) * uLinger;
      }
    } else if (rimGrain(trait)) {
      // Rim grains trace the outline. Any spot near the edge will do: it is
      // slid along the normal into the band just inside the silhouette.
      float want = 0.0035 + 0.006 * trait.x;
      vec2 onRim = spot + under.yz * (want - depth);
      if (depth > -0.02 && depth < 0.07) {
        p = onRim;
        v = vec2(0.0);
        target = vec2(0.9, 0.6);
        heat = -1.0;
        life = mix(4.0, 11.0, own.x) * mix(0.35, 1.0, roll.w);
      }
    } else {
      // Born into the figure if the spot is on the body. Only as many grains
      // are called up as the body's size needs, so a small figure is not
      // packed more densely than a large one.
      // Thin places are filled first: the fuller a spot already is, the less
      // likely a grain is to be born there.
      float crowd = texture(uCrowd, toUv(spot)).r;
      float keep = mix(1.0, 0.72, smoothstep(0.0, 0.05, depth)) * clamp(1.3 - crowd, 0.04, 1.0);
      if (depth > 0.0015 && roll.z < keep && trait.z < uActive) {
        p = spot;
        v = vec2(0.0);
        target = spot;
        heat = -1.0;
        life = mix(4.0, 11.0, own.x) * mix(0.35, 1.0, roll.w);
      }
    }
    oPos = vec4(p, v);
    oAux = vec4(target, heat, life);
    return;
  }

  vec4 surface = texture(uSurface, toUv(p));
  vec4 motion = texture(uMotion, toUv(p));
  float d = surface.x;
  vec2 n = surface.yz;
  vec2 ride = rideAt(p);
  // Depth the grain will have once it has ridden with the surface. Checks on
  // a settled grain use this, not the depth at the spot it is leaving.
  float held = d + dot(n, ride);
  vec2 bodyVel = motion.xy;
  float speed = motion.z;
  float pull = smoothstep(uTearLow, uTearHigh, speed);

  if (heat <= 0.0) {
    // ---- settled: part of the figure ----
    // A core of grains is locked to the body and never torn off by speed, so
    // a fast limb stays drawn while the rest of it streams away.
    bool core = fract(own.x * 7.0 + trait.x * 13.0) < uCore;
    bool torn = !core && roll.z < 1.0 - exp(-pull * uTearRate * dt);
    if (uBurst > 0.0) torn = roll.z < 0.62;
    if (torn) {
      heat = mix(0.6, 1.0, roll.w);
      // Whole patches are flung harder or softer together, which is what
      // pulls the cloud into tongues and wisps instead of an even spray.
      float tongue = texture(uFlow, p * 2.7 + vec2(uTime * 0.05, 0.0)).w;
      float carry = clamp(0.8 + 0.34 * tongue + 0.3 * (roll.x - 0.5), 0.2, 1.3);
      vec2 side = vec2(-bodyVel.y, bodyVel.x);
      v = bodyVel * carry * uThrow + side * (roll.y - 0.5) * 0.16 - n * speed * 0.05 * roll2.x;
      if (uBurst > 0.0) {
        float angle = roll2.y * 6.2831853;
        vec2 away = length(n) > 0.05 ? -normalize(n) : vec2(cos(angle), sin(angle));
        float reach = 0.06 + 0.85 * roll.x * roll.x * roll.x + 0.3 * max(tongue, 0.0);
        v += (away * reach + vec2(cos(angle), sin(angle)) * 0.12) * uBurst;
      }
      target = vec2(-1.0);
      // Some grains never come home: they fall away as embers and are reborn.
      if (own.y < 0.3) life = min(life, mix(0.9, 2.6, roll2.z) * uLinger);
    } else if (rimGrain(trait)) {
      // Rim: circle the body just inside its outline, so the silhouette
      // always reads however much of the rest is in the air.
      vec2 flow = vec2(-n.y, n.x) * uStream * 2.2 * (0.5 + own.z);
      float want = 0.0035 + 0.006 * trait.x;
      p += ride + flow * dt + n * (want - held) * (1.0 - exp(-dt * 9.0));
      v = bodyVel + flow;
      heat = min(heat + dt / mix(0.25, 0.04, smoothstep(0.08, 0.45, speed)), 0.0);
      life -= dt;
      if (held < -0.03) life = min(life, 0.12);
      target = vec2(0.9, 0.6);
    } else {
      // Lay the contour lines out in coordinates the body carries with it,
      // so they move with a limb instead of the limb sliding through them.
      vec2 m = p + texture(uCarried, toUv(p)).xy;
      vec2 rel = relief(d);
      // Slow noise bends the lines so they run like ripples in sand.
      vec2 q = m * 0.75 + vec2(0.0, uTime * 0.006);
      const float EPS = 0.004;
      float bend = dot(texture(uFlow, q).zw, vec2(1.0, 0.5));
      float bendX = dot(texture(uFlow, q + vec2(EPS, 0.0)).zw, vec2(1.0, 0.5));
      float bendY = dot(texture(uFlow, q + vec2(0.0, EPS)).zw, vec2(1.0, 0.5));
      vec2 bendGrad = vec2(bendX - bend, bendY - bend) * (0.75 / EPS);
      float level = (uWrap * d + uSlice * (dot(m, uSliceDir) - uTilt * rel.x) + uWarp * bend) / uSpacing;
      vec2 grad = (uWrap * n + uSlice * (uSliceDir - uTilt * rel.y * n) + uWarp * bendGrad) / uSpacing;
      float gentlest = 0.3 / uSpacing;
      float steep = max(dot(grad, grad), gentlest * gentlest);
      vec2 along = vec2(-grad.y, grad.x) * inversesqrt(steep);

      // Glide along the contour line, with a little wander on top.
      vec2 wander = swirl(p * 1.6, uTime) * 0.004;
      vec2 flow = along * uStream * (0.35 + 1.3 * own.z) + wander;
      // Ease off when heading for the outline so grains gather there gently.
      if (dot(flow, n) < 0.0) flow *= smoothstep(0.002, 0.014, held);

      // Most grains sit on a line; the rest hang between lines as fine haze.
      float offset = level - floor(level + 0.5);
      float lane = (trait.x - 0.5) * (trait.y < uOnLine ? 0.26 : 1.0);
      vec2 snap = -(offset - lane) * grad / steep;
      snap *= min(1.0, uSpacing / max(length(snap), 1e-6));
      float settle = (1.0 - exp(-dt * 5.0)) * (1.0 - 0.85 * pull);

      // Spread out: drift from crowded places towards thin ones. This is
      // what refills a limb evenly after it has been squeezed or has moved.
      vec2 uv = toUv(p);
      float cl = texture(uCrowd, uv - vec2(uCrowdTexel.x, 0.0)).r;
      float cr = texture(uCrowd, uv + vec2(uCrowdTexel.x, 0.0)).r;
      float cu = texture(uCrowd, uv - vec2(0.0, uCrowdTexel.y)).r;
      float cd = texture(uCrowd, uv + vec2(0.0, uCrowdTexel.y)).r;
      float crowd = 0.25 * (cl + cr + cu + cd);
      vec2 spread = -vec2(cr - cl, cd - cu) / (2.0 * uCrowdCell) * 0.00035;
      spread *= min(1.0, 0.09 / max(length(spread), 1e-6));

      p += ride + (flow + spread) * dt + snap * settle;
      if (held < 0.004) p += n * (0.004 - held) * (1.0 - exp(-dt * 6.0));
      v = bodyVel + flow;
      // New grains fade in; on a moving limb they must appear at once or the
      // limb has gone before they show.
      heat = min(heat + dt / mix(0.3, 0.04, smoothstep(0.08, 0.45, speed)), 0.0);
      // Grains in crowded places age faster, which frees them to be reborn
      // where the body has just arrived and is still thin.
      life -= dt * (1.0 + 9.0 * max(crowd - 1.04, 0.0));
      if (trait.z > uActive + 0.04) life = min(life, 0.4);
      // A grain that drifts up to the outline slips round the back and is
      // reborn elsewhere, instead of piling up into a bright edge.
      if (held < 0.0055 && dot(flow, n) < 0.0) life = min(life, 0.4);
      // Likewise where the lines close up into a point, such as the crown.
      if (dot(grad, grad) < gentlest * gentlest) life = min(life, 0.4);
      // Left outside by a jump the surface could not carry it through:
      // vanish at once and be reborn on the body, rather than trail behind.
      if (held < -0.012) life = min(life, 0.1);

      // While settled the target slot is free, so it carries two numbers for
      // the draw pass: the weight of this grain's line, and a drifting patch
      // value that thins the lines out in places.
      float line = floor(level + 0.5);
      float weight = float(scramble(uint(int(line) + 8192)) >> 8) * (1.0 / 16777216.0);
      float thin = texture(uFlow, m * vec2(4.6, 8.2) + vec2(uTime * 0.03, 0.0)).z;
      target = vec2(weight, thin);
    }
  } else {
    // ---- loose: thrown, carried by the air, then drawn home ----
    float cooling = mix(0.4, 1.15, own.y) * uLinger;
    heat = max(heat - dt / cooling, 0.05);
    heat = max(heat, pull * 0.6);

    // The air: slow eddies, a gentle fall, and the wake of whatever limb is near.
    vec2 air = swirl(p * 1.25, uTime * 1.4) * uTurbulence;
    air.y += uGravity * (0.25 + own.z);
    float wake = exp(-max(-d, 0.0) / 0.045) * smoothstep(0.05, 0.4, speed);
    air = mix(air, bodyVel, 0.75 * wake);
    vec2 lag = air - v;
    vec2 force = lag * (1.1 + 1.5 * length(lag));

    bool ember = own.y < 0.3 || trait.w < uReserve;
    float homing = ember && trait.w < uReserve ? 0.0 : 1.0 - smoothstep(0.12, 0.5, heat);
    if (homing > 0.0) {
      if (target.x < 0.0) {
        vec2 near = p + (roll.xy - 0.5) * 0.45;
        vec2 anywhere = roll.xy * uExtent;
        vec2 spot = roll.w < 0.7 ? near : anywhere;
        float depth = texture(uSurface, toUv(spot)).x;
        if (depth > 0.004 && spot.x > 0.0 && spot.x < uExtent.x && spot.y > 0.0 && spot.y < uExtent.y) target = spot;
      } else {
        // The target rides with the body and is nudged back in if it slips out.
        vec4 there = texture(uSurface, toUv(target));
        target += rideAt(target);
        if (there.x < 0.004) target += there.yz * (0.005 - there.x);
        if (there.x < -0.05) target = vec2(-1.0);
      }
      if (target.x >= 0.0) {
        vec2 to = target - p;
        float dist = length(to);
        vec2 dir = to / max(dist, 1e-5);
        float top = uHomeSpeed * (0.5 + 1.0 * own.z) * (1.7 - 0.7 * uLinger);
        vec2 want = dir * min(top, dist * 5.0);
        // Approach on a curve rather than a straight line.
        want += vec2(-dir.y, dir.x) * (trait.x - 0.5) * 1.1 * min(top, dist * 3.0);
        force += (want - v) * 6.5 * homing;
        if (dist < 0.007 && homing > 0.85) heat = 0.0;
      }
    }

    v += force * dt;
    p += v * dt;
    life -= dt * (ember ? 1.0 : 0.3);
    if (p.x < -0.12 || p.x > uExtent.x + 0.12 || p.y < -0.12 || p.y > uExtent.y + 0.15) life = 0.0;
  }

  oPos = vec4(p, v);
  oAux = vec4(target, heat, life);
}
`;

export const DRAW_VS = /* glsl */ `#version 300 es
${COMMON}
uniform sampler2D uPos;
uniform sampler2D uAux;
uniform sampler2D uSurface;
uniform int uSide;
uniform vec2 uExtent;
uniform float uTime;
uniform vec2 uResolution;
uniform float uGain;
uniform float uEdgeGain;
uniform float uShutter;
uniform vec3 uDeep;
uniform vec3 uBody;
uniform vec3 uPale;
uniform vec3 uEmber;

out vec2 vLocal;
out vec2 vShape;
out vec4 vColor;

void main() {
  ivec2 cell = ivec2(gl_InstanceID % uSide, gl_InstanceID / uSide);
  vec4 P = texelFetch(uPos, cell, 0);
  vec4 A = texelFetch(uAux, cell, 0);
  vec2 p = P.xy;
  vec2 vel = P.zw;
  float heat = A.z;
  float life = A.w;

  vec4 own = dice(cell, 0u);
  vec4 trait = dice(cell, 17u);
  vec4 look = dice(cell, 91u);
  bool mote = own.w < MOTE_SHARE;

  float fade = smoothstep(0.0, mote ? 2.0 : 0.4, life);
  if (heat <= 0.0) fade *= clamp(1.0 + heat, 0.0, 1.0);
  if (fade < 0.004) {
    gl_Position = vec4(3.0, 3.0, 0.0, 1.0);
    return;
  }

  // One simulation unit is 1920 design pixels at full zoom.
  float pixelsPerUnit = uResolution.y / uExtent.y;
  float scale = pixelsPerUnit / 1920.0;
  float loose = clamp(heat, 0.0, 1.0);
  float settled = 1.0 - smoothstep(0.0, 0.35, loose);

  // Light the grain as if the body were a rounded relief lit from upper left.
  vec4 surface = texture(uSurface, p / uExtent);
  vec2 rel = relief(surface.x);
  vec3 normal = normalize(vec3(-surface.yz * rel.y, 1.0));
  float lambert = max(dot(normal, normalize(vec3(-0.5, -0.6, 0.62))), 0.0);
  float rim = 1.0 - normal.z;
  float lit = mix(0.6, 0.14 + 0.92 * lambert * lambert + 0.2 * rim, settled);
  // Rim grains carry the outline, so they are never left in shadow.
  bool edge = rimGrain(trait);
  if (edge) lit = max(lit, mix(0.6, 0.72, settled));

  // Mostly fine grains, a long tail of larger ones, a few sparkles.
  float size = 1.05 + 1.9 * pow(look.x, 4.0);
  float glow = 0.22 + 1.9 * pow(look.z, 2.6);
  bool sparkle = look.w < 0.012;
  float tone = clamp(lit * 0.72 + (look.y - 0.5) * 0.32, 0.0, 1.0);
  vec3 color = tone < 0.5 ? mix(uDeep, uBody, tone * 2.0) : mix(uBody, uPale, tone * 2.0 - 1.0);
  float energy = glow * (0.28 + 1.3 * lit);
  energy *= 0.8 + 0.2 * sin(uTime * (0.9 + 1.7 * look.x) + look.z * 43.0);

  if (sparkle) {
    float beat = 0.5 + 0.5 * sin(uTime * (1.4 + 2.8 * look.y) + look.x * 61.0);
    float twinkle = pow(beat, 6.0);
    size = 1.7 + 1.5 * look.y;
    color = mix(color, uPale, 0.6);
    energy = (0.5 + 4.2 * twinkle) * (0.5 + 0.9 * lit);
  }

  // Lines differ in weight and break up in drifting patches.
  if (heat <= 0.0 && !sparkle) {
    energy *= mix(0.5, 1.45, A.x * A.x) * (0.6 + 0.75 * smoothstep(-0.5, 0.4, A.y));
  }

  // The outline keeps one brightness however thinly the rest is spread.
  if (edge && heat <= 0.0) energy *= uEdgeGain;

  // Loose grains catch more light; embers redden as they burn out.
  color = mix(color, uPale, 0.3 * loose * loose);
  energy *= 1.0 + 0.4 * loose + 1.4 * loose * loose;
  if (heat > 0.0) size = min(size, 1.9) * mix(1.0, 0.85, loose);
  if (heat > 0.0 && (own.y < 0.3 || trait.w < uReserve)) {
    float dying = 1.0 - smoothstep(0.0, 1.5, life);
    color = mix(color, uEmber, dying * 0.8);
  }

  if (mote) {
    // Out-of-focus dust hanging in the room, well behind the figure.
    size = 2.0 + 7.0 * look.x * look.x * look.x;
    color = mix(uBody, uPale, 0.3);
    energy = (0.035 + 0.06 * look.z) * (0.55 + 0.45 * sin(uTime * (0.3 + look.y) + look.x * 17.0));
    energy *= 9.0 / (size * size);
  }

  float sigma = max(size * 0.42 * scale, 0.55);
  float spread = size * 0.42 * scale / sigma;
  energy *= spread * spread;

  // Stretch along the direction of travel as motion blur, keeping the same
  // total light so a fast grain is a faint thread, not a bright bar.
  vec2 travel = vel * pixelsPerUnit * uShutter;
  float streak = clamp(length(travel) - 2.5 * scale, 0.0, (heat > 0.0 ? 15.0 : 9.0) * scale);
  vec2 axis = streak > 0.0 ? normalize(travel) : vec2(1.0, 0.0);
  float halfStreak = streak * 0.5;
  // A loose grain keeps its total light when it streaks; a settled one is
  // dimmed far less, so a moving limb does not fade next to the still torso.
  energy /= pow(1.0 + streak / (2.5 * sigma), heat > 0.0 ? 0.75 : 0.25);

  float halfWide = sigma * 2.4 + 0.5;
  float halfLong = halfWide + halfStreak;
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vLocal = vec2(corner.x * halfLong, corner.y * halfWide);
  vShape = vec2(halfStreak, sigma);
  vColor = vec4(color * energy * fade * uGain, fade);

  vec2 centre = p / uExtent * uResolution;
  vec2 pixel = centre + axis * vLocal.x + vec2(-axis.y, axis.x) * vLocal.y;
  vec2 clip = pixel / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const DRAW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vShape;
in vec4 vColor;
out vec4 o;
void main() {
  float along = max(abs(vLocal.x) - vShape.x, 0.0);
  float r2 = along * along + vLocal.y * vLocal.y;
  float falloff = exp(-r2 / (2.0 * vShape.y * vShape.y));
  o = vec4(vColor.rgb * falloff, vColor.a * falloff);
}
`;

/**
 * Head count. Each output texel tallies a 16 x 16 block of grains as
 * settled, in flight or waiting, small enough to read back every few frames.
 */
export const CENSUS_FS = /* glsl */ `#version 300 es
${COMMON}
uniform sampler2D uAux;
uniform int uSide;
out vec4 o;
void main() {
  ivec2 corner = ivec2(gl_FragCoord.xy) * 16;
  vec3 tally = vec3(0.0);
  for (int j = 0; j < 16; j++) {
    for (int i = 0; i < 16; i++) {
      ivec2 cell = corner + ivec2(i, j);
      if (cell.x >= uSide || cell.y >= uSide) continue;
      if (dice(cell, 0u).w < MOTE_SHARE) continue;
      vec4 A = texelFetch(uAux, cell, 0);
      if (A.w <= 0.0) tally.z += 1.0;
      else if (A.z <= 0.0) tally.x += 1.0;
      else tally.y += 1.0;
    }
  }
  o = vec4(tally, 1.0);
}
`;

/**
 * Where the settled grains are. Each one adds a count to a coarse grid, so
 * the simulation can tell which parts of the body are thin and send new
 * grains there first.
 */
export const DENSITY_VS = /* glsl */ `#version 300 es
${COMMON}
uniform sampler2D uPos;
uniform sampler2D uAux;
uniform int uSide;
uniform vec2 uExtent;
void main() {
  ivec2 cell = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);
  vec4 A = texelFetch(uAux, cell, 0);
  bool counted = A.w > 0.0 && A.z <= 0.0 && dice(cell, 0u).w >= MOTE_SHARE;
  vec2 at = texelFetch(uPos, cell, 0).xy / uExtent;
  gl_Position = counted ? vec4(at * 2.0 - 1.0, 0.0, 1.0) : vec4(3.0, 3.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

export const DENSITY_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 o;
void main() {
  o = vec4(1.0);
}
`;

/**
 * Second half of the density blur. Turns counts into "how crowded compared
 * with an even spread" and treats everything outside the body as slightly
 * crowded, so grains spreading out do not spill over the outline.
 */
export const CROWD_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uSurface;
uniform vec2 uStep;
uniform float uExpected;
out vec4 o;
void main() {
  float sum = texture(uSrc, vUv).r * 0.2042;
  sum += (texture(uSrc, vUv + uStep).r + texture(uSrc, vUv - uStep).r) * 0.1802;
  sum += (texture(uSrc, vUv + uStep * 2.0).r + texture(uSrc, vUv - uStep * 2.0).r) * 0.1238;
  sum += (texture(uSrc, vUv + uStep * 3.0).r + texture(uSrc, vUv - uStep * 3.0).r) * 0.0663;
  sum += (texture(uSrc, vUv + uStep * 4.0).r + texture(uSrc, vUv - uStep * 4.0).r) * 0.0276;
  float outside = 1.0 - smoothstep(-0.004, 0.003, texture(uSurface, vUv).x);
  o = vec4(sum / uExpected + 1.15 * outside, 0.0, 0.0, 1.0);
}
`;
