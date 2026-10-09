// Traces the edge of a coverage mask as short line segments (marching
// squares), so the overlay can draw the segmentation outline as a crisp
// vector line at any size.

/** For each of the 16 corner patterns, the pairs of cell edges the outline joins. */
const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;
const JOINS: number[][] = [
  [],
  [LEFT, TOP],
  [TOP, RIGHT],
  [LEFT, RIGHT],
  [RIGHT, BOTTOM],
  [LEFT, TOP, RIGHT, BOTTOM],
  [TOP, BOTTOM],
  [LEFT, BOTTOM],
  [BOTTOM, LEFT],
  [TOP, BOTTOM],
  [TOP, RIGHT, BOTTOM, LEFT],
  [RIGHT, BOTTOM],
  [LEFT, RIGHT],
  [TOP, RIGHT],
  [LEFT, TOP],
  [],
];

export class Outline {
  /** x1, y1, x2, y2 per segment, each 0..1 across the mask. */
  segments = new Float32Array(4096);
  count = 0;
  /** Share of the mask that is body, 0..1. */
  coverage = 0;
  /** Length of the outline, in picture heights. */
  perimeter = 0;
  /** Box around the outline: left, top, right, bottom, each 0..1. */
  readonly box = [0, 0, 0, 0];

  trace(pixels: Uint8Array, width: number, height: number, level = 128): void {
    const step = Math.max(1, Math.round(height / 160));
    const cols = Math.floor((width - 1) / step);
    const rows = Math.floor((height - 1) / step);
    let n = 0;
    let inside = 0;
    let length = 0;
    const shape = width / height;
    let left = 1;
    let top = 1;
    let right = 0;
    let bottom = 0;
    const point = [0, 0];

    // Where the mask crosses `level` along one edge of the cell at (x, y).
    const cross = (edge: number, x: number, y: number, a: number, b: number, c: number, d: number): void => {
      let fx = 0;
      let fy = 0;
      if (edge === TOP) fx = (level - a) / (b - a);
      else if (edge === RIGHT) {
        fx = 1;
        fy = (level - b) / (c - b);
      } else if (edge === BOTTOM) {
        fx = (level - d) / (c - d);
        fy = 1;
      } else fy = (level - a) / (d - a);
      point[0] = (x + fx * step + 0.5) / width;
      point[1] = (y + fy * step + 0.5) / height;
    };

    for (let row = 0; row < rows; row++) {
      const y = row * step;
      for (let col = 0; col < cols; col++) {
        const x = col * step;
        const a = pixels[y * width + x];
        const b = pixels[y * width + x + step];
        const c = pixels[(y + step) * width + x + step];
        const d = pixels[(y + step) * width + x];
        if (a >= level) inside++;
        const pattern = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
        const joins = JOINS[pattern];
        for (let k = 0; k < joins.length; k += 2) {
          if (n + 4 > this.segments.length) {
            const bigger = new Float32Array(this.segments.length * 2);
            bigger.set(this.segments);
            this.segments = bigger;
          }
          cross(joins[k], x, y, a, b, c, d);
          this.segments[n] = point[0];
          this.segments[n + 1] = point[1];
          cross(joins[k + 1], x, y, a, b, c, d);
          this.segments[n + 2] = point[0];
          this.segments[n + 3] = point[1];
          length += Math.hypot((point[0] - this.segments[n]) * shape, point[1] - this.segments[n + 1]);
          n += 4;
          if (point[0] < left) left = point[0];
          if (point[0] > right) right = point[0];
          if (point[1] < top) top = point[1];
          if (point[1] > bottom) bottom = point[1];
        }
      }
    }
    this.count = n / 4;
    this.coverage = cols * rows > 0 ? inside / (cols * rows) : 0;
    this.perimeter = length;
    this.box[0] = left;
    this.box[1] = top;
    this.box[2] = right;
    this.box[3] = bottom;
  }

  clear(): void {
    this.count = 0;
    this.coverage = 0;
    this.perimeter = 0;
  }
}
