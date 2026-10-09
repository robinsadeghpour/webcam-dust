import { FilesetResolver, ImageSegmenter, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { MaskFrame } from '../fields';
import { JOINT_COUNT, LANDMARK_ID, type Point, type Pose, type Source } from './source';

const CROP_HEIGHT = 512;


/**
 * Webcam (or a video file) run through MediaPipe: the selfie model for the
 * mask and the pose landmarker for the joints. The frame is mirrored and
 * cropped to the stage first, so the models spend all of their resolution on
 * what ends up on screen and everything comes back in stage coordinates.
 */
export class CameraSource implements Source {
  readonly kind = 'camera';
  readonly preview: HTMLVideoElement;
  pose: Pose | null = null;
  confidence = 0;
  inferenceMs = 0;
  private readonly crop = document.createElement('canvas');
  private readonly pen: CanvasRenderingContext2D;
  private lastVideoTime = -1;
  private lastStamp = 0;
  private bytes = new Uint8Array(0);
  /** Set by the browser each time the video presents a new frame. */
  private fresh = false;
  private readonly watchesFrames: boolean;
  private frameRequest = 0;
  private steady: Pose = new Array<Point | null>(JOINT_COUNT).fill(null);

  private constructor(
    video: HTMLVideoElement,
    private readonly segmenter: ImageSegmenter,
    private readonly landmarker: PoseLandmarker | null,
    private readonly stream: MediaStream | null,
  ) {
    this.preview = video;
    this.pen = this.crop.getContext('2d', { willReadFrequently: false })!;
    this.watchesFrames = 'requestVideoFrameCallback' in video;
    if (this.watchesFrames) {
      const onFrame = (): void => {
        this.fresh = true;
        this.frameRequest = video.requestVideoFrameCallback(onFrame);
      };
      this.frameRequest = video.requestVideoFrameCallback(onFrame);
    }
  }

  get label(): string {
    const v = this.preview;
    const size = v.videoWidth ? ` ${v.videoWidth}×${v.videoHeight}` : '';
    return (this.stream ? 'CAMERA' : 'VIDEO') + size;
  }

  /** Opens the camera, or plays `clip` instead when a video URL is given. */
  static async open(clip: string | null): Promise<CameraSource> {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    let stream: MediaStream | null = null;
    if (clip) {
      video.src = clip;
      video.loop = true;
      video.crossOrigin = 'anonymous';
    } else {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open a camera.');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      video.srcObject = stream;
    }
    try {
      await video.play();
      const base = import.meta.env.BASE_URL;
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe`);
      const segmenter = await onGpuOrCpu((delegate) =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}models/selfie_segmenter.tflite`, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
      );
      // The effect works from the mask alone; the pose only feeds the overlay.
      const landmarker = await onGpuOrCpu((delegate) =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}models/pose_landmarker_lite.task`, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
        }),
      ).catch((error: unknown) => {
        console.warn('Pose tracking unavailable; the overlay will show the outline only.', error);
        return null;
      });
      return new CameraSource(video, segmenter, landmarker, stream);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  update(_time: number, aspect: number): MaskFrame | null {
    const video = this.preview;
    if (video.readyState < 2 || video.videoWidth === 0) return null;
    // Run the models once per camera frame, however fast the display refreshes.
    if (this.watchesFrames) {
      if (!this.fresh) return null;
      this.fresh = false;
    } else {
      if (video.currentTime === this.lastVideoTime) return null;
      this.lastVideoTime = video.currentTime;
    }

    // Centre crop to the stage's shape, flipped so it behaves like a mirror.
    const width = Math.round((CROP_HEIGHT * aspect) / 2) * 2;
    if (this.crop.width !== width || this.crop.height !== CROP_HEIGHT) {
      this.crop.width = width;
      this.crop.height = CROP_HEIGHT;
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const takeW = Math.min(vw, vh * aspect);
    const takeH = takeW / aspect;
    this.pen.setTransform(-1, 0, 0, 1, width, 0);
    this.pen.drawImage(video, (vw - takeW) / 2, (vh - takeH) / 2, takeW, takeH, 0, 0, width, CROP_HEIGHT);

    // MediaPipe wants strictly increasing timestamps.
    const stamp = Math.max(performance.now(), this.lastStamp + 1);
    const elapsed = this.lastStamp ? (stamp - this.lastStamp) / 1000 : 1 / 30;
    this.lastStamp = stamp;
    const began = performance.now();

    if (this.landmarker) {
      const found = this.landmarker.detectForVideo(this.crop, stamp);
      this.pose = this.settle(found.landmarks[0] ?? null, elapsed);
      found.close();
    }

    const result = this.segmenter.segmentForVideo(this.crop, stamp);
    const masks = result.confidenceMasks;
    if (!masks || masks.length === 0) {
      result.close();
      return null;
    }
    // Single-output models give the person directly; multi-class models put
    // the background first, so the person is whatever is not background.
    const invert = masks.length > 1;
    const mask = masks[0];
    const values = mask.getAsFloat32Array();
    if (this.bytes.length !== values.length) this.bytes = new Uint8Array(values.length);
    const bytes = this.bytes;
    let sure = 0;
    let body = 0;
    for (let k = 0; k < values.length; k++) {
      const value = invert ? 1 - values[k] : values[k];
      bytes[k] = value <= 0 ? 0 : value >= 1 ? 255 : (value * 255 + 0.5) | 0;
      if (value >= 0.5) {
        sure += value;
        body++;
      }
    }
    // How sure the segmenter is, on average, about the pixels it calls a person.
    this.confidence = body > 0 ? sure / body : 0;
    const frame: MaskFrame = { width: mask.width, height: mask.height, pixels: bytes };
    result.close();
    this.inferenceMs = performance.now() - began;
    return frame;
  }

  /**
   * Steadies the raw landmarks. A joint that barely moved is eased heavily to
   * hide jitter; one that moved far is followed almost at once.
   */
  private settle(
    landmarks: Array<{ x: number; y: number; visibility?: number }> | null,
    elapsed: number,
  ): Pose | null {
    if (!landmarks) {
      this.steady.fill(null);
      return null;
    }
    for (let joint = 0; joint < JOINT_COUNT; joint++) {
      const mark = landmarks[LANDMARK_ID[joint]];
      const seen =
        mark && (mark.visibility ?? 1) > 0.5 && mark.x > -0.02 && mark.x < 1.02 && mark.y > -0.02 && mark.y < 1.02;
      if (!seen) {
        this.steady[joint] = null;
        continue;
      }
      const before = this.steady[joint];
      if (!before) {
        this.steady[joint] = [mark.x, mark.y];
        continue;
      }
      const moved = Math.hypot(mark.x - before[0], mark.y - before[1]) / Math.max(elapsed, 1e-3);
      const follow = 1 - Math.exp(-elapsed * (9 + 70 * moved));
      this.steady[joint] = [before[0] + (mark.x - before[0]) * follow, before[1] + (mark.y - before[1]) * follow];
    }
    return this.steady.slice();
  }

  dispose(): void {
    if (this.watchesFrames) this.preview.cancelVideoFrameCallback(this.frameRequest);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.preview.pause();
    this.preview.remove();
    this.segmenter.close();
    this.landmarker?.close();
  }
}

async function onGpuOrCpu<T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  try {
    return await make('GPU');
  } catch {
    return await make('CPU');
  }
}
