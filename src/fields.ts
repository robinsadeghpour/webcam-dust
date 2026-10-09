import { FULLSCREEN_VS, Pair, Program, Quad, Target, createTexture, formats, pass, type GL } from './gl';
import { readFloats } from './readback';
import {
  BLUR_FS,
  DISTANCE_FS,
  DRIFT_FS,
  RIDE_FS,
  FLOOD_FS,
  MASK_INGEST_FS,
  MOMENTS_FS,
  SEED_FS,
  SURFACE_FS,
  TRACK_FS,
} from './shaders/field';

export interface MaskFrame {
  width: number;
  height: number;
  /** 8-bit coverage, one byte per pixel, row 0 at the top. */
  pixels: Uint8Array;
}

/** Size of the stage in simulation units (one unit is 1920 design pixels at full zoom). */
export interface Extent {
  x: number;
  y: number;
}

const FIELD_HEIGHT = 512;
/** The mask takes on new coverage within this time, and gives up old coverage within the next. */
const RISE_SECONDS = 0.012;
const FALL_SECONDS = 0.022;
/** Furthest a grain is carried by the surface in one frame, in simulation units. */
export const RIDE_MAX = 0.07;
/** Spacing of the taps that smooth the ride across the body, in half-resolution texels. */
const RIDE_BLUR = 2.6;
/** How long the contour lines take to slide back after the body has moved. */
const CARRY_SECONDS = 0.7;

/**
 * Turns a person mask into the two textures the particles steer by:
 *   surface: signed distance, inward normal, mask
 *   motion:  body velocity and speed
 */
export class Fields {
  readonly width: number;
  readonly height = FIELD_HEIGHT;

  private readonly raw: WebGLTexture;
  private rawWidth = 0;
  private rawHeight = 0;
  private hasMask = false;

  private readonly mask: Pair;
  private readonly seeds: Pair;
  private readonly distance: Target;
  private readonly scratch: Target;
  private readonly sdf: Pair;
  private readonly drift: Pair;
  private readonly ride: Pair;
  private readonly surfaceTarget: Target;
  private readonly momentScratch: Target;
  private readonly moments: Pair;
  private readonly motion: Pair;

  private readonly ingestProgram: Program;
  private readonly seedProgram: Program;
  private readonly floodProgram: Program;
  private readonly distanceProgram: Program;
  private readonly blurProgram: Program;
  private readonly surfaceProgram: Program;
  private readonly momentsProgram: Program;
  private readonly trackProgram: Program;
  private readonly driftProgram: Program;
  private readonly rideProgram: Program;

  private readonly jumps: number[] = [];
  private settled = 0;
  private readonly motionData: Float32Array;
  /** Simulation units covered by one field texel. */
  private readonly unit: number;

