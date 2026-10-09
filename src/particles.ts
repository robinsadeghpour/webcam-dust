import { Pair, Program, Quad, Target, FULLSCREEN_VS, formats, pass, type GL } from './gl';
import type { Extent, Fields } from './fields';
import { readFloats } from './readback';
import type { Palette } from './palettes';
import { BLUR_FS } from './shaders/field';
import { CENSUS_FS, CROWD_FS, DENSITY_FS, DENSITY_VS, DRAW_FS, DRAW_VS, SIM_FS } from './shaders/particles';

/** Everything that shapes how the dust behaves, gathered in one place. */
export const tuning = {
  /** Distance between neighbouring contour lines, in stage heights. */
  spacing: 0.0082,
  /** Radius over which the body is treated as rounding away from the viewer. */
  dome: 0.075,
  /** Larger values flatten the relief right at the outline. */
  softEdge: 0.8,
  /** Share of grains that sit on a contour line; the rest drift between. */
  onLine: 0.74,
  /** Weight of lines that follow the outline. */
  wrap: 0.22,
  /** Weight of lines that slice across the body like rings. */
  slice: 1.0,
  /** How strongly the rings bow over the rounded form. */
  tilt: 0.75,
  /** Angle of the slicing direction away from vertical, in radians. */
  lean: 0.14,
  /** How far slow noise bends the lines. */
  warp: 0.055,
  /** Speed of grains gliding along their line. */
  stream: 0.016,
  /** How dusty the figure is, 0 (clean) to 5 (very dusty); see dustSettings. */
  dust: 1,
  /** Largest share of grains that may trace the outline, and how many it gets per unit of its length. */
  rim: 0.09,
  rimDensity: 13000,
  /** Share of the body's velocity a torn grain is thrown with. */
  throwGain: 1.0,
  /** Speed of the air's slow eddies, and how fast loose grains sink. */
  turbulence: 0.085,
  gravity: 0.07,
  homeSpeed: 1.05,
  /** Exposure time used to stretch moving grains into streaks, in seconds. */
  shutter: 1 / 110,
  /** Share of grains kept back to be shed as loose dust by fast movement. */
  reserve: 0.32,
  /** Grains wanted per square unit of body; fewer are called up for a small figure. */
  density: 2600000,
};

export const DUST_LEVELS = 6;

/**
 * What the dust dial changes. `tearLow` and `tearHigh` are the body speeds
 * (units per second) where grains begin to tear away and where all of them
 * do; `tearRate` is how quickly they go; `shed` scales the extra plume a
 * fast limb throws; `linger` scales how long loose dust stays in the air;
 * `core` is the share of grains locked to the body that speed never tears off.
 */
export function dustSettings(level = tuning.dust) {
  const table = {
    tearLow: [1.3, 0.62, 0.46, 0.35, 0.27, 0.2],
    tearHigh: [3.2, 2.0, 1.7, 1.5, 1.3, 1.1],
    tearRate: [4, 6, 8, 9, 10, 12],
    shed: [0.12, 0.3, 0.45, 0.55, 0.7, 0.9],
    linger: [0.5, 0.62, 0.78, 0.92, 1.05, 1.2],
    core: [0.9, 0.7, 0.55, 0.4, 0.25, 0.1],
  };
  const at = Math.min(DUST_LEVELS - 1, Math.max(0, level));
  const lower = Math.floor(at);
  const upper = Math.min(DUST_LEVELS - 1, lower + 1);
  const f = at - lower;
  const pick = (row: number[]): number => row[lower] + (row[upper] - row[lower]) * f;
  return {
    tearLow: pick(table.tearLow),
    tearHigh: pick(table.tearHigh),
    tearRate: pick(table.tearRate),
    shed: pick(table.shed),
    linger: pick(table.linger),
    core: pick(table.core),
  };
}

export class Particles {
  readonly side: number;
  readonly count: number;

  private readonly state: Pair;
  private readonly simProgram: Program;
  private readonly drawProgram: Program;
  private readonly drawVao: WebGLVertexArrayObject;
  private readonly census: Target;
  private readonly censusProgram: Program;
  private readonly censusData: Float32Array;
  private density: Pair | null = null;
  private readonly densityProgram: Program;
  private readonly blurProgram: Program;
  private readonly crowdProgram: Program;
  private censusTaken = false;
  private frame = 1;
  private burst = 0;
  private active = 1;
  private boost = 1;
  private bodyArea = 0;
  private rimFill = 1;
  /** Latest head count: grains settled in the figure, in flight, and waiting. */
  readonly tally = { settled: 0, flying: 0, waiting: 0 };

