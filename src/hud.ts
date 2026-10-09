import type { Outline } from './outline';
import { BONES, J, JOINT_SIDE, LANDMARK_ID, type Point, type Source } from './sources/source';
import type { Telemetry } from './telemetry';

// The tracking overlay: a computer-vision debug view, done with some care.
// Three signal colours used the same way everywhere (red for the left side
// of the picture, blue for the right, green for the centre line and for
// anything measured), white type, one line weight, one typeface.

/** full: the RGB debug view. plain: the same in white and one accent. */
export type HudMode = 'full' | 'plain' | 'skeleton' | 'off';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HudFrame {
  mode: HudMode;
  /** Where the live picture sits, if it is shown, and whether it is the large split panel. */
  picture: Rect | null;
  pictureIsPanel: boolean;
  /** Where the dust figure sits. */
  figure: Rect;
  /** Body speed, in output pixels per second, that fills the motion meter. */
  fullScale: number;
  /** Positions of the two tear thresholds along the meter, 0..1. */
  marks: [number, number];
  sourceLabel: string;
  /** What the timing figure measures: a model's inference, or drawing the demo mask. */
  timingLabel: string;
  /** Detection score for the person, 0..1. */
  confidence: number;
  /** The palette's accent, used by the plain scheme. */
  accent: string;
  /** Dust dial reading for the strip, e.g. "1/5". */
  dust: string;
  /** Everything is drawn this much larger, for output that will be shown small. */
  scale: number;
}

const LINE = 3;
const RED = '#ff4b5c';
const GREEN = '#3dffa6';
const BLUE = '#4aa3ff';
const WHITE = '#ffffff';
const SOFT = 'rgba(255, 255, 255, 0.7)';
const FAINT = 'rgba(255, 255, 255, 0.07)';
const MONO = '"SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';
const LABEL = `500 21px ${MONO}`;
const VALUE = `500 34px ${MONO}`;
const VALUE_SMALL = `500 27px ${MONO}`;
const NOTE = `500 18px ${MONO}`;
/** The strip: the summed width of its five readings, its side margin and the height of a row. */
const STRIP_WIDTH = 915;
const STRIP_MARGIN = 58;
const STRIP_ROW = 128;


