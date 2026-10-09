import type { MaskFrame } from '../fields';
import { J, JOINT_COUNT, type Point, type Pose as Joints, type Source } from './source';

// A stand-in performer: a figure built from soft capsules that stands, walks,
// turns, sweeps its arms, then holds a pose. It only ever produces a mask, so the
// rest of the pipeline cannot tell it apart from a segmented camera frame.

interface Pose {
  /** Arm angles from hanging straight down, opening outwards and up. */
  armL: number;
  bendL: number;
  armR: number;
  bendR: number;
  lean: number;
  /** 0 faces the viewer, 1 is side on. */
  turn: number;
  shift: number;
  nod: number;
}

const rest: Pose = { armL: 0.2, bendL: 0.14, armR: 0.2, bendR: 0.14, lean: 0, turn: 0, shift: 0, nod: 0 };
const pose = (change: Partial<Pose>): Pose => ({ ...rest, ...change });

const reach = pose({ armL: 0.3, bendL: 0.5, armR: 0.85, bendR: 2.35, lean: -0.04, nod: 0.008, shift: -0.035 });

const stride = { armL: 0.42, bendL: 0.3, armR: 0.1, bendR: 0.25 };
const turned = pose({ turn: 1, shift: 0.03, armL: 0.08, armR: 0.3, bendR: 0.4 });

// Stand, walk across and back, turn side on, sweep the arms, then hold a pose.
const score: Array<{ at: number; pose: Pose }> = [
  { at: 0.0, pose: rest },
  { at: 2.6, pose: rest },
  { at: 3.3, pose: pose({ shift: 0.11, lean: 0.035, ...stride }) },
  { at: 4.5, pose: pose({ shift: -0.11, lean: -0.035, armL: 0.1, bendL: 0.25, armR: 0.42, bendR: 0.3 }) },
  { at: 5.2, pose: rest },
  { at: 5.75, pose: turned },
  { at: 6.2, pose: turned },
  { at: 6.8, pose: rest },
  { at: 7.3, pose: pose({ armR: 2.55, bendR: 0.22, lean: -0.03 }) },
  { at: 7.8, pose: pose({ armR: 0.95, bendR: 0.5, armL: 2.6, bendL: 0.2, lean: 0.05 }) },
  { at: 8.3, pose: pose({ armL: 0.5, bendL: 0.3, armR: 2.75, bendR: 0.15, lean: -0.05 }) },
  { at: 8.8, pose: pose({ armL: 2.5, bendL: 0.3, armR: 2.5, bendR: 0.3 }) },
  { at: 9.4, pose: rest },
  { at: 10.0, pose: rest },
  { at: 10.55, pose: reach },
  { at: 15.0, pose: reach },
  { at: 16.0, pose: rest },
];

export const DEMO_LOOP = score[score.length - 1].at;

function ease(x: number): number {
  return x * x * x * (x * (6 * x - 15) + 10);
}

function poseAt(time: number): Pose {
  const t = ((time % DEMO_LOOP) + DEMO_LOOP) % DEMO_LOOP;
  let k = 0;
  while (k < score.length - 2 && score[k + 1].at <= t) k++;
  const a = score[k];
  const b = score[k + 1];
  const f = ease(Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))));
  const out = {} as Pose;
  for (const key of Object.keys(rest) as Array<keyof Pose>) {
    out[key] = a.pose[key] + (b.pose[key] - a.pose[key]) * f;
  }
  return out;
}

const add = (a: Point, b: Point, s = 1): Point => [a[0] + b[0] * s, a[1] + b[1] * s];

const HEIGHT = 480;
const FRAME_INTERVAL = 1 / 30;

export class DemoSource implements Source {
  readonly kind = 'demo';
  readonly label = 'SYNTHETIC FIGURE';
  readonly preview: HTMLCanvasElement;
  pose: Joints | null = null;
  confidence = 1;
  inferenceMs = 0;
  private readonly ink: HTMLCanvasElement;
  private readonly softened: CanvasRenderingContext2D;
  private readonly pen: CanvasRenderingContext2D;
  private bytes = new Uint8Array(0);
  private lastFrame = -1;

