/**
 * Records a canvas to a video file and hands it to the browser as a
 * download. MP4 where the browser can encode it, WebM otherwise.
 */
const FORMATS: Array<{ mime: string; extension: string }> = [
  { mime: 'video/mp4;codecs=avc1.640033', extension: 'mp4' },
  { mime: 'video/mp4;codecs=avc1.42E028', extension: 'mp4' },
  { mime: 'video/mp4', extension: 'mp4' },
  { mime: 'video/webm;codecs=vp9', extension: 'webm' },
  { mime: 'video/webm;codecs=vp8', extension: 'webm' },
  { mime: 'video/webm', extension: 'webm' },
];

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;


  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** Seconds since recording began. */
  get elapsed(): number {
    return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Begins recording `canvas`; returns the file extension that will come out. */
  start(canvas: HTMLCanvasElement): string {
    const format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime));
    if (!format) throw new Error('This browser cannot record video.');
    const stream = canvas.captureStream(60);
    const recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 16_000_000 });
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(this.chunks, { type: format.mime.split(';')[0] });
      this.chunks = [];
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `dust-${stamp()}.${format.extension}`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = performance.now();
    return format.extension;
  }

  stop(): void {
    this.recorder?.stop();
    this.recorder = null;
  }
}

function stamp(): string {
  const now = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  );
}
