import { JOINT_COUNT, type Point, type Pose } from './sources/source';

/**
 * The numbers the overlay shows, gathered from the pipeline itself:
 * the body-motion field the dust is thrown by, the head count of grains,
 * and the timing of the tracking models.
 */
export class Telemetry {
  pose: Pose | null = null;
  /** Fastest body speed anywhere, in output pixels per second. */
  peak = 0;
  /** How hard that speed is tearing grains off, 0..1. */
  shed = 0;
  /** Direction of that fastest movement, as a unit vector. */
  readonly peakDirection: Point = [1, 0];
  settled = 0;
  flying = 0;
  inferenceMs = 0;
  fps = 0;

  /** Velocity under each joint in output pixels per second, and its tear strength. */
  readonly jointVelocity: Point[] = Array.from({ length: JOINT_COUNT }, () => [0, 0] as Point);
  readonly jointShed = new Float32Array(JOINT_COUNT);

  /** Copies of the values above that only change a few times a second, so they can be read. */
  readonly shown = { peak: 0, shed: 0, settled: 0, flying: 0, inferenceMs: 0, fps: 0, jointSpeed: new Float32Array(JOINT_COUNT), jointShed: new Float32Array(JOINT_COUNT) };

  private field: Float32Array | null = null;
  private fieldWidth = 0;
  private fieldHeight = 0;
  private sinceShown = 1;
  private frames = 0;
  private frameTime = 0;

  /** Thresholds are body speeds in simulation units per second. */
  constructor(
    private tearLow: number,
    private tearHigh: number,
  ) {}

  setThresholds(tearLow: number, tearHigh: number): void {
    this.tearLow = tearLow;
    this.tearHigh = tearHigh;
  }

  /** Tear strength for a body speed given in simulation units per second. */
  private pull(speed: number): number {
    const t = Math.min(1, Math.max(0, (speed - this.tearLow) / (this.tearHigh - this.tearLow)));
    return t * t * (3 - 2 * t);
  }

  setMotion(field: Float32Array, width: number, height: number): void {
    this.field = field;
    this.fieldWidth = width;
    this.fieldHeight = height;
  }

  /** Where on the motion meter the two tear thresholds sit, 0..1. */
  thresholdMarks(pixelsPerUnit: number, fullScale: number): [number, number] {
    return [(this.tearLow * pixelsPerUnit) / fullScale, (this.tearHigh * pixelsPerUnit) / fullScale];
  }

  update(dt: number, pixelsPerUnit: number): void {
    const field = this.field;
    let peakUnits = 0;
    if (field) {
      let at = -1;
      for (let k = 2; k < field.length; k += 4) {
        if (field[k] > peakUnits) {
          peakUnits = field[k];
          at = k - 2;
        }
      }
      if (at >= 0 && peakUnits > 1e-4) {
        this.peakDirection[0] = field[at] / peakUnits;
        this.peakDirection[1] = field[at + 1] / peakUnits;
      }
    }
    // Rise quickly, fall a little slower, so a flick still registers.
    const target = peakUnits * pixelsPerUnit;
    const rate = target > this.peak ? 0.05 : 0.22;
    this.peak += (target - this.peak) * (1 - Math.exp(-dt / rate));
    this.shed = this.pull(this.peak / pixelsPerUnit);

    const ease = 1 - Math.exp(-dt / 0.07);
    for (let j = 0; j < JOINT_COUNT; j++) {
      const at = this.pose?.[j];
      let vx = 0;
      let vy = 0;
      if (at && field) {
        // The field trails the limb slightly, so take the fastest cell close by.
        const cx = Math.floor(at[0] * this.fieldWidth);
        const cy = Math.floor(at[1] * this.fieldHeight);
        let best = -1;
        for (let y = Math.max(0, cy - 4); y <= Math.min(this.fieldHeight - 1, cy + 4); y++) {
          for (let x = Math.max(0, cx - 4); x <= Math.min(this.fieldWidth - 1, cx + 4); x++) {
            const k = (y * this.fieldWidth + x) * 4;
            if (field[k + 2] > best) {
              best = field[k + 2];
              vx = field[k] * pixelsPerUnit;
              vy = field[k + 1] * pixelsPerUnit;
            }
          }
        }
      }
      const v = this.jointVelocity[j];
      v[0] += (vx - v[0]) * ease;
      v[1] += (vy - v[1]) * ease;
      // Hold the reading for a moment: dust torn off a wrist is still in the
      // air after the wrist itself has slowed.
      const now = this.pull(Math.hypot(v[0], v[1]) / pixelsPerUnit);
      this.jointShed[j] = Math.max(now, this.jointShed[j] * Math.exp(-dt / 0.45));
    }

    this.frames++;
    this.frameTime += dt;
    this.sinceShown += dt;
    if (this.sinceShown >= 0.1) {
      this.sinceShown = 0;
      if (this.frameTime > 0) this.fps = this.frames / this.frameTime;
      this.frames = 0;
      this.frameTime = 0;
      const s = this.shown;
      s.peak = this.peak;
      s.shed = this.shed;
      s.settled = this.settled;
      s.flying = this.flying;
      s.inferenceMs = this.inferenceMs;
      s.fps = this.fps;
      for (let j = 0; j < JOINT_COUNT; j++) {
        s.jointSpeed[j] = Math.hypot(this.jointVelocity[j][0], this.jointVelocity[j][1]);
        s.jointShed[j] = this.jointShed[j];
      }
    }
  }
}
