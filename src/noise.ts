import { createTexture, type GL } from './gl';

/** Small deterministic generator so the dust looks the same on every load. */
function sequence(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

interface Wave {
  kx: number;
  ky: number;
  amplitude: number;
  phase: number;
}

function waves(next: () => number, count: number, reach: number, falloff: number): Wave[] {
  const out: Wave[] = [];
  while (out.length < count) {
    const kx = Math.round((next() * 2 - 1) * reach);
    const ky = Math.round((next() * 2 - 1) * reach);
    const k = Math.hypot(kx, ky);
    if (k < 0.5 || k > reach + 0.5) continue;
    out.push({ kx, ky, amplitude: 1 / Math.pow(k, falloff), phase: next() * Math.PI * 2 });
  }
  return out;
}

/**
 * A seamlessly tiling texture built from a handful of plane waves.
 *   rg: curl of a potential, so the vector field never bunches particles up
 *   b, a: two unrelated smooth scalar fields
 */
export function createFlowTexture(gl: GL, size = 256, seed = 20240611): WebGLTexture {
  const next = sequence(seed);
  const potential = waves(next, 30, 6, 1.25);
  const scalarA = waves(next, 22, 5, 1.0);
  const scalarB = waves(next, 22, 7, 0.8);
  const data = new Float32Array(size * size * 4);
  const tau = Math.PI * 2;

  let curlPower = 0;
  let peakA = 0;
  let peakB = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let cx = 0;
      let cy = 0;
      for (const w of potential) {
        const s = Math.sin(tau * (w.kx * u + w.ky * v) + w.phase) * w.amplitude * tau;
        cx -= w.ky * s;
        cy += w.kx * s;
      }
      let a = 0;
      for (const w of scalarA) a += Math.cos(tau * (w.kx * u + w.ky * v) + w.phase) * w.amplitude;
      let b = 0;
      for (const w of scalarB) b += Math.cos(tau * (w.kx * u + w.ky * v) + w.phase) * w.amplitude;
      const at = (y * size + x) * 4;
      data[at] = cx;
      data[at + 1] = cy;
      data[at + 2] = a;
      data[at + 3] = b;
      curlPower += cx * cx + cy * cy;
      peakA = Math.max(peakA, Math.abs(a));
      peakB = Math.max(peakB, Math.abs(b));
    }
  }
  const curlScale = 1 / Math.sqrt(curlPower / (size * size));
  for (let at = 0; at < data.length; at += 4) {
    data[at] *= curlScale;
    data[at + 1] *= curlScale;
    data[at + 2] /= peakA;
    data[at + 3] /= peakB;
  }

  return createTexture(
    gl,
    size,
    size,
    { internal: gl.RGBA16F, format: gl.RGBA, type: gl.FLOAT, filter: gl.LINEAR, wrap: gl.REPEAT },
    data,
  );
}