  constructor() {
    this.ink = document.createElement('canvas');
    this.preview = document.createElement('canvas');
    this.pen = this.ink.getContext('2d')!;
    // Read back every frame, so keep this canvas on the CPU.
    this.softened = this.preview.getContext('2d', { willReadFrequently: true })!;
  }

  update(time: number, aspect: number): MaskFrame | null {
    // Tick at camera rate so the easing downstream sees what a webcam gives it.
    const frame = Math.floor(time / FRAME_INTERVAL);
    if (frame === this.lastFrame) return null;
    this.lastFrame = frame;

    const width = Math.round((HEIGHT * aspect) / 2) * 2;
    for (const canvas of [this.ink, this.preview]) {
      if (canvas.width !== width || canvas.height !== HEIGHT) {
        canvas.width = width;
        canvas.height = HEIGHT;
      }
    }
    const began = performance.now();
    this.drawFigure(time, aspect);

    const out = this.softened;
    out.fillStyle = '#000';
    out.fillRect(0, 0, width, HEIGHT);
    if ('filter' in out) out.filter = 'blur(1.6px)';
    out.drawImage(this.ink, 0, 0);
    if ('filter' in out) out.filter = 'none';

    // Hand over plain coverage bytes, exactly what the camera path produces.
    const rgba = out.getImageData(0, 0, width, HEIGHT).data;
    if (this.bytes.length !== width * HEIGHT) this.bytes = new Uint8Array(width * HEIGHT);
    let sure = 0;
    let body = 0;
    for (let k = 0, n = this.bytes.length; k < n; k++) {
      const value = rgba[k * 4];
      this.bytes[k] = value;
      if (value >= 128) {
        sure += value;
        body++;
      }
    }
    // Same measure the camera path reports: mean coverage inside the figure.
    this.confidence = body > 0 ? sure / body / 255 : 0;
    this.inferenceMs = performance.now() - began;
    return { width, height: HEIGHT, pixels: this.bytes };
  }