  constructor(
    private readonly gl: GL,
    private readonly quad: Quad,
    private readonly extent: Extent,
  ) {
    const f = formats(gl);
    this.width = Math.round((FIELD_HEIGHT * extent.x) / extent.y / 2) * 2;
    this.unit = extent.y / FIELD_HEIGHT;
    const w = this.width;
    const h = this.height;

    this.raw = createTexture(gl, 2, 2, f.r8, new Uint8Array(4));
    this.mask = new Pair(gl, w, h, f.r16f);
    this.seeds = new Pair(gl, w, h, f.rgba32fNearest);
    this.distance = new Target(gl, w, h, f.r16f);
    this.scratch = new Target(gl, w, h, f.r16f);
    this.sdf = new Pair(gl, w, h, f.r16f);
    this.drift = new Pair(gl, w / 2, h / 2, f.rgba16f);
    this.ride = new Pair(gl, w / 2, h / 2, f.rgba16f);
    this.surfaceTarget = new Target(gl, w, h, f.rgba16f);
    const mw = Math.round(w / 4);
    const mh = Math.round(h / 4);
    this.momentScratch = new Target(gl, mw, mh, f.rgba16f);
    this.moments = new Pair(gl, mw, mh, f.rgba16f);
    this.motion = new Pair(gl, mw, mh, f.rgba16f);
    this.motionData = new Float32Array(mw * mh * 4);
    this.reset();

    this.ingestProgram = new Program(gl, FULLSCREEN_VS, MASK_INGEST_FS, 'mask ingest');
    this.seedProgram = new Program(gl, FULLSCREEN_VS, SEED_FS, 'seed');
    this.floodProgram = new Program(gl, FULLSCREEN_VS, FLOOD_FS, 'flood');
    this.distanceProgram = new Program(gl, FULLSCREEN_VS, DISTANCE_FS, 'distance');
    this.blurProgram = new Program(gl, FULLSCREEN_VS, BLUR_FS, 'blur');
    this.surfaceProgram = new Program(gl, FULLSCREEN_VS, SURFACE_FS, 'surface');
    this.momentsProgram = new Program(gl, FULLSCREEN_VS, MOMENTS_FS, 'moments');
    this.trackProgram = new Program(gl, FULLSCREEN_VS, TRACK_FS, 'track');
    this.driftProgram = new Program(gl, FULLSCREEN_VS, DRIFT_FS, 'drift');
    this.rideProgram = new Program(gl, FULLSCREEN_VS, RIDE_FS, 'ride');

    // Halving jumps, then two single steps to mop up the flood's small errors.
    let jump = 1;
    while (jump * 2 < Math.max(w, h)) jump *= 2;
    for (; jump >= 1; jump = Math.floor(jump / 2)) this.jumps.push(jump);
    this.jumps.push(2, 1);
  }

  get surface(): WebGLTexture {
    return this.surfaceTarget.tex;
  }

  get bodyMotion(): WebGLTexture {
    return this.motion.read.tex;
  }

  /** How far the surface moved this frame, weighted; see RIDE_FS. */
  get surfaceRide(): WebGLTexture {
    return this.ride.read.tex;
  }

  /** How far the surface has carried each point; see DRIFT_FS. */
  get carried(): WebGLTexture {
    return this.drift.read.tex;
  }

