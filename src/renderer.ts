import { FULLSCREEN_VS, Program, Quad, Target, formats, pass, type GL } from './gl';
import type { Extent, Fields } from './fields';
import type { Palette } from './palettes';
import type { Particles } from './particles';
import { GRADE_FS, GROW_FS, SHRINK_FS } from './shaders/post';

const BLOOM_LEVELS = 6;

/** Draws the grains into an HDR buffer, blooms it and grades it to the canvas. */
export class Renderer {
  private scene!: Target;
  private shrunk: Target[] = [];
  private grown: Target[] = [];
  private width = 0;
  private height = 0;
  private tick = 0;

  private readonly shrinkProgram: Program;
  private readonly growProgram: Program;
  private readonly gradeProgram: Program;

  constructor(
    private readonly gl: GL,
    private readonly quad: Quad,
  ) {
    this.shrinkProgram = new Program(gl, FULLSCREEN_VS, SHRINK_FS, 'bloom shrink');
    this.growProgram = new Program(gl, FULLSCREEN_VS, GROW_FS, 'bloom grow');
    this.gradeProgram = new Program(gl, FULLSCREEN_VS, GRADE_FS, 'grade');
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const gl = this.gl;
    const spec = formats(gl).rgba16f;
    this.scene?.dispose();
    for (const t of [...this.shrunk, ...this.grown]) t.dispose();
    this.scene = new Target(gl, width, height, spec);
    this.shrunk = [];
    this.grown = [];
    let w = width;
    let h = height;
    for (let level = 0; level < BLOOM_LEVELS; level++) {
      w = Math.max(2, Math.round(w / 2));
      h = Math.max(2, Math.round(h / 2));
      this.shrunk.push(new Target(gl, w, h, spec));
      this.grown.push(new Target(gl, w, h, spec));
    }
  }

  render(particles: Particles, fields: Fields, palette: Palette, time: number, extent: Extent): void {
    const gl = this.gl;
    const quad = this.quad;

    this.scene.clear();
    particles.draw(this.scene, fields, palette, time, extent);

    // Shrink: each level is a wider, dimmer copy of the one before.
    gl.disable(gl.BLEND);
    this.shrinkProgram.use();
    let source: Target = this.scene;
    for (let level = 0; level < BLOOM_LEVELS; level++) {
      this.shrinkProgram
        .tex('uSrc', 0, source.tex)
        .v2('uTexel', 1 / source.width, 1 / source.height)
        .f('uKnee', level === 0 ? 0.55 : 0);
      pass(gl, quad, this.shrunk[level]);
      source = this.shrunk[level];
    }

    // Grow: fold the wide levels back into the sharp ones.
    this.growProgram.use();
    let wide: Target = this.shrunk[BLOOM_LEVELS - 1];
    for (let level = BLOOM_LEVELS - 2; level >= 0; level--) {
      this.growProgram
        .tex('uWide', 0, wide.tex)
        .tex('uSharp', 1, this.shrunk[level].tex)
        .v2('uTexel', 1 / wide.width, 1 / wide.height)
        .f('uSpread', 0.72);
      pass(gl, quad, this.grown[level]);
      wide = this.grown[level];
    }

    this.gradeProgram
      .use()
      .tex('uScene', 0, this.scene.tex)
      .tex('uBloom', 1, this.grown[0].tex)
      .tex('uHaze', 2, this.grown[3].tex)
      .v2('uResolution', this.width, this.height)
      .u('uTick', this.tick++)
      .f('uExposure', palette.exposure)
      .f('uBloomAmount', 0.3)
      .f('uHazeAmount', 0.16)
      .v3('uCore', palette.core)
      .v3('uRoomCentre', palette.roomCentre)
      .v3('uRoomEdge', palette.roomEdge)
      .v3('uHazeTint', palette.haze);
    pass(gl, quad, null, this.width, this.height);
  }
}