  constructor(
    private readonly gl: GL,
    private readonly quad: Quad,
    private readonly flow: WebGLTexture,
    requested: number,
  ) {
    this.side = Math.max(64, Math.min(1448, Math.round(Math.sqrt(requested))));
    this.count = this.side * this.side;
    this.state = new Pair(gl, this.side, this.side, formats(gl).rgba32fNearest, 2);
    this.simProgram = new Program(gl, FULLSCREEN_VS, SIM_FS, 'simulate');
    this.drawProgram = new Program(gl, DRAW_VS, DRAW_FS, 'draw grains');
    this.drawVao = gl.createVertexArray()!;
    const blocks = Math.ceil(this.side / 16);
    this.census = new Target(gl, blocks, blocks, formats(gl).rgba16f);
    this.censusProgram = new Program(gl, FULLSCREEN_VS, CENSUS_FS, 'census');
    this.densityProgram = new Program(gl, DENSITY_VS, DENSITY_FS, 'density');
    this.blurProgram = new Program(gl, FULLSCREEN_VS, BLUR_FS, 'density blur');
    this.crowdProgram = new Program(gl, FULLSCREEN_VS, CROWD_FS, 'crowding');
    this.censusData = new Float32Array(blocks * blocks * 4);
    this.scatter();
  }

  /** Send every grain back to the waiting pool so the figure forms afresh. */
  scatter(): void {
    this.state.read.clear();
    this.state.write.clear();
  }

  /** Blow the whole figure apart on the next step. */
  kick(strength = 1): void {
    this.burst = strength;
  }

  /**
   * Tell the system how much body there is to cover (square units) and how
   * long its outline is (units). It eases the share of grains in use towards
   * what those need.
   */
  cover(area: number, perimeter: number, dt: number): void {
    const rimWanted = tuning.rimDensity * perimeter;
    const rimFill = Math.min(1, Math.max(0.02, rimWanted / (this.count * tuning.rim)));
    this.rimFill += (rimFill - this.rimFill) * (1 - Math.exp(-dt / 0.4));
    const figureGrains = this.count * (1 - tuning.reserve);
    const wanted = tuning.density * area;
    const share = Math.min(1, Math.max(0.08, wanted / figureGrains));
    this.active += (share - this.active) * (1 - Math.exp(-dt / 0.4));
    // With too few grains to go round, each one carries a little more light.
    this.boost = Math.pow(Math.max(1, wanted / figureGrains), 0.8);
    this.bodyArea = area;
  }

  /**
   * Count the settled grains into a coarse grid over the stage and turn that
   * into how crowded each cell is, where 1 is an even spread over the body.
   */
  private survey(fields: Fields, extent: Extent): void {
    const gl = this.gl;
    const height = 256;
    const width = Math.round((height * extent.x) / extent.y / 2) * 2;
    if (!this.density || this.density.read.width !== width) {
      this.density?.dispose();
      this.density = new Pair(gl, width, height, formats(gl).rgba16f);
    }
    const density = this.density;
    density.write.clear();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.densityProgram
      .use()
      .tex('uPos', 0, this.state.read.textures[0])
      .tex('uAux', 1, this.state.read.textures[1])
      .i('uSide', this.side)
      .v2('uExtent', extent.x, extent.y)
      .f('uDome', tuning.dome)
      .f('uSoftEdge', tuning.softEdge)
      .f('uReserve', tuning.reserve)
      .f('uRim', tuning.rim)
      .f('uRimFill', this.rimFill);
    gl.bindVertexArray(this.drawVao);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    const cellArea = (extent.x / width) * (extent.y / height);
    const settledTarget = this.count * (1 - tuning.reserve) * this.active;
    const expected = Math.max(0.5, (settledTarget * cellArea) / Math.max(this.bodyArea, 1e-4));
    this.blurProgram.use().tex('uSrc', 0, density.write.tex).v2('uStep', 0.8 / width, 0);
    pass(gl, this.quad, density.read);
    this.crowdProgram
      .use()
      .tex('uSrc', 0, density.read.tex)
      .tex('uSurface', 1, fields.surface)
      .v2('uStep', 0, 0.8 / height)
      .f('uExpected', expected);
    pass(gl, this.quad, density.write);
    density.swap();
  }