  /** Upload the newest mask from the camera or the demo figure. */
  ingest(frame: MaskFrame): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.raw);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, frame.width, frame.height, 0, gl.RED, gl.UNSIGNED_BYTE, frame.pixels);
    this.rawWidth = frame.width;
    this.rawHeight = frame.height;
    this.hasMask = true;
  }

  /** Forget the current figure (used when the source changes). */
  reset(): void {
    this.hasMask = false;
    this.settled = 0;
    for (const pair of [this.mask, this.moments, this.motion, this.drift, this.ride]) {
      pair.read.clear();
      pair.write.clear();
    }
    this.surfaceTarget.clear(-1, 0, 0, 0);
  }

  update(dt: number): void {
    const gl = this.gl;
    const quad = this.quad;
    const w = this.width;
    const h = this.height;
    gl.disable(gl.BLEND);

    if (!this.hasMask) {
      this.surfaceTarget.clear(-1, 0, 0, 0);
      return;
    }

    // 1. Temporal easing hides the camera's frame steps and mask flicker.
    this.ingestProgram
      .use()
      .tex('uRaw', 0, this.raw)
      .tex('uPrev', 1, this.mask.read.tex)
      .v2('uTexel', 1.5 / Math.max(this.rawWidth, w), 1.5 / Math.max(this.rawHeight, h))
      .f('uRise', this.settled === 0 ? 1 : 1 - Math.exp(-dt / RISE_SECONDS))
      .f('uFall', this.settled === 0 ? 1 : 1 - Math.exp(-dt / FALL_SECONDS));
    pass(gl, quad, this.mask.write);
    this.mask.swap();

    // 2. Jump flood from the outline to get the nearest edge point everywhere.
    this.seedProgram.use().tex('uMask', 0, this.mask.read.tex);
    pass(gl, quad, this.seeds.write);
    this.seeds.swap();
    this.floodProgram.use();
    for (const jump of this.jumps) {
      this.floodProgram.tex('uSeeds', 0, this.seeds.read.tex).i('uJump', jump);
      pass(gl, quad, this.seeds.write);
      this.seeds.swap();
    }

    // 3. Signed distance, rounded off so contours do not kink at the spine.
    this.distanceProgram
      .use()
      .tex('uSeeds', 0, this.seeds.read.tex)
      .tex('uMask', 1, this.mask.read.tex)
      .f('uUnit', this.unit);
    pass(gl, quad, this.distance);
    this.blurProgram.use().tex('uSrc', 0, this.distance.tex).v2('uStep', 0.8 / w, 0);
    pass(gl, quad, this.scratch);
    this.blurProgram.tex('uSrc', 0, this.scratch.tex).v2('uStep', 0, 0.8 / h);
    pass(gl, quad, this.sdf.write);
    this.sdf.swap();
    // On the first frame there is no earlier surface to compare with.
    if (this.settled === 0) pass(gl, quad, this.sdf.write);

    this.surfaceProgram
      .use()
      .tex('uSdf', 0, this.sdf.read.tex)
      .tex('uSdfBefore', 1, this.sdf.write.tex)
      .f('uUnit', this.unit);
    pass(gl, quad, this.surfaceTarget);

    // How far the surface moved under each point, smoothed across the body.
    this.rideProgram.use().tex('uSurface', 0, this.surfaceTarget.tex).f('uRideMax', RIDE_MAX);
    pass(gl, quad, this.ride.write);
    this.blurProgram.use().tex('uSrc', 0, this.ride.write.tex).v2('uStep', RIDE_BLUR / (w / 2), 0);
    pass(gl, quad, this.ride.read);
    this.blurProgram.tex('uSrc', 0, this.ride.read.tex).v2('uStep', 0, RIDE_BLUR / (h / 2));
    pass(gl, quad, this.ride.write);
    this.ride.swap();

    this.driftProgram
      .use()
      .tex('uRide', 0, this.ride.read.tex)
      .tex('uPrev', 1, this.drift.read.tex)
      .v2('uExtent', this.extent.x, this.extent.y)
      .f('uKeep', Math.exp(-dt / CARRY_SECONDS));
    pass(gl, quad, this.drift.write);
    this.drift.swap();

    // 4. Body motion: follow the local centre of mass from frame to frame.
    const mw = this.moments.read.width;
    const mh = this.moments.read.height;
    this.momentsProgram
      .use()
      .tex('uMask', 0, this.mask.read.tex)
      .v2('uTexel', 1 / w, 1 / h)
      .v2('uExtent', this.extent.x, this.extent.y);
    pass(gl, quad, this.moments.write);
    this.blurProgram.use().tex('uSrc', 0, this.moments.write.tex).v2('uStep', 2.2 / mw, 0);
    pass(gl, quad, this.momentScratch);
    this.blurProgram.tex('uSrc', 0, this.momentScratch.tex).v2('uStep', 0, 2.2 / mh);
    pass(gl, quad, this.moments.write);
    this.moments.swap();

    this.trackProgram
      .use()
      .tex('uNow', 0, this.moments.read.tex)
      .tex('uBefore', 1, this.moments.write.tex)
      .tex('uPrev', 2, this.motion.read.tex)
      .f('uInvDt', this.settled >= 2 ? 1 / Math.max(dt, 1 / 240) : 0)
      .f('uLimit', 5)
      .f('uBlend', 1 - Math.exp(-dt / 0.03));
    pass(gl, quad, this.motion.write);
    this.motion.swap();

    this.settled++;
  }

  /**
   * The body-motion field from the last update as numbers: four floats per
   * cell (velocity x, velocity y, speed, unused).
   */
  readMotion(): { data: Float32Array; width: number; height: number } {
    const target = this.motion.read;
    return { data: readFloats(this.gl, target, this.motionData), width: target.width, height: target.height };
  }

  dispose(): void {
    this.gl.deleteTexture(this.raw);
    for (const p of [this.mask, this.seeds, this.sdf, this.drift, this.ride, this.moments, this.motion]) p.dispose();
    for (const t of [this.distance, this.scratch, this.surfaceTarget, this.momentScratch]) t.dispose();
  }
}