  private drawFigure(time: number, aspect: number): void {
    const pen = this.pen;
    const p = poseAt(time);
    pen.setTransform(1, 0, 0, 1, 0, 0);
    pen.fillStyle = '#000';
    pen.fillRect(0, 0, this.ink.width, this.ink.height);
    pen.setTransform(HEIGHT, 0, 0, HEIGHT, 0, 0);
    pen.fillStyle = '#f4f1ec';

    // K scales the whole figure; lengths below are in picture heights at K = 1.
    // A tall picture shows the figure from the knees up; a wide one frames it
    // from the waist, the way someone sits in front of a webcam.
    const wide = aspect > 1;
    const K = wide ? 1.25 : 0.9;
    const breath = Math.sin(time * 1.5) * 0.0025;
    const sway = Math.sin(time * 0.7) * 0.003;
    const up: Point = [Math.sin(p.lean), -Math.cos(p.lean)];
    const across: Point = [Math.cos(p.lean), Math.sin(p.lean)];
    const down: Point = [-up[0], -up[1]];
    const facing = 1 - 0.7 * p.turn;
    const girth = 1 - 0.36 * p.turn;
    const limb = (a: Point, ra: number, b: Point, rb: number): void => this.limb(a, ra * K, b, rb * K);
    const from = (a: Point, direction: Point, length: number): Point => add(a, direction, length * K);

    const hip: Point = [aspect / 2 + p.shift + sway, wide ? 0.96 : 0.675];
    const chest = from(hip, up, 0.3 + breath);
    const neck = from(chest, up, 0.03);
    const shoulderL = from(from(chest, across, -0.1 * facing), down, 0.012);
    const shoulderR = from(from(chest, across, 0.1 * facing), down, 0.012);
    const head = from(from(chest, up, 0.112), across, p.nod + p.turn * 0.014);

    // The same points double as the pose the overlay draws.
    const joints: Joints = new Array<Point | null>(JOINT_COUNT).fill(null);
    const mark = (index: number, at: Point): void => {
      joints[index] = [at[0] / aspect, at[1]];
    };
    mark(J.head, head);
    mark(J.shoulderL, shoulderL);
    mark(J.shoulderR, shoulderR);

    // Torso: ribcage, waist and hips, then the slope from neck to shoulder.
    limb(from(chest, down, 0.05), 0.088 * girth, from(hip, up, 0.115), 0.068 * girth);
    limb(from(hip, up, 0.115), 0.068 * girth, from(hip, up, 0.012), 0.082 * girth);
    limb(shoulderL, 0.031, shoulderR, 0.031);
    limb(neck, 0.03, shoulderL, 0.026);
    limb(neck, 0.03, shoulderR, 0.026);
    limb(from(chest, up, 0.01), 0.025, head, 0.025);
    pen.beginPath();
    pen.ellipse(head[0], head[1], 0.047 * K * (1 - 0.06 * p.turn), 0.061 * K, p.lean, 0, Math.PI * 2);
    pen.fill();

    // Arms.
    for (const side of [-1, 1] as const) {
      const shoulder = side < 0 ? shoulderL : shoulderR;
      const lift = side < 0 ? p.armL : p.armR;
      const bend = side < 0 ? p.bendL : p.bendR;
      const aim = (angle: number): Point => [
        down[0] * Math.cos(angle) + across[0] * side * Math.sin(angle),
        down[1] * Math.cos(angle) + across[1] * side * Math.sin(angle),
      ];
      const elbow = from(shoulder, aim(lift), 0.165);
      const wrist = from(elbow, aim(lift + bend), 0.15);
      const palm = from(wrist, aim(lift + bend), 0.038);
      mark(side < 0 ? J.elbowL : J.elbowR, elbow);
      mark(side < 0 ? J.wristL : J.wristR, wrist);
      limb(shoulder, 0.03, elbow, 0.024);
      limb(elbow, 0.0235, wrist, 0.017);
      limb(wrist, 0.018, palm, 0.022);
      // Fingers and a thumb keep the hand from reading as a club.
      limb(palm, 0.017, from(palm, aim(lift + bend + 0.12), 0.032), 0.011);
      limb(wrist, 0.012, from(wrist, aim(lift + bend - 0.85), 0.036), 0.008);
    }

    // Legs run out of the bottom of the frame.
    for (const side of [-1, 1] as const) {
      const top = from(hip, across, side * 0.048 * girth);
      const knee: Point = [top[0] + side * 0.012 * facing * K, top[1] + 0.25 * K];
      const ankle: Point = [knee[0] + side * 0.006 * K, knee[1] + 0.26 * K];
      mark(side < 0 ? J.hipL : J.hipR, top);
      mark(side < 0 ? J.kneeL : J.kneeR, knee);
      mark(side < 0 ? J.ankleL : J.ankleR, ankle);
      limb(top, 0.05, knee, 0.039);
      limb(knee, 0.037, ankle, 0.027);
    }
    // Anything outside the picture counts as unseen, as it would for a camera.
    this.pose = joints.map((at) => (at && at[0] > -0.02 && at[0] < 1.02 && at[1] > -0.02 && at[1] < 1.02 ? at : null));
  }

  /** A tapered capsule, drawn as overlapping discs. */
  private limb(a: Point, radiusA: number, b: Point, radiusB: number): void {
    const pen = this.pen;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(2, Math.ceil(length / (Math.min(radiusA, radiusB) * 0.35)));
    pen.beginPath();
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const x = a[0] + (b[0] - a[0]) * f;
      const y = a[1] + (b[1] - a[1]) * f;
      const r = radiusA + (radiusB - radiusA) * f;
      pen.moveTo(x + r, y);
      pen.arc(x, y, r, 0, Math.PI * 2);
    }
    pen.fill();
  }

  dispose(): void {
    this.preview.remove();
  }
}