/** 291004 -> "291 004". */
function grouped(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const shrink = (r: Rect, k: number): Rect => ({ x: r.x / k, y: r.y / k, w: r.w / k, h: r.h / k });

export class Hud {
  private readonly taken: Rect[] = [];
  /** Colours for the left side, the right side, and the centre and measurements. */
  private left = RED;
  private right = BLUE;
  private centre = GREEN;
  private split = true;
  private scale = 1;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  private sideColor(side: number): string {
    return side < 0 ? this.left : side > 0 ? this.right : this.centre;
  }

  draw(given: HudFrame, telemetry: Telemetry, outline: Outline): void {
    if (given.mode === 'off') return;
    const ctx = this.ctx;
    // Work in coordinates divided by the scale, so one factor enlarges
    // type, lines and spacing alike.
    const k = given.scale;
    const frame: HudFrame = {
      ...given,
      picture: given.picture ? shrink(given.picture, k) : null,
      figure: shrink(given.figure, k),
    };
    const plain = frame.mode === 'plain';
    this.left = plain ? WHITE : RED;
    this.right = plain ? WHITE : BLUE;
    this.centre = plain ? frame.accent : GREEN;
    this.split = !plain;
    this.scale = k;
    ctx.save();
    ctx.scale(k, k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';
    this.taken.length = 0;
    // Labels on the figure must keep clear of a picture laid over it.
    if (frame.picture && !frame.pictureIsPanel) this.taken.push(frame.picture);

    const full = frame.mode === 'full' || frame.mode === 'plain';
    if (full && frame.picture && frame.pictureIsPanel) {
      // The header's place is spoken for before anything else is laid out.
      this.taken.push({ x: frame.picture.x + 40, y: frame.picture.y + 44, w: frame.picture.w - 80, h: 76 });
      // So is the strip's.
      const top = this.stripTop(frame.picture);
      this.taken.push({ x: frame.picture.x, y: top - 10, w: frame.picture.w, h: frame.picture.y + frame.picture.h - top + 10 });
    }
    if (frame.picture) {
      const panel = frame.pictureIsPanel;
      ctx.save();
      roundedClip(ctx, frame.picture, panel ? 0 : 40);
      if (panel && full) this.grid(frame.picture);
      this.tracking(frame, frame.picture, telemetry, outline, panel && full);
      ctx.restore();
    }

    if (full) {
      if (frame.picture && frame.pictureIsPanel) {
        this.strip(frame, frame.picture, telemetry);
        this.frameTicks(frame.picture);
        this.header(frame, frame.picture, telemetry);
      } else {
        this.column(frame, telemetry);
      }
      this.callouts(frame, telemetry);
    }
    ctx.restore();
  }

  // ---- the picture: grid, box, outline, skeleton, vectors, angles ----

  /** A faint measuring grid with tick rulers along the top and left edges. */
  private grid(box: Rect): void {
    const ctx = this.ctx;
    const cell = box.w / 8;
    ctx.lineWidth = 1;
    ctx.strokeStyle = FAINT;
    ctx.beginPath();
    for (let x = box.x + cell; x < box.x + box.w - 1; x += cell) {
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + box.h);
    }
    for (let y = box.y + cell; y < box.y + box.h - 1; y += cell) {
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.w, y);
    }
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    const step = cell / 5;
    for (let k = 1; box.x + k * step < box.x + box.w - 1; k++) {
      const x = box.x + k * step;
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + (k % 5 === 0 ? 18 : 9));
    }
    for (let k = 1; box.y + k * step < box.y + box.h - 1; k++) {
      const y = box.y + k * step;
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + (k % 5 === 0 ? 18 : 9), y);
    }
    ctx.stroke();
  }

  private tracking(frame: HudFrame, box: Rect, telemetry: Telemetry, outline: Outline, measured: boolean): void {
    const ctx = this.ctx;
    const at = (p: Point): Point => [box.x + p[0] * box.w, box.y + p[1] * box.h];
    const panel = frame.pictureIsPanel;
    let found: Rect | null = null;

    if (outline.count > 0) {
      // Segmentation outline, drawn once per colour channel. At rest the
      // three coincide and read as one white line; when the body moves fast
      // they pull apart along the direction of travel.
      const s = outline.segments;
      const path = new Path2D();
      for (let k = 0; k < outline.count * 4; k += 4) {
        path.moveTo(box.x + s[k] * box.w, box.y + s[k + 1] * box.h);
        path.lineTo(box.x + s[k + 2] * box.w, box.y + s[k + 3] * box.h);
      }
      ctx.lineWidth = LINE + 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.stroke(path);
      const split = Math.min(13, telemetry.peak * 0.0065) * (panel ? 1 : 0.4);
      const dx = telemetry.peakDirection[0] * split;
      const dy = telemetry.peakDirection[1] * split;
      ctx.lineWidth = LINE;
      if (this.split) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const [channel, k] of [
          ['#ff0000', -1],
          ['#00ff00', 0],
          ['#0000ff', 1],
        ] as const) {
          ctx.save();
          ctx.translate(dx * k, dy * k);
          ctx.strokeStyle = channel;
          ctx.stroke(path);
          ctx.restore();
        }
        ctx.restore();
      } else {
        ctx.strokeStyle = this.centre;
        ctx.stroke(path);
      }

      // Bounding box as corner brackets, with what it found and how sure it is.
      const b = outline.box;
      const bx0 = Math.max(box.x + 6, box.x + b[0] * box.w - 14);
      const by0 = Math.max(box.y + 6, box.y + b[1] * box.h - 14);
      const bx1 = Math.min(box.x + box.w - 6, box.x + b[2] * box.w + 14);
      const by1 = Math.min(box.y + box.h - 6, box.y + b[3] * box.h + 14);
      const arm = panel ? 38 : 20;
      ctx.beginPath();
      for (const [x, y, sx, sy] of [
        [bx0, by0, 1, 1],
        [bx1, by0, -1, 1],
        [bx0, by1, 1, -1],
        [bx1, by1, -1, -1],
      ]) {
        ctx.moveTo(x + sx * arm, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + sy * arm);
      }
      this.stroke(this.centre);
      found = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
    }

    const pose = telemetry.pose;
    if (!pose) {
      if (measured && found) this.tag(frame, box, found);
      return;
    }
    const sl = pose[J.shoulderL];
    const sr = pose[J.shoulderR];
    const head = pose[J.head];

    // Skeleton, one colour per side and green down the middle.
    for (const side of [-1, 1, 0]) {
      ctx.beginPath();
      for (const [a, b] of BONES) {
        const pa = pose[a];
        const pb = pose[b];
        if (!pa || !pb) continue;
        const boneSide = JOINT_SIDE[a] === JOINT_SIDE[b] ? JOINT_SIDE[a] : 0;
        if (boneSide !== side) continue;
        const [ax, ay] = at(pa);
        const [bx, by] = at(pb);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      if (side === 0 && sl && sr && head) {
        const [nx, ny] = at([(sl[0] + sr[0]) / 2, (sl[1] + sr[1]) / 2]);
        const [hx, hy] = at(head);
        ctx.moveTo(nx, ny);
        ctx.lineTo(hx, hy);
      }
      this.stroke(this.sideColor(side));
    }

    if (measured) {
      // Elbow angles, drawn as an arc between the two bones.
      this.angle(pose[J.shoulderL], pose[J.elbowL], pose[J.wristL], at);
      this.angle(pose[J.shoulderR], pose[J.elbowR], pose[J.wristR], at);

      // Velocity vectors: where each joint will be a tenth of a second from now.
      for (const joint of [J.elbowL, J.elbowR, J.wristL, J.wristR]) {
        const p = pose[joint];
        if (!p) continue;
        const [x, y] = at(p);
        const v = telemetry.jointVelocity[joint];
        this.arrow(this.centre, x, y, (v[0] * 0.1) / this.scale, (v[1] * 0.1) / this.scale);
      }
    }

    // Joints: a solid dot in the side's colour with a white core.
    const radius = panel ? 8 : 5;
    for (let j = 0; j < pose.length; j++) {
      const p = pose[j];
      if (!p) continue;
      const [x, y] = at(p);
      ctx.beginPath();
      ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = this.sideColor(JOINT_SIDE[j]);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = WHITE;
      ctx.fill();
    }

    // Crosshairs on the wrists.
    for (const joint of [J.wristL, J.wristR]) {
      const p = pose[joint];
      if (!p) continue;
      const [x, y] = at(p);
      const r = panel ? 19 : 11;
      const reach = panel ? 34 : 18;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      for (const [ux, uy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        ctx.moveTo(x + ux * (r + 5), y + uy * (r + 5));
        ctx.lineTo(x + ux * reach, y + uy * reach);
      }
      this.stroke(this.sideColor(JOINT_SIDE[joint]));
    }

    if (!measured) return;

    // Speed and position beside each wrist; landmark numbers beside the rest.
    const centre = sl && sr ? (sl[0] + sr[0]) / 2 : 0.5;
    for (const joint of [J.wristL, J.wristR]) {
      const p = pose[joint];
      if (!p) continue;
      const [x, y] = at(p);
      // Set the label off to the side of the forearm, on whichever side is
      // higher, so it does not sit on the limb it describes.
      const elbow = pose[joint === J.wristL ? J.elbowL : J.elbowR];
      let nx = 0;
      let ny = -1;
      if (elbow) {
        const [ex, ey] = at(elbow);
        const length = Math.hypot(x - ex, y - ey) || 1;
        nx = -(y - ey) / length;
        ny = (x - ex) / length;
        if (ny > 0 || (Math.abs(ny) < 0.2 && nx * (p[0] < centre ? -1 : 1) < 0)) {
          nx = -nx;
          ny = -ny;
        }
      }
      // Take the first of: that side, the other side, below, above, which is
      // clear of the header, the angles and the other labels.
      const speed = `${grouped(telemetry.shown.jointSpeed[joint])} px/s`;
      const where = `${LANDMARK_ID[joint]}  x${p[0].toFixed(3).slice(1)} y${p[1].toFixed(3).slice(1)}`;
      const width = 200;
      const place = (dx: number, dy: number): { ax: number; ay: number; block: Rect } => {
        // Further out sideways than up or down, since the text is wider than tall.
        const ax = Math.min(Math.max(x + dx * (58 + 86 * Math.abs(dx)), box.x + 24 + width / 2), box.x + box.w - 24 - width / 2);
        const ay = Math.max(y + dy * 64, box.y + 60);
        return { ax, ay, block: { x: ax - width / 2, y: ay - 30, w: width, h: 58 } };
      };
      const options = [place(nx, ny), place(-nx, -ny), place(0, 1.1), place(0, -1.1)];
      const chosen = options.find((o) => !this.blocked(o.block)) ?? options[0];
      this.taken.push(chosen.block);
      this.text(speed, chosen.ax, chosen.ay - 4, VALUE_SMALL, WHITE, 'center');
      this.text(where, chosen.ax, chosen.ay + 22, NOTE, SOFT, 'center');
    }
    if (found) this.tag(frame, box, found);
    for (const joint of [J.shoulderL, J.shoulderR, J.elbowL, J.elbowR, J.hipL, J.hipR]) {
      const p = pose[joint];
      if (!p) continue;
      const [x, y] = at(p);
      const outward = p[0] < centre ? -1 : 1;
      const tx = x + outward * 18;
      const block: Rect = { x: outward < 0 ? tx - 28 : tx, y: y - 30, w: 28, h: 22 };
      if (this.blocked(block)) continue;
      this.text(String(LANDMARK_ID[joint]), tx, y - 12, NOTE, SOFT, outward < 0 ? 'right' : 'left');
    }
  }

  /** What the bounding box holds and how sure the tracker is, on whichever corner is free. */
  private tag(frame: HudFrame, box: Rect, found: Rect): void {
    const ctx = this.ctx;
    const label = `PERSON ${frame.confidence.toFixed(2)}`;
    const width = label.length * 14.7 + 20;
    const clampX = (x: number): number => Math.min(Math.max(x, box.x + 44), box.x + box.w - width - 44);
    const clampY = (y: number): number => Math.min(Math.max(y, box.y + 150), box.y + box.h - 30);
    const spots: Point[] = [
      [clampX(found.x), clampY(found.y - 12)],
      [clampX(found.x + found.w - width), clampY(found.y - 12)],
      [clampX(found.x), clampY(found.y + found.h * 0.5)],
      [clampX(found.x + found.w - width), clampY(found.y + found.h * 0.5)],
    ];
    const spot = spots.find(([x, y]) => !this.blocked({ x, y: y - 26, w: width, h: 34 })) ?? spots[0];
    const [tx, ty] = spot;
    ctx.fillStyle = 'rgba(8, 20, 16, 0.78)';
    ctx.fillRect(tx, ty - 26, width, 34);
    ctx.fillStyle = this.centre;
    ctx.fillRect(tx, ty - 26, 4, 34);
    this.text(label, tx + 14, ty, LABEL, WHITE, 'left');
    this.taken.push({ x: tx, y: ty - 26, w: width, h: 34 });
  }

  private angle(
    a: Point | null | undefined,
    pivot: Point | null | undefined,
    b: Point | null | undefined,
    at: (p: Point) => Point,
  ): void {
    if (!a || !pivot || !b) return;
    const ctx = this.ctx;
    const [px, py] = at(pivot);
    const [ax, ay] = at(a);
    const [bx, by] = at(b);
    const start = Math.atan2(ay - py, ax - px);
    const end = Math.atan2(by - py, bx - px);
    let sweep = end - start;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    const reach = Math.min(Math.hypot(ax - px, ay - py), Math.hypot(bx - px, by - py));
    if (reach < 46) return;
    ctx.beginPath();
    ctx.arc(px, py, 38, start, start + sweep, sweep < 0);
    this.stroke(this.centre);
    // The number sits just beyond the arc, in the opening between the two bones.
    const mid = start + sweep / 2;
    const degrees = Math.round((Math.abs(sweep) * 180) / Math.PI);
    const tx = px + Math.cos(mid) * 80;
    const ty = py + Math.sin(mid) * 80 + 9;
    this.taken.push({ x: tx - 34, y: ty - 26, w: 68, h: 34 });
    this.text(`${degrees}°`, tx, ty, VALUE_SMALL, WHITE, 'center');
  }

  private arrow(color: string, x: number, y: number, dx: number, dy: number): void {
    const length = Math.hypot(dx, dy);
    if (length < 12) return;
    const ctx = this.ctx;
    const scale = Math.min(1, 170 / length);
    const ex = x + dx * scale;
    const ey = y + dy * scale;
    const ux = dx / length;
    const uy = dy / length;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.moveTo(ex - ux * 15 - uy * 8, ey - uy * 15 + ux * 8);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex - ux * 15 + uy * 8, ey - uy * 15 - ux * 8);
    this.stroke(color);
  }

  // ---- furniture around the split panel ----

  private frameTicks(box: Rect): void {
    const ctx = this.ctx;
    const inset = 30;
    const arm = 34;
    const x0 = box.x + inset;
    const y0 = box.y + inset;
    const x1 = box.x + box.w - inset;
    const y1 = box.y + box.h - inset;
    ctx.beginPath();
    for (const [x, y, sx, sy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ]) {
      ctx.moveTo(x + sx * arm, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * arm);
    }
    this.stroke(WHITE, false);
  }

  private header(frame: HudFrame, box: Rect, telemetry: Telemetry): void {
    const left = box.x + 58;
    const right = box.x + box.w - 58;
    const top = box.y + 78;
    this.text('TRACKING  POSE + MASK', left, top, LABEL, SOFT, 'left');
    this.text(frame.sourceLabel, left, top + 34, LABEL, WHITE, 'left');
    this.text(`${frame.timingLabel} ${telemetry.shown.inferenceMs.toFixed(1)} ms`, right, top, LABEL, SOFT, 'right');
    this.text(`${Math.round(telemetry.shown.fps)} fps`, right, top + 34, LABEL, WHITE, 'right');
  }

  /**
   * The instrument strip along the foot of the picture. Five readings on one
   * row where they fit, otherwise wrapped onto two.
   */
  private strip(frame: HudFrame, box: Rect, telemetry: Telemetry): void {
    const ctx = this.ctx;
    const s = telemetry.shown;
    const total = Math.max(1, s.flying + s.settled);
    const cells: Array<{ width: number; draw: (x: number, y: number, width: number) => void }> = [
      {
        width: 290,
        draw: (x, y, width) => {
          this.reading('MOTION', `${grouped(s.peak)}`, 'px/s', x, y + 36, y + 82);
          this.meter(frame, x, y + 108, width - 34, telemetry.peak / frame.fullScale);
        },
      },
      {
        width: 152,
        draw: (x, y) =>
          this.reading('SHEDDING', `${Math.round(s.shed * 100)}`, '%', x, y + 36, y + 82, s.shed > 0.02 ? this.centre : WHITE),
      },
      { width: 108, draw: (x, y) => this.reading('DUST', frame.dust, '', x, y + 36, y + 82) },
      {
        width: 205,
        draw: (x, y) =>
          this.reading('IN FLIGHT', grouped(s.flying), `${Math.round((s.flying / total) * 100)}%`, x, y + 36, y + 82),
      },
      { width: 160, draw: (x, y) => this.reading('SETTLED', grouped(s.settled), '', x, y + 36, y + 82) },
    ];

    const margin = STRIP_MARGIN;
    const room = box.w - margin * 2;
    const rows = this.stripRows(box) === 1 ? [cells] : [cells.slice(0, 3), cells.slice(3)];
    const rowHeight = STRIP_ROW;
    const top = this.stripTop(box);

    const shade = ctx.createLinearGradient(0, top - 70, 0, box.y + box.h);
    shade.addColorStop(0, 'rgba(6, 5, 4, 0)');
    shade.addColorStop(0.35, 'rgba(6, 5, 4, 0.82)');
    shade.addColorStop(1, 'rgba(6, 5, 4, 0.95)');
    ctx.fillStyle = shade;
    ctx.fillRect(box.x, top - 70, box.w, box.y + box.h - (top - 70));
    rows.forEach((row, index) => {
      const wanted = row.reduce((sum, cell) => sum + cell.width, 0);
      const stretch = Math.min(1.2, room / wanted);
      let x = box.x + margin;
      for (const cell of row) {
        const width = cell.width * stretch;
        cell.draw(x, top + index * rowHeight, width);
        x += width;
      }
    });
  }

  /** One row of readings where the picture is wide enough, otherwise two. */
  private stripRows(box: Rect): number {
    return STRIP_WIDTH * 0.9 <= box.w - STRIP_MARGIN * 2 ? 1 : 2;
  }

  private stripTop(box: Rect): number {
    return box.y + box.h - 40 - this.stripRows(box) * STRIP_ROW;
  }

  /** The same readings stacked in a corner, for layouts without the big picture. */
  private column(frame: HudFrame, telemetry: Telemetry): void {
    const s = telemetry.shown;
    // Keep clear of the small picture if it sits in the top-left corner.
    const pictureOnLeft = frame.picture !== null && frame.picture.x < 300 && frame.picture.y < 400;
    const x = pictureOnLeft ? frame.figure.x + frame.figure.w - 52 - 330 : frame.figure.x + 52;
    let y = frame.figure.y + 132;
    const row = 104;
    this.reading('MOTION', `${grouped(s.peak)}`, 'px/s', x, y, y + 46);
    this.meter(frame, x, y + 70, 330, telemetry.peak / frame.fullScale);
    y += row + 30;
    this.reading('SHEDDING', `${Math.round(s.shed * 100)}`, '%', x, y, y + 46, s.shed > 0.02 ? this.centre : WHITE);
    y += row;
    const total = Math.max(1, s.flying + s.settled);
    this.reading('IN FLIGHT', grouped(s.flying), `${Math.round((s.flying / total) * 100)}%`, x, y, y + 46);
    y += row;
    this.reading('SETTLED', grouped(s.settled), '', x, y, y + 46);
    y += row;
    this.text(`DUST ${frame.dust}   PERSON ${frame.confidence.toFixed(2)}`, x, y, LABEL, SOFT, 'left');
    y += 34;
    this.text(`${frame.timingLabel} ${s.inferenceMs.toFixed(1)} ms   ${Math.round(s.fps)} fps`, x, y, LABEL, SOFT, 'left');
    this.taken.push({ x: x - 10, y: frame.figure.y + 90, w: 350, h: y - frame.figure.y - 70 });
  }

  private reading(label: string, value: string, unit: string, x: number, labelY: number, valueY: number, color = WHITE): void {
    const ctx = this.ctx;
    this.text(label, x, labelY, LABEL, SOFT, 'left');
    this.text(value, x, valueY, VALUE, color, 'left');
    if (unit) {
      ctx.font = VALUE;
      const width = ctx.measureText(value).width;
      this.text(unit, x + width + 12, valueY, LABEL, SOFT, 'left');
    }
  }

  /** A bar that fills with body speed, with a tick at each tear threshold. */
  private meter(frame: HudFrame, x: number, y: number, width: number, level: number): void {
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.lineWidth = LINE * 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
    const fill = Math.min(1, Math.max(0, level));
    if (fill > 0.003) {
      ctx.strokeStyle = this.centre;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + width * fill, y);
      ctx.stroke();
    }
    ctx.lineWidth = LINE;
    ctx.strokeStyle = WHITE;
    ctx.beginPath();
    for (const mark of frame.marks) {
      const mx = x + width * Math.min(1, mark);
      ctx.moveTo(mx, y - 11);
      ctx.lineTo(mx, y + 11);
    }
    ctx.stroke();
    ctx.lineCap = 'round';
  }

  // ---- callouts on the dust figure ----

  private callouts(frame: HudFrame, telemetry: Telemetry): void {
    const pose = telemetry.pose;
    if (!pose) return;
    const ctx = this.ctx;
    const box = frame.figure;
    const sl = pose[J.shoulderL];
    const sr = pose[J.shoulderR];
    const head = pose[J.head];
    const centre = sl && sr ? (sl[0] + sr[0]) / 2 : 0.5;
    const s = telemetry.shown;

    // Wrist labels should not sit on the torso, so note roughly where it is.
    let torso: Rect | null = null;
    if (sl && sr) {
      const left = box.x + (Math.min(sl[0], sr[0]) - 0.03) * box.w;
      const right = box.x + (Math.max(sl[0], sr[0]) + 0.03) * box.w;
      const top = box.y + ((head ? head[1] : Math.min(sl[1], sr[1])) - 0.08) * box.h;
      torso = { x: left, y: top, w: right - left, h: box.y + box.h - top };
    }

    const ring = 15;
    const reach = (ring + 44) * 0.7071;
    const run = 50;
    const items: Array<{ joint: number; name: string }> = [
      { joint: J.head, name: 'HEAD' },
      { joint: J.wristL, name: 'WRIST' },
      { joint: J.wristR, name: 'WRIST' },
    ];
    for (const item of items) {
      const p = pose[item.joint];
      if (!p) continue;
      const x = box.x + p[0] * box.w;
      const y = box.y + p[1] * box.h;
      const color = this.sideColor(JOINT_SIDE[item.joint]);
      const shed = s.jointShed[item.joint];
      const title = `${item.name} ${LANDMARK_ID[item.joint]}  ${shed > 0.02 ? `SHED ${Math.round(shed * 100)}%` : 'HOLD'}`;
      const value = `${grouped(s.jointSpeed[item.joint])} px/s`;
      ctx.font = VALUE;
      const width = Math.max(ctx.measureText(value).width, title.length * 14.7) + 8;

      ctx.beginPath();
      ctx.arc(x, y, ring, 0, Math.PI * 2);
      this.stroke(color);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = WHITE;
      ctx.fill();

      // Try the four diagonals, outward and upward first, then straight up
      // and straight down, and take the first that stays on the stage and
      // clear of everything else. If none does, the ring alone marks the joint.
      const outward = item.joint === J.head ? 1 : p[0] < centre ? -1 : 1;
      const stageLeft = box.x + 24;
      const stageRight = box.x + box.w - 24;
      const acceptable = (block: Rect): boolean => {
        const onStage =
          block.x >= stageLeft && block.x + block.w <= stageRight && block.y > box.y + 16 && block.y + block.h < box.y + box.h - 16;
        if (!onStage || this.blocked(block)) return false;
        return item.joint === J.head || !torso || !overlaps(block, torso);
      };

      let placed = false;
      for (const [side, up] of [
        [outward, -1],
        [outward, 1],
        [-outward, -1],
        [-outward, 1],
      ]) {
        const kx = x + side * reach;
        const ky = y + up * reach;
        const textX = kx + side * (run + 14);
        const block: Rect = { x: side > 0 ? textX : textX - width, y: ky - 36, w: width, h: 76 };
        if (!acceptable(block)) continue;
        this.taken.push(block);
        ctx.beginPath();
        ctx.moveTo(x + side * ring * 0.7071, y + up * ring * 0.7071);
        ctx.lineTo(kx, ky);
        ctx.lineTo(kx + side * run, ky);
        this.stroke(color);
        const align = side > 0 ? 'left' : 'right';
        this.text(title, textX, ky - 8, LABEL, SOFT, align);
        this.text(value, textX, ky + 30, VALUE, WHITE, align);
        placed = true;
        break;
      }
      if (placed) continue;

      for (const up of [-1, 1]) {
        const stem = 46;
        const left = Math.min(Math.max(x - width / 2, stageLeft), stageRight - width);
        const top = up < 0 ? y - ring - stem - 12 - 76 : y + ring + stem + 12;
        const block: Rect = { x: left, y: top, w: width, h: 76 };
        if (!acceptable(block)) continue;
        this.taken.push(block);
        ctx.beginPath();
        ctx.moveTo(x, y + up * ring);
        ctx.lineTo(x, y + up * (ring + stem));
        this.stroke(color);
        this.text(title, left, top + 26, LABEL, SOFT, 'left');
        this.text(value, left, top + 64, VALUE, WHITE, 'left');
        break;
      }
    }
  }

  private blocked(block: Rect): boolean {
    return this.taken.some((t) => overlaps(block, { x: t.x - 10, y: t.y - 10, w: t.w + 20, h: t.h + 20 }));
  }

  // ---- primitives ----

  /**
   * Strokes the current path: a dark under-stroke so the line holds on any
   * picture, then the colour itself with a soft glow of the same colour.
   */
  private stroke(color: string, glow = true): void {
    const ctx = this.ctx;
    ctx.lineWidth = LINE + 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.stroke();
    ctx.lineWidth = LINE;
    ctx.strokeStyle = color;
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private text(content: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign, keepIn?: Rect): void {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.textAlign = align;
    if ('letterSpacing' in ctx) ctx.letterSpacing = font === LABEL ? '2px' : font === NOTE ? '1px' : '0px';
    if (keepIn) {
      const width = ctx.measureText(content).width;
      const left = align === 'left' ? x : align === 'right' ? x - width : x - width / 2;
      if (left < keepIn.x + 24) x += keepIn.x + 24 - left;
      if (left + width > keepIn.x + keepIn.w - 24) x -= left + width - (keepIn.x + keepIn.w - 24);
      y = Math.max(keepIn.y + 40, y);
    }
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeText(content, x, y);
    ctx.fillStyle = color;
    ctx.fillText(content, x, y);
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function roundedClip(ctx: CanvasRenderingContext2D, box: Rect, radius: number): void {
  ctx.beginPath();
  if (radius > 0) ctx.roundRect(box.x, box.y, box.w, box.h, radius);
  else ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
}

/** Draws the live picture itself: the mirrored camera, or the demo figure as a dim shape. */
export function drawPicture(ctx: CanvasRenderingContext2D, source: Source | null, box: Rect, radius: number): void {
  ctx.save();
  roundedClip(ctx, box, radius);
  ctx.fillStyle = '#0b0a09';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  const picture = source?.preview;
  if (picture instanceof HTMLVideoElement) {
    const vw = picture.videoWidth;
    const vh = picture.videoHeight;
    if (vw > 0 && picture.readyState >= 2) {
      const aspect = box.w / box.h;
      const takeW = Math.min(vw, vh * aspect);
      const takeH = takeW / aspect;
      ctx.translate(box.x + box.w, box.y);
      ctx.scale(-1, 1);
      ctx.drawImage(picture, (vw - takeW) / 2, (vh - takeH) / 2, takeW, takeH, 0, 0, box.w, box.h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Take the picture down a touch so the overlay reads in bright rooms.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
  } else if (picture && picture.width > 0) {
    ctx.globalAlpha = 0.2;
    ctx.drawImage(picture, box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (radius > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, radius);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.stroke();
    ctx.restore();
  }
}
