import './style.css';
import { Fields, type Extent } from './fields';
import { Quad, type GL } from './gl';
import { Hud, drawPicture, type HudMode, type Rect } from './hud';
import { createFlowTexture } from './noise';
import { Outline } from './outline';
import { Overlay } from './overlay';
import { palettes } from './palettes';
import { DUST_LEVELS, Particles, dustSettings, tuning } from './particles';
import { Recorder } from './recorder';
import { Renderer } from './renderer';
import { CameraSource } from './sources/camera';
import { DemoSource } from './sources/demo';
import type { Source } from './sources/source';
import { Telemetry } from './telemetry';

type View = 'split' | 'pip' | 'solo';
const views: View[] = ['split', 'pip', 'solo'];
const viewNames: Record<View, string> = { split: 'Split', pip: 'Picture in picture', solo: 'Effect only' };
type Aspect = 'portrait' | 'landscape' | 'fill';
const aspects: Aspect[] = ['portrait', 'landscape', 'fill'];
const aspectNames: Record<Aspect, string> = { portrait: 'Portrait 9:16', landscape: 'Landscape 16:9', fill: 'Fill the window' };
const corners = ['tr', 'br', 'bl', 'tl'] as const;
const hudModes: HudMode[] = ['full', 'plain', 'skeleton', 'off'];
const hudNames: Record<HudMode, string> = { full: 'RGB', plain: 'Plain', skeleton: 'Skeleton', off: 'Off' };

/** Longest side of the stage, in pixels. */
const LONG_SIDE = 1920;
/** Size of a reel: what a wide stage is centred in when recorded as one. */
const REEL = { w: 1080, h: 1920 };
/** How much larger the overlay is drawn while a reel frame records, since the stage is shown small in it. */
const REEL_OVERLAY_SCALE = 1.4;

// ---- options from the address bar ----
const query = new URLSearchParams(location.search);
const numeric = (name: string, fallback: number): number => {
  const value = Number(query.get(name));
  return query.has(name) && Number.isFinite(value) ? value : fallback;
};
const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T =>
  allowed.includes(query.get(name) as T) ? (query.get(name) as T) : fallback;
const options = {
  demo: query.get('demo') === '1',
  /** Number of grains. */
  count: numeric('count', 800000),
  /** Start on palette 1..n. */
  palette: Math.min(palettes.length, Math.max(1, Math.round(numeric('palette', 1)))) - 1,
  view: pick('view', views, 'split'),
  /** Shape of the stage. Wide windows fill by default, tall ones get the 9:16 portrait stage. */
  aspect: pick('aspect', aspects, window.innerWidth > window.innerHeight ? 'fill' : 'portrait'),
  /** Record wide stages centred in a 1080 x 1920 frame. */
  reel: query.get('reel') === '1',
  /** Tracking overlay: full (RGB), plain, skeleton or off. */
  hud: pick('hud', hudModes, 'full'),
  /** Resolution of the dust relative to the stage. */
  scale: Math.min(2, Math.max(0.25, numeric('scale', 1))),
  /** Play a video file through the tracker instead of the camera. */
  clip: query.get('video'),
  /** Do not animate; a script calls __dust.advance() instead. */
  manual: query.get('step') === '1',
};

// Any tuning value can be tried from the address bar, e.g. ?t.spacing=0.01
for (const [name, value] of query) {
  const key = name.startsWith('t.') ? name.slice(2) : '';
  if (key in tuning && Number.isFinite(Number(value))) tuning[key as keyof typeof tuning] = Number(value);
}

const stage = document.getElementById('stage') as HTMLElement;
const view = document.getElementById('view') as HTMLCanvasElement;
const overlay = new Overlay();

interface Size {
  w: number;
  h: number;
}

