import type { MaskFrame } from '../fields';

export type Point = [number, number];

/** The joints the overlay draws, in the order sources report them. */
export const J = {
  head: 0,
  shoulderL: 1,
  shoulderR: 2,
  elbowL: 3,
  elbowR: 4,
  wristL: 5,
  wristR: 6,
  hipL: 7,
  hipR: 8,
  kneeL: 9,
  kneeR: 10,
  ankleL: 11,
  ankleR: 12,
} as const;

export const JOINT_COUNT = 13;

/** MediaPipe's landmark number for each joint, shown beside it in the overlay. */
export const LANDMARK_ID = [0, 12, 11, 14, 13, 16, 15, 24, 23, 26, 25, 28, 27];

/** Which side of the picture a joint belongs to: -1 left, 1 right, 0 centre. */
export const JOINT_SIDE = [0, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1];

export const BONES: ReadonlyArray<readonly [number, number]> = [
  [J.shoulderL, J.shoulderR],
  [J.shoulderL, J.elbowL],
  [J.elbowL, J.wristL],
  [J.shoulderR, J.elbowR],
  [J.elbowR, J.wristR],
  [J.shoulderL, J.hipL],
  [J.shoulderR, J.hipR],
  [J.hipL, J.hipR],
  [J.hipL, J.kneeL],
  [J.kneeL, J.ankleL],
  [J.hipR, J.kneeR],
  [J.kneeR, J.ankleR],
];

/** Joint positions across the picture, 0..1 in both axes; null when not seen. */
export type Pose = Array<Point | null>;

/** Anything that can supply a person mask: the webcam, a clip, or the demo. */
export interface Source {
  readonly kind: 'camera' | 'demo';
  /** What the picture shows: a video, or the demo figure's canvas. */
  readonly preview: HTMLVideoElement | HTMLCanvasElement;
  /** One line for the overlay saying where the picture comes from. */
  readonly label: string;
  /** Latest joints, already mirrored like the mask. */
  readonly pose: Pose | null;
  /** How sure the tracker is that it has a person, 0..1. */
  readonly confidence: number;
  /** Milliseconds the last mask and pose took to produce. */
  readonly inferenceMs: number;
  /** Returns a fresh mask when one is due, otherwise null. */
  update(time: number, aspect: number): MaskFrame | null;
  dispose(): void;
}
