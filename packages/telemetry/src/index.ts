// Frontend telemetry: Web Vitals, frame rate, long tasks, GPU context loss, scene-load time and renderer counters, plus W3C
// trace context so a browser action can be followed into the API's logs and traces.

export interface RenderInfo { calls: number; triangles: number; points: number; geometries: number; textures: number; programs: number }
export interface Snapshot {
  fps: number;
  frameP95Ms: number;
  droppedFrames: number;
  longTasks: number;
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  contextLost: number;
  sceneLoadMs: number | null;
  shaderCompileMs: number | null;
  render: RenderInfo | null;
  objects: number;
}

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
/** A W3C traceparent header value for one user action. */
export const traceparent = () => `00-${hex(16)}-${hex(8)}-01`;

export class Telemetry {
  private frames: number[] = [];
  private last = 0;
  s: Snapshot = { fps: 0, frameP95Ms: 0, droppedFrames: 0, longTasks: 0, lcpMs: null, inpMs: null, cls: null, contextLost: 0, sceneLoadMs: null, shaderCompileMs: null, render: null, objects: 0 };
  private listeners = new Set<(s: Snapshot) => void>();
  private sink?: (s: Snapshot) => void;

  constructor(sink?: (s: Snapshot) => void) { this.sink = sink; }

  async start() {
    if (typeof window === "undefined") return;
    try {
      new PerformanceObserver((l) => { this.s.longTasks += l.getEntries().length; }).observe({ type: "longtask", buffered: true });
    } catch { /* longtask not supported (Safari, Firefox) */ }
    const v = await import("web-vitals");
    v.onLCP((m) => { this.s.lcpMs = Math.round(m.value); });
    v.onINP((m) => { this.s.inpMs = Math.round(m.value); }, { reportAllChanges: true });
    v.onCLS((m) => { this.s.cls = +m.value.toFixed(3); }, { reportAllChanges: true });
  }

  /** Call once per rendered frame with the frame's timestamp (ms). */
  frame(t: number) {
    if (this.last) {
      const dt = t - this.last;
      this.frames.push(dt);
      if (dt > 50) this.s.droppedFrames += Math.round(dt / 16.7) - 1;
      if (this.frames.length > 120) this.frames.shift();
    }
    this.last = t;
  }

  /** Recompute the summary (call a few times a second, not every frame). */
  sample(render?: RenderInfo, objects?: number) {
    const f = [...this.frames].sort((a, b) => a - b);
    if (f.length) {
      this.s.fps = Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length));
      this.s.frameP95Ms = +f[Math.floor(f.length * 0.95)].toFixed(1);
    }
    if (render) this.s.render = render;
    if (objects !== undefined) this.s.objects = objects;
    for (const l of this.listeners) l({ ...this.s });
  }

  mark(name: "sceneLoadMs" | "shaderCompileMs", ms: number) { this.s[name] = Math.round(ms); }
  contextLost() { this.s.contextLost++; }
  subscribe(l: (s: Snapshot) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  /** Send the current snapshot to the sink (e.g. the API's /v1/telemetry), at most every 30 s by the caller's schedule. */
  flush() { this.sink?.({ ...this.s }); }
}
