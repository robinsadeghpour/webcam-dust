import type { GL, Target } from './gl';

/**
 * Copies a small float render target to the CPU. Call it at the start of a
 * frame, before queuing new GPU work: the GPU has then already finished the
 * previous frame, so the read returns almost at once.
 */
export function readFloats(gl: GL, target: Target, into: Float32Array): Float32Array {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, into);
  return into;
}
