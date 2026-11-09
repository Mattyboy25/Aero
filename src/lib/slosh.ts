// The loading effect over the preview: a black-and-white gradient that sloshes like
// liquid while Claude works, then dissolves away to reveal the finished video.

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uCover; // 1 = fully covered, 0 = fully revealed

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.0 + 17.0; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uTime * 0.12;

  // Domain warping: noise pushed around by more noise reads as slow, folding liquid.
  vec2 q = vec2(fbm(p * 1.6 + vec2(0.0, t)), fbm(p * 1.6 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p * 1.6 + 3.2 * q + vec2(1.7, 9.2) + t * 1.4),
                fbm(p * 1.6 + 3.2 * q + vec2(8.3, 2.8) - t * 1.1));
  float f = fbm(p * 1.6 + 3.0 * r);
  float g = smoothstep(0.18, 0.82, f);
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.6);            // a little extra contrast
  g *= 1.0 - 0.35 * dot(uv - 0.5, uv - 0.5) * 2.0;     // soft vignette
  g += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.025; // dither, avoids banding

  // Dissolve mask: opens from the center, with the liquid's own shapes breaking up the edge.
  float m = clamp(length(p) * 0.85 + (fbm(p * 2.4 + 2.0 * r + t) - 0.5) * 0.9 + 0.1, 0.0, 1.0);
  float e = 0.14;
  float th = (1.0 - uCover) * (1.0 + 2.0 * e) - e;
  float a = smoothstep(th - e, th + e, m);
  float rim = (1.0 - smoothstep(0.0, e, abs(m - th))) * step(0.001, uCover) * step(uCover, 0.999);

  vec3 col = vec3(clamp(g + rim * 0.6, 0.0, 1.0));
  gl_FragColor = vec4(col * a, a);
}`;

export interface Slosh {
  readonly active: boolean;
  cover(): void;
  reveal(done?: () => void): void;
  clear(): void;
  destroy(): void;
}

interface Tween { from: number; to: number; start: number; dur: number; done?: () => void }

export function createSlosh(canvas: HTMLCanvasElement): Slosh {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false });
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let raf = 0;
  let cover = 0;          // current coverage, 0..1
  let tween: Tween | null = null;
  const t0 = performance.now();
  let program: WebGLProgram | null = null;
  let uRes: WebGLUniformLocation | null = null;
  let uTime: WebGLUniformLocation | null = null;
  let uCover: WebGLUniformLocation | null = null;

  if (gl) {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      gl.useProgram(program);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(program, "uRes");
      uTime = gl.getUniformLocation(program, "uTime");
      uCover = gl.getUniformLocation(program, "uCover");
    } catch (err) {
      console.warn("Loading effect fell back to CSS:", err);
      program = null;
    }
  }
  const useGL = !!(gl && program);
  canvas.classList.toggle("css-fallback", !useGL);

  const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  function resize() {
    // The gradient is soft, so half resolution looks the same and costs a quarter.
    const scale = Math.min(0.5 * devicePixelRatio, 900 / Math.max(1, canvas.clientWidth));
    const w = Math.max(1, Math.round(canvas.clientWidth * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function frame(now: number) {
    if (tween) {
      const k = Math.min(1, (now - tween.start) / tween.dur);
      cover = tween.from + (tween.to - tween.from) * easeInOut(k);
      if (k >= 1) { const done = tween.done; tween = null; done?.(); }
    }
    if (useGL && gl) {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, ((now - t0) / 1000) * (reduceMotion ? 0.3 : 1));
      gl.uniform1f(uCover, cover);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      canvas.style.opacity = String(cover);
    }
    if (cover <= 0 && !tween) { stopLoop(); return; }
    raf = requestAnimationFrame(frame);
  }

  function startLoop() {
    canvas.hidden = false;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    cancelAnimationFrame(raf);
    raf = 0;
    canvas.hidden = true;
  }
  function animateTo(to: number, dur: number, done?: () => void) {
    tween = { from: cover, to, start: performance.now(), dur, done };
    startLoop();
  }

  const slosh: Slosh = {
    get active() { return cover > 0 || !!tween; },
    /** Sweep the gradient in over whatever is in the frame. */
    cover() {
      if (tween?.to === 1 || (cover === 1 && !tween)) return;
      animateTo(1, cover === 0 ? 700 : 400);
    },
    /** Dissolve the gradient away to show the video underneath. */
    reveal(done) {
      if (!slosh.active) { done?.(); return; }
      animateTo(0, 1600, done);
    },
    /** Remove it at once. */
    clear() { tween = null; cover = 0; stopLoop(); },
    // The GL context is left alive: React may remount on the same canvas and get it back.
    destroy() { slosh.clear(); },
  };
  return slosh;
}
