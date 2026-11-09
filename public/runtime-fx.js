// Animated backgrounds and text effects for generated videos, in the spirit of the React Bits
// collection (aurora, silk, split text, shiny text...). These are original implementations that
// draw from the video's time `t`, so they scrub and export frame by frame.
// Loaded by runtime.html, which exposes the result to programs as `FX`.
window.createFx = function createFx(env) {
  const { cfg, ease } = env;
  const TAU = Math.PI * 2;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  // ---------- colors ----------
  const colorCache = new Map();
  let probe = null;
  function rgb(color) {
    let c = colorCache.get(color);
    if (c) return c;
    if (!probe) {
      const cv = new OffscreenCanvas(1, 1);
      probe = cv.getContext("2d", { willReadFrequently: true });
    }
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    c = [d[0] / 255, d[1] / 255, d[2] / 255];
    colorCache.set(color, c);
    return c;
  }

  // ---------- WebGL backdrop renderer ----------
  const VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
  const HEAD = `
precision highp float;
uniform vec2 uRes; uniform float uTime, uSpeed, uIntensity, uScale, uCount;
uniform vec3 uBase, uC0, uC1, uC2, uC3, uC4;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.0; a *= 0.5; } return v; }
vec3 palette(float x){
  float f = clamp(x, 0.0, 1.0) * (uCount - 1.0);
  vec3 c = mix(uC0, uC1, smoothstep(0.0, 1.0, clamp(f, 0.0, 1.0)));
  c = mix(c, uC2, smoothstep(0.0, 1.0, clamp(f - 1.0, 0.0, 1.0)));
  c = mix(c, uC3, smoothstep(0.0, 1.0, clamp(f - 2.0, 0.0, 1.0)));
  return mix(c, uC4, smoothstep(0.0, 1.0, clamp(f - 3.0, 0.0, 1.0)));
}
`;
  const SHADERS = {
    // Soft curtains of light drifting across a dark sky.
    aurora: `
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; float asp = uRes.x / uRes.y;
  float x = uv.x * asp, t = uTime * uSpeed;
  vec3 col = uBase;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float edge = 0.58 + 0.17 * sin(x * 1.5 / uScale + t * 0.5 + fi * 2.1) + 0.15 * (fbm(vec2(x * 1.1 / uScale + fi * 7.3, t * 0.18 + fi)) - 0.5) * 2.0;
    float d = uv.y - edge;
    float band = exp(-abs(d) * (d < 0.0 ? 5.5 : 11.0));
    float streak = 0.55 + 0.45 * fbm(vec2(x * 14.0 / uScale + fi * 3.0, uv.y * 1.4 - t * 0.25));
    vec3 c = palette(0.5 + 0.5 * sin(uv.x * 2.6 + fi * 1.9 + 0.6 * sin(t * 0.3)));
    col += c * band * streak * uIntensity * (0.95 - fi * 0.18);
  }
  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
}`,
    // Slow rolling color field.
    plasma: `
void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y) * 3.0 * uScale; float t = uTime * uSpeed;
  float v = sin(p.x * 1.7 + t) + sin(p.y * 2.1 - t * 0.8) + sin((p.x + p.y) * 1.3 + t * 0.6)
          + sin(length(p + vec2(sin(t * 0.3), cos(t * 0.4))) * 2.4 - t);
  vec3 col = mix(uBase, palette(smoothstep(0.12, 0.88, v * 0.125 + 0.5)), clamp(uIntensity, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`,
    // Flowing satin folds with a soft sheen.
    silk: `
void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y) * 2.0 * uScale; float t = uTime * uSpeed * 0.35;
  p += 0.28 * vec2(fbm(p * 0.9 + vec2(0.0, t)), fbm(p * 0.9 + vec2(5.2, 1.3) - t));
  float s = sin(p.x * 4.2 + p.y * 1.4 + fbm(p * 1.2 + t) * 2.4);
  float shade = 0.5 + 0.5 * s;
  vec3 col = palette(shade) + pow(shade, 10.0) * 0.22 * uIntensity;
  gl_FragColor = vec4(mix(uBase, col, clamp(0.35 + uIntensity * 0.65, 0.0, 1.0)), 1.0);
}`,
    // Blended, drifting blobs of color (a mesh gradient).
    orbs: `
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; float asp = uRes.x / uRes.y; vec2 p = vec2(uv.x * asp, uv.y);
  float t = uTime * uSpeed * 0.5;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 pos = vec2(asp * (0.5 + 0.42 * sin(t * (0.5 + 0.13 * fi) + fi * 1.7)), 0.5 + 0.38 * cos(t * (0.4 + 0.11 * fi) + fi * 2.3));
    vec2 d = p - pos;
    float w = pow(1.0 / (dot(d, d) * 7.0 / uScale + 0.06), 1.5);
    acc += palette(fi / 4.0) * w; wsum += w;
  }
  gl_FragColor = vec4(mix(uBase, acc / wsum, clamp(uIntensity, 0.0, 1.0)), 1.0);
}`,
  };

  let glCanvas = null, gl = null, glBroken = false, quad = null;
  const programs = new Map();

  function ensureGL(w, h) {
    if (glBroken) return false;
    try {
      if (!glCanvas) {
        glCanvas = new OffscreenCanvas(w, h);
        gl = glCanvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
        if (!gl) throw new Error("no webgl");
        quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      }
      if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
      return true;
    } catch {
      glBroken = true;
      return false;
    }
  }

  function program(name) {
    let p = programs.get(name);
    if (p) return p;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, HEAD + SHADERS[name]));
    gl.linkProgram(prog);
    p = { prog, loc: {} };
    programs.set(name, p);
    return p;
  }

  const DEFAULT_COLORS = ["#7c3aed", "#06b6d4", "#22c55e"];

  function backdrop(name, ctx, t, o = {}) {
    const { W, H } = cfg();
    const colors = (o.colors && o.colors.length ? o.colors : DEFAULT_COLORS).slice(0, 5);
    const base = o.base ?? "#05060a";
    const alpha = o.opacity ?? 1;
    const scale = o.resolution ?? 0.5;
    const gw = Math.max(2, Math.round(W * scale)), gh = Math.max(2, Math.round(H * scale));

    if (!ensureGL(gw, gh)) {
      // No WebGL: fall back to a plain gradient so the video still renders.
      ctx.save();
      ctx.globalAlpha = alpha;
      const g = ctx.createLinearGradient(0, 0, W, H);
      colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      return;
    }

    const p = program(name);
    gl.useProgram(p.prog);
    gl.viewport(0, 0, gw, gh);
    const loc = (n) => (p.loc[n] ??= gl.getUniformLocation(p.prog, n));
    const aPos = gl.getAttribLocation(p.prog, "p");
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const padded = Array.from({ length: 5 }, (_, i) => rgb(colors[Math.min(i, colors.length - 1)]));
    gl.uniform2f(loc("uRes"), gw, gh);
    gl.uniform1f(loc("uTime"), t);
    gl.uniform1f(loc("uSpeed"), o.speed ?? 1);
    gl.uniform1f(loc("uIntensity"), o.intensity ?? 1);
    gl.uniform1f(loc("uScale"), o.scale ?? 1);
    gl.uniform1f(loc("uCount"), Math.max(2, colors.length));
    gl.uniform3fv(loc("uBase"), rgb(base));
    padded.forEach((c, i) => gl.uniform3fv(loc("uC" + i), c));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(glCanvas, 0, 0, W, H);
    ctx.restore();
  }

  // ---------- dot grid ----------
  function dotGrid(ctx, t, o = {}) {
    const { W, H } = cfg();
    const color = o.color ?? "rgba(255,255,255,0.35)";
    let spacing = o.spacing ?? Math.min(W, H) / 22;
    // Keep the dot count reasonable.
    while ((W / spacing) * (H / spacing) > 2400) spacing *= 1.15;
    const r = o.radius ?? spacing * 0.09;
    const amp = o.wave ?? 0.9;
    const speed = o.speed ?? 1;
    const cx = o.x ?? W / 2, cy = o.y ?? H / 2;
    ctx.save();
    ctx.fillStyle = color;
    for (let y = spacing / 2; y < H; y += spacing) {
      for (let x = spacing / 2; x < W; x += spacing) {
        const d = Math.hypot(x - cx, y - cy) / Math.min(W, H);
        const k = 0.5 + 0.5 * Math.sin(d * 9 - t * 2.2 * speed);
        const rr = r * (1 + amp * k);
        ctx.globalAlpha = 0.35 + 0.65 * k;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------- text ----------
  const fontSize = (font) => {
    const m = /(\d+(?:\.\d+)?)px/.exec(font || "");
    return m ? parseFloat(m[1]) : 64;
  };
  const place = (total, x, align) => (align === "left" || align === "start" ? x : align === "right" || align === "end" ? x - total : x - total / 2);

  // Reveals text a character or word at a time. `progress` runs 0..1 (use 1 - progress to exit).
  // effect: "rise" | "drop" | "fade" | "scale" | "blur" | "slide"
  function splitText(ctx, text, o = {}) {
    const { W, H } = cfg();
    const font = o.font ?? ctx.font;
    const size = fontSize(font);
    const by = o.by === "word" ? "word" : "char";
    const units = by === "word" ? String(text).split(/(\s+)/).filter(Boolean) : Array.from(String(text));
    const effect = o.effect ?? "rise";
    const stagger = Math.min(0.9, Math.max(0, o.stagger ?? 0.5));
    const dist = o.distance ?? size * 0.6;
    const easing = typeof o.ease === "function" ? o.ease : ease[o.ease] || ease.outCubic;
    const x = o.x ?? W / 2, y = o.y ?? H / 2;

    ctx.save();
    ctx.font = font;
    ctx.textBaseline = o.baseline ?? "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = o.fill ?? "#fff";
    const widths = units.map((u) => ctx.measureText(u).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let cx = place(total, x, o.align ?? "center");
    const visible = units.map((u, i) => (/^\s+$/.test(u) ? -1 : i));
    const count = Math.max(1, visible.filter((v) => v >= 0).length - 1);
    let seen = 0;
    units.forEach((u, i) => {
      const w = widths[i];
      if (visible[i] >= 0) {
        const start = (seen / count) * stagger;
        seen++;
        const p = easing(clamp01((o.progress - start) / (1 - stagger)));
        if (p > 0.001) {
          const mid = cx + w / 2;
          ctx.save();
          ctx.globalAlpha *= effect === "scale" || effect === "rise" || effect === "drop" || effect === "slide" || effect === "blur" || effect === "fade" ? clamp01(p * 1.6) : 1;
          let dx = 0, dy = 0;
          if (effect === "rise") dy = (1 - p) * dist;
          if (effect === "drop") dy = -(1 - p) * dist;
          if (effect === "slide") dx = -(1 - p) * dist;
          if (effect === "blur") ctx.filter = `blur(${((1 - p) * size * 0.35).toFixed(2)}px)`;
          ctx.translate(mid + dx, y + dy);
          if (effect === "scale") ctx.scale(0.3 + 0.7 * p, 0.3 + 0.7 * p);
          ctx.fillText(u, -w / 2, 0);
          ctx.restore();
        }
      }
      cx += w;
    });
    ctx.restore();
    return total;
  }

  // Text with a band of light sweeping across it. `progress` 0..1 moves the shine from left to right.
  function shinyText(ctx, text, o = {}) {
    const { W, H } = cfg();
    const font = o.font ?? ctx.font;
    ctx.save();
    ctx.font = font;
    ctx.textBaseline = o.baseline ?? "middle";
    ctx.textAlign = "left";
    const w = ctx.measureText(text).width;
    const x0 = place(w, o.x ?? W / 2, o.align ?? "center");
    const band = (o.width ?? 0.3) * w + 1;
    const pos = x0 - band + (w + 2 * band) * clamp01(o.progress ?? 0);
    const g = ctx.createLinearGradient(pos - band, 0, pos + band, 0);
    const base = o.fill ?? "rgba(255,255,255,0.45)";
    g.addColorStop(0, base);
    g.addColorStop(0.5, o.shine ?? "#ffffff");
    g.addColorStop(1, base);
    ctx.fillStyle = g;
    ctx.fillText(text, x0, o.y ?? H / 2);
    ctx.restore();
    return w;
  }

  const hashInt = (n) => {
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return (n ^ (n >>> 16)) >>> 0;
  };

  // Text that resolves left to right out of random characters. `progress` 0..1.
  function scrambleText(ctx, text, o = {}) {
    const { W, H } = cfg();
    const chars = o.chars ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=?";
    const seed = o.seed ?? 1;
    const p = clamp01(o.progress ?? 0);
    const letters = Array.from(String(text));
    ctx.save();
    ctx.font = o.font ?? ctx.font;
    ctx.textBaseline = o.baseline ?? "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = o.fill ?? "#fff";
    const widths = letters.map((l) => ctx.measureText(l).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let cx = place(total, o.x ?? W / 2, o.align ?? "center");
    const revealed = p * letters.length;
    const frame = Math.floor(p * 60);
    letters.forEach((l, i) => {
      let ch = l;
      if (i >= revealed && l.trim()) ch = chars[hashInt(i * 7919 + frame * 104729 + seed) % chars.length];
      ctx.globalAlpha = i >= revealed ? 0.55 : 1;
      ctx.fillText(ch, cx + widths[i] / 2, o.y ?? H / 2);
      cx += widths[i];
    });
    ctx.restore();
    return total;
  }

  // A number counting up, as a string. count(0, 1000000, progress, { commas: true })
  function count(from, to, progress, o = {}) {
    const v = from + (to - from) * clamp01(progress);
    const d = o.decimals ?? 0;
    const s = Math.abs(v).toFixed(d);
    const [int, frac] = s.split(".");
    const body = (o.commas === false ? int : int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")) + (frac ? "." + frac : "");
    return (o.prefix ?? "") + (v < 0 ? "-" : "") + body + (o.suffix ?? "");
  }

  return {
    aurora: (ctx, t, o) => backdrop("aurora", ctx, t, o),
    plasma: (ctx, t, o) => backdrop("plasma", ctx, t, o),
    silk: (ctx, t, o) => backdrop("silk", ctx, t, o),
    orbs: (ctx, t, o) => backdrop("orbs", ctx, t, o),
    dotGrid,
    splitText,
    shinyText,
    scrambleText,
    count,
  };
};