  step(fields: Fields, dt: number, time: number, extent: Extent): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const t = tuning;
    const dust = dustSettings();
    this.survey(fields, extent);
    gl.disable(gl.BLEND);
    this.simProgram
      .use()
      .tex('uPos', 0, this.state.read.textures[0])
      .tex('uAux', 1, this.state.read.textures[1])
      .tex('uSurface', 2, fields.surface)
      .tex('uMotion', 3, fields.bodyMotion)
      .tex('uFlow', 4, this.flow)
      .tex('uCarried', 5, fields.carried)
      .tex('uRide', 6, fields.surfaceRide)
      .tex('uCrowd', 7, this.density!.read.tex)
      .v2('uCrowdTexel', 1 / this.density!.read.width, 1 / this.density!.read.height)
      .f('uCrowdCell', extent.y / this.density!.read.height)
      .f('uRim', t.rim)
      .f('uRimFill', this.rimFill)
      .f('uShed', dust.shed)
      .f('uLinger', dust.linger)
      .f('uCore', dust.core)
      .f('uDt', dt)
      .f('uTime', time)
      .v2('uExtent', extent.x, extent.y)
      .u('uFrame', this.frame)
      .f('uActive', this.active)
      .f('uBurst', this.burst)
      .f('uDome', t.dome)
      .f('uSoftEdge', t.softEdge)
      .f('uOnLine', t.onLine)
      .f('uReserve', t.reserve)
      .v2('uSliceDir', Math.sin(t.lean), Math.cos(t.lean))
      .f('uSpacing', t.spacing)
      .f('uWrap', t.wrap)
      .f('uSlice', t.slice)
      .f('uTilt', t.tilt)
      .f('uWarp', t.warp)
      .f('uStream', t.stream)
      .f('uTearLow', dust.tearLow)
      .f('uTearHigh', dust.tearHigh)
      .f('uTearRate', dust.tearRate)
      .f('uThrow', t.throwGain)
      .f('uTurbulence', t.turbulence)
      .f('uGravity', t.gravity)
      .f('uHomeSpeed', t.homeSpeed);
    pass(gl, this.quad, this.state.write);
    this.state.swap();
    this.frame = (this.frame + 1) >>> 0;
    this.burst = 0;

    // Count heads ten times a second; the result is read at the next frame.
    if (this.frame % 6 === 0) this.takeCensus();
  }

  /** Tally the grains on the GPU, ready for readTally(). */
  takeCensus(): void {
    const t = tuning;
    this.gl.disable(this.gl.BLEND);
    this.censusProgram
      .use()
      .tex('uAux', 0, this.state.read.textures[1])
      .i('uSide', this.side)
      .f('uDome', t.dome)
      .f('uSoftEdge', t.softEdge)
      .f('uReserve', t.reserve)
      .f('uRim', t.rim)
      .f('uRimFill', this.rimFill);
    pass(this.gl, this.quad, this.census);
    this.censusTaken = true;
  }

  /** Pick up the last head count, if there is a new one. */
  readTally(): void {
    if (!this.censusTaken) return;
    this.censusTaken = false;
    const data = readFloats(this.gl, this.census, this.censusData);
    let settled = 0;
    let flying = 0;
    let waiting = 0;
    for (let k = 0; k < data.length; k += 4) {
      settled += data[k];
      flying += data[k + 1];
      waiting += data[k + 2];
    }
    this.tally.settled = Math.round(settled);
    this.tally.flying = Math.round(flying);
    this.tally.waiting = Math.round(waiting);
  }

  /** Additively draw every grain into an HDR target. */
  draw(target: Target, fields: Fields, palette: Palette, time: number, extent: Extent): void {
    const gl = this.gl;
    target.bind();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const gain = 0.46 * this.boost;
    this.drawProgram
      .use()
      .tex('uPos', 0, this.state.read.textures[0])
      .tex('uAux', 1, this.state.read.textures[1])
      .tex('uSurface', 2, fields.surface)
      .i('uSide', this.side)
      .v2('uExtent', extent.x, extent.y)
      .f('uTime', time)
      .v2('uResolution', target.width, target.height)
      .f('uGain', gain)
      .f('uEdgeGain', 1 / this.boost)
      .f('uShutter', tuning.shutter)
      .f('uDome', tuning.dome)
      .f('uSoftEdge', tuning.softEdge)
      .f('uReserve', tuning.reserve)
      .f('uRim', tuning.rim)
      .f('uRimFill', this.rimFill)
      .v3('uDeep', palette.deep)
      .v3('uBody', palette.body)
      .v3('uPale', palette.pale)
      .v3('uEmber', palette.ember);
    gl.bindVertexArray(this.drawVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.disable(gl.BLEND);
  }

  dispose(): void {
    this.density?.dispose();
    this.census.dispose();
    this.state.dispose();
  }
}
