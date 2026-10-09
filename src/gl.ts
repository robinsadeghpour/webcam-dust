// Thin WebGL2 helpers: programs with cached uniforms, render targets,
// ping-pong pairs and a full-screen pass.

export type GL = WebGL2RenderingContext;

export class Program {
  readonly handle: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: GL,
    vertexSource: string,
    fragmentSource: string,
    label = 'program',
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, label);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, label);
    const handle = gl.createProgram()!;
    gl.attachShader(handle, vs);
    gl.attachShader(handle, fs);
    gl.linkProgram(handle);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      throw new Error(`${label}: link failed\n${gl.getProgramInfoLog(handle) ?? ''}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.handle = handle;
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.locations.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, l);
    }
    return l;
  }

  f(name: string, x: number): this {
    this.gl.uniform1f(this.loc(name), x);
    return this;
  }

  i(name: string, x: number): this {
    this.gl.uniform1i(this.loc(name), x);
    return this;
  }

  u(name: string, x: number): this {
    this.gl.uniform1ui(this.loc(name), x);
    return this;
  }

  v2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.loc(name), x, y);
    return this;
  }

  v3(name: string, v: readonly number[]): this {
    this.gl.uniform3f(this.loc(name), v[0], v[1], v[2]);
    return this;
  }

  tex(name: string, unit: number, texture: WebGLTexture): this {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

function compile(gl: GL, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    const log = gl.getShaderInfoLog(shader) ?? '';
    const numbered = source
      .split('\n')
      .map((line, n) => `${String(n + 1).padStart(3)}  ${line}`)
      .join('\n');
    throw new Error(`${label}: ${kind} shader failed\n${log}\n${numbered}`);
  }
  return shader;
}

export interface TextureSpec {
  internal: number;
  format: number;
  type: number;
  filter: number;
  wrap?: number;
}

export function formats(gl: GL) {
  return {
    r8: { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR },
    r16f: { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT, filter: gl.LINEAR },
    rgba16f: { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR },
    rgba32fNearest: { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST },
  } satisfies Record<string, TextureSpec>;
}

export function createTexture(
  gl: GL,
  width: number,
  height: number,
  spec: TextureSpec,
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, spec.internal, width, height, 0, spec.format, spec.type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, spec.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, spec.filter);
  const wrap = spec.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return texture;
}

export class Target {
  readonly fbo: WebGLFramebuffer;
  readonly textures: WebGLTexture[];

  constructor(
    private readonly gl: GL,
    readonly width: number,
    readonly height: number,
    spec: TextureSpec,
    attachments = 1,
  ) {
    this.fbo = gl.createFramebuffer()!;
    this.textures = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const buffers: number[] = [];
    for (let n = 0; n < attachments; n++) {
      const texture = createTexture(gl, width, height, spec);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + n, gl.TEXTURE_2D, texture, 0);
      this.textures.push(texture);
      buffers.push(gl.COLOR_ATTACHMENT0 + n);
    }
    gl.drawBuffers(buffers);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`framebuffer incomplete (0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get tex(): WebGLTexture {
    return this.textures[0];
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.gl.deleteFramebuffer(this.fbo);
  }
}

/** Two targets that trade places, for passes that read their own last output. */
export class Pair {
  read: Target;
  write: Target;

  constructor(gl: GL, width: number, height: number, spec: TextureSpec, attachments = 1) {
    this.read = new Target(gl, width, height, spec, attachments);
    this.write = new Target(gl, width, height, spec, attachments);
  }

  swap(): void {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }

  dispose(): void {
    this.read.dispose();
    this.write.dispose();
  }
}

/** One oversized triangle that covers the viewport; vUv runs 0..1. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

export class Quad {
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: GL) {
    this.vao = gl.createVertexArray()!;
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export function pass(gl: GL, quad: Quad, target: Target | null, width = 0, height = 0): void {
  if (target) {
    target.bind();
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
  }
  quad.draw();
}