interface Layout {
  /** Where the dust is drawn on the stage. */
  figure: Rect;
  /** Where the live picture is drawn, if at all. */
  picture: Rect | null;
  pictureIsPanel: boolean;
  /** Size of the dust's world in simulation units. */
  extent: Extent;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Pixel size of the stage for a given shape; "fill" takes the window's own proportions. */
function stageSize(aspect: Aspect): Size {
  if (aspect === 'portrait') return { w: 1080, h: LONG_SIDE };
  if (aspect === 'landscape') return { w: LONG_SIDE, h: 1080 };
  const ratio = Math.min(2.6, Math.max(0.4, window.innerWidth / Math.max(1, window.innerHeight)));
  return ratio >= 1 ? { w: LONG_SIDE, h: even(LONG_SIDE / ratio) } : { w: even(LONG_SIDE * ratio), h: LONG_SIDE };
}

/**
 * How large the dust's world is for a figure drawn in `box`. One unit is
 * 1920 pixels at full zoom; a smaller picture is zoomed out a little so the
 * grain stays in proportion to the figure.
 */
function extentFor(box: Rect): Extent {
  const zoom = 0.5 + (0.5 * box.h) / LONG_SIDE;
  const y = box.h / LONG_SIDE / zoom;
  return { x: (y * box.w) / box.h, y };
}

function layoutFor(which: View, corner: (typeof corners)[number], size: Size): Layout {
  const { w, h } = size;
  const wide = w > h;
  if (which === 'split') {
    // The picture and the figure share the stage half and half, framed alike:
    // stacked on a tall stage, side by side on a wide one.
    const picture = wide ? { x: 0, y: 0, w: w / 2, h } : { x: 0, y: 0, w, h: h / 2 };
    const figure = wide ? { x: w / 2, y: 0, w: w / 2, h } : { x: 0, y: h / 2, w, h: h / 2 };
    return { figure, picture, pictureIsPanel: true, extent: extentFor(figure) };
  }
  const figure = { x: 0, y: 0, w, h };
  const extent = extentFor(figure);
  if (which === 'solo') return { figure, picture: null, pictureIsPanel: false, extent };
  const ph = Math.round(h * (wide ? 0.32 : 0.283));
  const pw = Math.round((ph * w) / h);
  const inset = wide ? 48 : 96;
  const x = corner.endsWith('l') ? 48 : w - 48 - pw;
  const y = corner.startsWith('t') ? inset : h - inset - ph;
  return { figure, picture: { x, y, w: pw, h: ph }, pictureIsPanel: false, extent };
}

function start(): void {
  // The dust is rendered off screen with WebGL, then composed with the live
  // picture and the tracking overlay on one 2D canvas. That canvas is what
  // is shown, and what is recorded.
  const paper = view.getContext('2d', { alpha: false });
  const glCanvas = document.createElement('canvas');
  const reelCanvas = document.createElement('canvas');
  reelCanvas.width = REEL.w;
  reelCanvas.height = REEL.h;
  const reelPaper = reelCanvas.getContext('2d', { alpha: false });
  const context = glCanvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!paper || !reelPaper || !context || !context.getExtension('EXT_color_buffer_float')) {
    overlay.say('This needs WebGL 2 with float render targets.', 60);
    return;
  }
  const pen: CanvasRenderingContext2D = paper;
  const reelPen: CanvasRenderingContext2D = reelPaper;
  const gl: GL = context;
  context.getExtension('OES_texture_float_linear');

  const quad = new Quad(gl);
  const particles = new Particles(gl, quad, createFlowTexture(gl), options.count);
  const renderer = new Renderer(gl, quad);
  const hud = new Hud(pen);
  const outline = new Outline();
  const telemetry = new Telemetry(dustSettings().tearLow, dustSettings().tearHigh);
  const recorder = Recorder.supported ? new Recorder() : null;

  let which: View = options.view;
  let aspect: Aspect = options.aspect;
  let reel = options.reel;
  let corner = 0;
  let hudMode: HudMode = options.hud;
  let paletteIndex = options.palette;
  let size = stageSize(aspect);
  let layout = layoutFor(which, corners[corner], size);
  let fields = new Fields(gl, quad, layout.extent);
  let source: Source | null = null;
  let opening = false;
  let time = 0;
  /** True while the recording in progress is a reel frame around a wide stage. */
  let recordingReel = false;

  const pixelsPerUnit = (): number => layout.figure.h / layout.extent.y;
  const isWide = (): boolean => size.w > size.h;

  function applyLayout(): void {
    const before = layout.extent;
    size = stageSize(aspect);
    layout = layoutFor(which, corners[corner], size);
    if (view.width !== size.w || view.height !== size.h) {
      view.width = size.w;
      view.height = size.h;
    }
    const width = Math.round(layout.figure.w * options.scale);
    const height = Math.round(layout.figure.h * options.scale);
    if (glCanvas.width !== width || glCanvas.height !== height) {
      glCanvas.width = width;
      glCanvas.height = height;
    }
    renderer.resize(width, height);
    if (before.x !== layout.extent.x || before.y !== layout.extent.y) {
      fields.dispose();
      fields = new Fields(gl, quad, layout.extent);
      particles.scatter();
      outline.clear();
    }
    fit();
  }

  /** Scale the stage to fit the window; its own pixel size does not change. */
  function fit(): void {
    const unit = Math.min(window.innerWidth / size.w, window.innerHeight / size.h);
    stage.style.width = `${size.w * unit}px`;
    stage.style.height = `${size.h * unit}px`;
    stage.style.setProperty('--u', `${unit}px`);
  }

  function describe(): void {
    overlay.describe({
      palette: palettes[paletteIndex].name,
      view: viewNames[which],
      source: source?.kind === 'camera' ? (options.clip ? 'Video' : 'Camera') : 'Demo figure',
      tracking: hudNames[hudMode],
      dust: `${Math.round(tuning.dust)} of ${DUST_LEVELS - 1}`,
      stage: aspectNames[aspect],
      reel,
      wide: isWide(),
      recording: recorder?.recording ?? false,
    });
  }

  // ---- sources ----
  function adopt(next: Source): void {
    source?.dispose();
    source = next;
    fields.reset();
    particles.scatter();
    outline.clear();
    describe();
  }

  async function openCamera(): Promise<void> {
    if (opening) return;
    opening = true;
    try {
      adopt(await CameraSource.open(options.clip));
    } catch (error) {
      console.warn('Camera unavailable, showing the demo figure instead.', error);
      if (!source) adopt(new DemoSource());
      if (!options.manual) overlay.say('Camera unavailable. Showing the demo figure.');
    } finally {
      opening = false;
    }
  }

  // ---- one step of the world, and one picture of it ----
  function advance(dt: number): void {
    time += dt;
    const extent = layout.extent;
    // Read last frame's measurements first, while the GPU is idle.
    const motion = fields.readMotion();
    telemetry.setMotion(motion.data, motion.width, motion.height);
    particles.readTally();

    const frame = source?.update(time, extent.x / extent.y);
    if (frame) {
      fields.ingest(frame);
      outline.trace(frame.pixels, frame.width, frame.height);
    }
    particles.cover(outline.coverage * extent.x * extent.y, outline.perimeter * extent.y, dt);
    fields.update(dt);
    particles.step(fields, dt, time, extent);

    telemetry.pose = source?.pose ?? null;
    telemetry.settled = particles.tally.settled;
    telemetry.flying = particles.tally.flying;
    telemetry.inferenceMs = source?.inferenceMs ?? 0;
    telemetry.update(dt, pixelsPerUnit());
  }

  function draw(): void {
    const palette = palettes[paletteIndex];
    renderer.render(particles, fields, palette, time, layout.extent);

    const f = layout.figure;
    pen.fillStyle = '#050403';
    pen.fillRect(0, 0, size.w, size.h);
    pen.drawImage(glCanvas, f.x, f.y, f.w, f.h);
    if (layout.picture) drawPicture(pen, source, layout.picture, layout.pictureIsPanel ? 0 : 40);

    // The meter is full a little past the speed where everything tears off.
    const fullScale = dustSettings().tearHigh * pixelsPerUnit() * 1.25;
    hud.draw(
      {
        mode: hudMode,
        picture: layout.picture,
        pictureIsPanel: layout.pictureIsPanel,
        figure: layout.figure,
        fullScale,
        marks: telemetry.thresholdMarks(pixelsPerUnit(), fullScale),
        sourceLabel: source?.label ?? 'NO SOURCE',
        timingLabel: source?.kind === 'camera' ? 'MODEL' : 'MASK',
        confidence: source?.confidence ?? 0,
        accent: palette.accent,
        dust: `${Math.round(tuning.dust)}/${DUST_LEVELS - 1}`,
        scale: recordingReel ? REEL_OVERLAY_SCALE : 1,
      },
      telemetry,
      outline,
    );

    if (recordingReel) {
      // The wide stage, as large as a reel's width allows, centred on near-black.
      const shown = { w: REEL.w, h: Math.round((REEL.w * size.h) / size.w) };
      reelPen.fillStyle = '#050403';
      reelPen.fillRect(0, 0, REEL.w, REEL.h);
      reelPen.imageSmoothingQuality = 'high';
      reelPen.drawImage(view, 0, Math.round((REEL.h - shown.h) / 2), shown.w, shown.h);
    }
    overlay.recording(recorder?.recording ? recorder.elapsed : null);
  }

  function toggleRecording(): void {
    if (!recorder) {
      overlay.say('This browser cannot record the canvas.');
      return;
    }
    if (recorder.recording) {
      recorder.stop();
      recordingReel = false;
      overlay.say('Saved to your downloads');
      return;
    }
    try {
      recordingReel = reel && isWide();
      recorder.start(recordingReel ? reelCanvas : view);
    } catch (error) {
      recordingReel = false;
      console.warn(error);
      overlay.say('This browser cannot record video.');
    }
  }

  // ---- keys ----
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const busy = recorder?.recording ?? false;
    if (key === 'h') {
      overlay.toggle();
    } else if (key === 'p') {
      paletteIndex = (paletteIndex + 1) % palettes.length;
    } else if (key >= '1' && key <= String(palettes.length)) {
      paletteIndex = Number(key) - 1;
    } else if (key === 'v') {
      which = views[(views.indexOf(which) + 1) % views.length];
      applyLayout();
    } else if (key === 'a') {
      // The recording's frame size is fixed once it starts.
      if (busy) {
        overlay.say('Stop recording before changing the stage', 2);
        return;
      }
      aspect = aspects[(aspects.indexOf(aspect) + 1) % aspects.length];
      applyLayout();
      overlay.say(aspectNames[aspect], 1.5);
    } else if (key === 'm') {
      if (busy) return;
      reel = !reel;
      overlay.say(reel ? 'Wide stages record as a 1080 x 1920 reel frame' : 'Recording at the size of the stage', 2);
    } else if (key === 'c') {
      corner = (corner + 1) % corners.length;
      applyLayout();
    } else if (key === 't') {
      hudMode = hudModes[(hudModes.indexOf(hudMode) + 1) % hudModes.length];
    } else if (key === 'r') {
      toggleRecording();
    } else if (key === '[' || key === ']') {
      tuning.dust = Math.min(DUST_LEVELS - 1, Math.max(0, Math.round(tuning.dust) + (key === ']' ? 1 : -1)));
      const now = dustSettings();
      telemetry.setThresholds(now.tearLow, now.tearHigh);
    } else if (key === ' ') {
      event.preventDefault();
      particles.kick(1);
    } else if (key === 'd') {
      if (source?.kind === 'camera') adopt(new DemoSource());
      else void openCamera();
    } else if (key === 'f') {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } else {
      return;
    }
    describe();
  });
  window.addEventListener('resize', () => {
    // A filled stage follows the window, except while a recording needs it to stay put.
    if (aspect === 'fill' && !(recorder?.recording ?? false)) applyLayout();
    else fit();
  });

  applyLayout();
  if (options.demo) adopt(new DemoSource());
  else void openCamera();
  describe();

  if (options.manual) {
    // Scripted mode for screenshots: fixed steps, nothing tied to real time.
    const hooks = {
      advance(seconds: number, fps = 60): number {
        const steps = Math.max(1, Math.round(seconds * fps));
        for (let k = 0; k < steps; k++) advance(1 / fps);
        draw();
        gl.finish();
        return time;
      },
      key(name: string): void {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: name }));
        draw();
      },
      get time(): number {
        return time;
      },
      get source(): string {
        return source?.kind ?? 'none';
      },
      get stage(): string {
        return `${size.w}x${size.h}`;
      },
    };
    (window as unknown as { __dust: typeof hooks }).__dust = hooks;
    draw();
    return;
  }

  overlay.say('Press H for keys', 3);
  let last = performance.now();
  const loop = (now: number): void => {
    const dt = Math.min(Math.max((now - last) / 1000, 1 / 240), 1 / 30);
    last = now;
    advance(dt);
    draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

start();
