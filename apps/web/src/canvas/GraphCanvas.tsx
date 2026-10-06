"use client";
// Infinite spatial canvas (three.js, orthographic). Nodes are one instanced draw (a rounded-rect shader with glow), edges one line
// set, execution particles one point set. Everything drawn is derived from the store: graph positions, the run trace and the
// playback clock. Semantic zoom: far = shapes only, middle = names, near = live metrics.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { NODE_SPECS, stressGraph, type RunResult, type Workflow } from "@synapse/domain";
import { connect, edgesTimed, get, inspect, moveNode, playback, select, set, useApp } from "../store.ts";
import { orchestrator, telemetry } from "../runtime.ts";
import { isIntro } from "../journey.ts";

export const NODE_W = 200, NODE_H = 84, PAD = 44;
const KIND_COLOR: Record<string, string> = { trigger: "#8fb4ff", policy: "#c9a2ff", llm: "#5ef2c2", retrieval: "#ffd36e", tool: "#ff9f6e", router: "#9aa6b8", output: "#9aa6b8" };
const STATE_COLOR = { ok: [0.37, 0.95, 0.76], error: [1, 0.42, 0.35], retry: [1, 0.71, 0.33], cached: [0.5, 0.78, 1], running: [0.55, 0.7, 1] } as const;

/** Camera: centre x/y in world px and zoom (screen px per world px). Exposed for the inspector morph and tests. */
export const view = { cx: 560, cy: 200, zoom: 0.8, w: 1, h: 1 };
export const toScreen = (x: number, y: number) => [(x - view.cx) * view.zoom + view.w / 2, (y - view.cy) * view.zoom + view.h / 2] as const;
export const toWorld = (sx: number, sy: number) => [(sx - view.w / 2) / view.zoom + view.cx, (sy - view.h / 2) / view.zoom + view.cy] as const;
export function nodeScreenRect(id: string) {
  const n = get().wf.nodes.find((x) => x.id === id);
  if (!n) return null;
  const [x, y] = toScreen(n.x, n.y);
  return { x, y, w: NODE_W * view.zoom, h: NODE_H * view.zoom };
}
/** Fit the camera to a graph (tweened through the motion layer). */
export function fit(wf: Workflow, ms = 900) {
  if (!wf.nodes.length) { orchestrator.to("cam", [560, 200, 0.8], ms); return; }
  const xs = wf.nodes.map((n) => n.x), ys = wf.nodes.map((n) => n.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) + NODE_W, y0 = Math.min(...ys), y1 = Math.max(...ys) + NODE_H;
  // in the story the text covers the left of the screen, and in the sandbox the side panels do: fit into what is left
  const intro = get().view.startsWith("intro"), left = intro ? 0.42 : view.w > 900 ? 310 / view.w : 0, right = intro ? 0.02 : view.w > 900 ? 400 / view.w : 0;
  const top = intro ? 0.08 : 110 / view.h, bottom = intro ? 0.08 : 230 / view.h;
  const fw = view.w * (1 - left - right), fh = view.h * (1 - top - bottom);
  const z = Math.max(0.05, Math.min(1.25, (fw * 0.9) / (x1 - x0 + 80), (fh * 0.9) / (y1 - y0 + 80)));
  const sx = view.w * (left + (1 - left - right) / 2), sy = view.h * (top + (1 - top - bottom) / 2);
  orchestrator.to("cam", [(x0 + x1) / 2 - (sx - view.w / 2) / z, (y0 + y1) / 2 - (sy - view.h / 2) / z, z], ms);
}

const nodeVert = /* glsl */ `
  attribute vec3 aColor; attribute vec4 aGlow; attribute vec4 aFlags; attribute vec2 aBars;
  varying vec2 vLocal; varying vec3 vColor; varying vec4 vGlow; varying vec4 vFlags; varying vec2 vBars;
  void main() {
    vLocal = (position.xy + 0.5) * vec2(${NODE_W + 2 * PAD}.0, ${NODE_H + 2 * PAD}.0) - vec2(${PAD}.0);
    vColor = aColor; vGlow = aGlow; vFlags = aFlags; vBars = aBars;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;
const nodeFrag = /* glsl */ `
  uniform float uZoom; uniform float uTime;
  varying vec2 vLocal; varying vec3 vColor; varying vec4 vGlow; varying vec4 vFlags; varying vec2 vBars;
  float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    vec2 c = vLocal - vec2(${NODE_W / 2}.0, ${NODE_H / 2}.0);
    float d = sdRound(c, vec2(${NODE_W / 2}.0, ${NODE_H / 2}.0), 14.0);
    float px = 1.0 / uZoom;
    float inside = 1.0 - smoothstep(-px, px, d);
    // glow: colour = step state, reach = latency share, brightness = how far the step has got
    float reach = mix(6.0, ${PAD - 4}.0, vGlow.w);
    float halo = (1.0 - smoothstep(0.0, reach, d)) * step(0.0, d) * vFlags.z;
    vec3 fill = vec3(0.07, 0.09, 0.13) * (1.0 - 0.6 * vFlags.w);
    float border = smoothstep(-px * 1.5 - (vFlags.x > 0.5 ? 3.0 : 1.5), -px * 0.5, d) * inside;
    vec3 col = mix(fill, vFlags.x > 0.5 ? vec3(1.0) : vColor * (1.0 - 0.5 * vFlags.w), border);
    // bars along the bottom: progress of the running step (blue), tokens used (kind colour)
    float y = vLocal.y;
    if (vBars.x > 0.0 && y > ${NODE_H - 9}.0 && y < ${NODE_H - 5}.0 && vLocal.x > 14.0 && vLocal.x < 14.0 + (${NODE_W - 28}.0) * vBars.x) col = vec3(0.55, 0.7, 1.0);
    if (vBars.y > 0.0 && y > ${NODE_H - 15}.0 && y < ${NODE_H - 12}.0 && vLocal.x > 14.0 && vLocal.x < 14.0 + (${NODE_W - 28}.0) * vBars.y) col = vColor;
    float a = max(inside, halo * 0.55);
    vec3 outCol = inside > 0.01 ? col : vGlow.rgb;
    if (a < 0.003) discard;
    gl_FragColor = vec4(outCol, a);
  }`;

interface Spring { x: number; y: number; vx: number; vy: number }

function bezier(ax: number, ay: number, bx: number, by: number, t: number) {
  const dx = Math.max(60, Math.abs(bx - ax) * 0.5), u = 1 - t;
  const c1x = ax + dx, c2x = bx - dx;
  return [u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx, u * u * u * ay + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * by] as const;
}

/** State of each node at trace time t: what the glow shows. */
export function nodeStates(r: RunResult | null, t: number) {
  const out = new Map<string, { state: keyof typeof STATE_COLOR | "idle"; progress: number; latencyShare: number; tokenShare: number }>();
  if (!r) return out;
  const maxLat = Math.max(1, ...r.steps.map((s) => s.latencyMs)), maxTok = Math.max(1, ...r.steps.map((s) => s.tokenIn + s.tokenOut));
  for (const s of r.steps) {
    let state: keyof typeof STATE_COLOR | "idle" = "idle";
    if (t >= s.startMs && t < s.endMs) {
      const a = [...s.attempts].reverse().find((x) => x.startMs <= t);
      state = a && t > a.startMs + a.latencyMs && (a.status !== 200 || a.error) ? "retry" : a && a.status !== 200 && t > a.startMs + a.latencyMs * 0.9 ? "error" : "running";
    } else if (t >= s.endMs) state = s.status === "error" ? "error" : s.status === "cached" ? "cached" : s.attempts.some((a) => a.status !== 200 || a.error) ? "retry" : "ok";
    out.set(s.nodeId, { state, progress: state === "running" || state === "retry" ? Math.min(1, (t - s.startMs) / Math.max(1, s.latencyMs)) : 0, latencyShare: s.latencyMs / maxLat, tokenShare: (s.tokenIn + s.tokenOut) / maxTok });
  }
  return out;
}

export default function GraphCanvas() {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const wfLive = useApp((s) => s.wf);
  const stress = useApp((s) => s.stress);
  const viewState = useApp((s) => s.view);
  const run = useApp((s) => s.run);
  const selected = useApp((s) => s.selected);
  const [zoomLevel, setZoomLevel] = useState(1);
  const wf = stress ? stressGraphCached() : wfLive;
  const refs = useRef<{ wf: Workflow; springs: Map<string, Spring>; drag: null | { id: string; ox: number; oy: number; sx: number; sy: number; moved: boolean }; pan: null | { sx: number; sy: number; cx: number; cy: number; moved: boolean }; link: null | { from: string; x: number; y: number } }>({ wf, springs: new Map(), drag: null, pan: null, link: null });
  refs.current.wf = wf;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    const MAX = 2100, MAXE = 5200, SEG = 20;
    const geo = new THREE.PlaneGeometry(1, 1);
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(MAX * n), n).setUsage(THREE.DynamicDrawUsage);
    const a = { aColor: attr(3), aGlow: attr(4), aFlags: attr(4), aBars: attr(2) };
    for (const [k, v] of Object.entries(a)) geo.setAttribute(k, v);
    const mat = new THREE.ShaderMaterial({ vertexShader: nodeVert, fragmentShader: nodeFrag, transparent: true, depthTest: false, side: THREE.DoubleSide, uniforms: { uZoom: { value: 1 }, uTime: { value: 0 } } });
    const nodes = new THREE.InstancedMesh(geo, mat, MAX);
    nodes.frustumCulled = false;
    const epos = new Float32Array(MAXE * SEG * 6), ecol = new Float32Array(MAXE * SEG * 6);
    const egeo = new THREE.BufferGeometry();
    egeo.setAttribute("position", new THREE.BufferAttribute(epos, 3).setUsage(THREE.DynamicDrawUsage));
    egeo.setAttribute("color", new THREE.BufferAttribute(ecol, 3).setUsage(THREE.DynamicDrawUsage));
    const edges = new THREE.LineSegments(egeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    edges.frustumCulled = false;
    const PMAX = 600, ppos = new Float32Array(PMAX * 3), pcol = new Float32Array(PMAX * 3);
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute("position", new THREE.BufferAttribute(ppos, 3).setUsage(THREE.DynamicDrawUsage));
    pgeo.setAttribute("color", new THREE.BufferAttribute(pcol, 3).setUsage(THREE.DynamicDrawUsage));
    const parts = new THREE.Points(pgeo, new THREE.PointsMaterial({ size: 7, vertexColors: true, transparent: true, sizeAttenuation: false }));
    parts.frustumCulled = false;
    const linkGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(SEG * 6), 3));
    const linkLine = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: "#ffffff" }));
    linkLine.frustumCulled = false;
    scene.add(edges, nodes, parts, linkLine);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    if (!orchestrator.get("cam")) orchestrator.set("cam", [view.cx, view.cy, view.zoom]);

    const resize = () => {
      view.w = el.clientWidth; view.h = el.clientHeight;
      renderer.setSize(view.w, view.h, false);
      renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(el);

    const pos = (id: string) => {
      const n = refs.current.wf.nodes.find((x) => x.id === id);
      if (!n) return [0, 0] as const;
      const s = refs.current.springs.get(id), d = refs.current.drag;
      const dx = d?.id === id ? d.ox : 0, dy = d?.id === id ? d.oy : 0;
      return [n.x + dx + (s?.x ?? 0), n.y + dy + (s?.y ?? 0)] as const;
    };
    const hit = (sx: number, sy: number) => {
      const [x, y] = toWorld(sx, sy);
      const ns = refs.current.wf.nodes;
      for (let i = ns.length - 1; i >= 0; i--) {
        const n = ns[i];
        if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return { id: n.id, port: x > n.x + NODE_W - 22 && Math.abs(y - (n.y + NODE_H / 2)) < 22 };
      }
      return null;
    };

    // ---- input ----
    const cv = renderer.domElement;
    const local = (e: PointerEvent | WheelEvent) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const onDown = (e: PointerEvent) => {
      if (isIntro(get().view)) return;
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = local(e), h = hit(sx, sy);
      if (h?.port && !get().stress) { const [x, y] = toWorld(sx, sy); refs.current.link = { from: h.id, x, y }; return; }
      if (h) {
        const sel = get().selected;
        select(e.shiftKey ? (sel.includes(h.id) ? sel.filter((s) => s !== h.id) : [...sel, h.id]) : sel.includes(h.id) ? sel : [h.id]);
        refs.current.drag = { id: h.id, ox: 0, oy: 0, sx, sy, moved: false };
        return;
      }
      const c = orchestrator.get("cam")!;
      refs.current.pan = { sx, sy, cx: c[0], cy: c[1], moved: false };
    };
    const onMove = (e: PointerEvent) => {
      const [sx, sy] = local(e);
      const d = refs.current.drag, p = refs.current.pan, l = refs.current.link;
      if (l) { const [x, y] = toWorld(sx, sy); l.x = x; l.y = y; return; }
      if (d) { d.ox = (sx - d.sx) / view.zoom; d.oy = (sy - d.sy) / view.zoom; if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true; return; }
      if (p) { if (Math.hypot(sx - p.sx, sy - p.sy) > 4) p.moved = true; orchestrator.set("cam", [p.cx - (sx - p.sx) / view.zoom, p.cy - (sy - p.sy) / view.zoom, view.zoom]); return; }
      cv.style.cursor = hit(sx, sy)?.port ? "crosshair" : hit(sx, sy) ? "grab" : "default";
    };
    const onUp = (e: PointerEvent) => {
      const [sx, sy] = local(e);
      const d = refs.current.drag, p = refs.current.pan, l = refs.current.link;
      if (l) { const h = hit(sx, sy); if (h && h.id !== l.from) connect(l.from, h.id); refs.current.link = null; }
      if (d) {
        const n = refs.current.wf.nodes.find((x) => x.id === d.id);
        if (d.moved && n && !get().stress) moveNode(d.id, n.x + d.ox, n.y + d.oy);
        else if (!d.moved && !e.shiftKey && !get().stress) inspect(d.id);
        refs.current.drag = null;
      }
      if (p && !p.moved && !e.shiftKey) { select([]); if (get().view === "inspect") inspect(null); }
      refs.current.pan = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [sx, sy] = local(e), [wx, wy] = toWorld(sx, sy);
      const z = Math.max(0.05, Math.min(3, view.zoom * Math.exp(-e.deltaY * 0.0015)));
      orchestrator.set("cam", [wx - (sx - view.w / 2) / z, wy - (sy - view.h / 2) / z, z]);
    };
    cv.addEventListener("pointerdown", onDown); cv.addEventListener("pointermove", onMove); cv.addEventListener("pointerup", onUp);
    cv.addEventListener("wheel", onWheel, { passive: false });
    const lost = (e: Event) => { e.preventDefault(); telemetry.contextLost(); };
    cv.addEventListener("webglcontextlost", lost);

    // ---- frame loop ----
    let raf = 0, last = performance.now(), lastZoomBucket = -1, lastSample = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, now - last); last = now;
      const s = get();
      orchestrator.policy.reduced = s.reduced; orchestrator.policy.paused = s.motionPaused;
      orchestrator.tick(dt);
      telemetry.frame(now);
      const [cx, cy, z] = orchestrator.get("cam")!;
      view.cx = cx; view.cy = cy; view.zoom = z;
      cam.left = cx - view.w / 2 / z; cam.right = cx + view.w / 2 / z; cam.top = cy - view.h / 2 / z; cam.bottom = cy + view.h / 2 / z; // y down
      cam.updateProjectionMatrix();
      mat.uniforms.uZoom.value = z; mat.uniforms.uTime.value = now / 1000;
      const bucket = z < 0.35 ? 0 : z < 0.9 ? 1 : 2;
      if (bucket !== lastZoomBucket) { lastZoomBucket = bucket; setZoomLevel(bucket); }

      // playback clock (trace ms); reduced motion jumps to the end state
      const r = s.stress ? null : s.run;
      if (r) {
        if (s.reduced) playback.t = Math.max(playback.t, r.totalLatencyMs);
        else if (s.playing && !s.motionPaused) playback.t = Math.min(r.totalLatencyMs, playback.t + dt * s.rate);
        if (s.playing && playback.t >= r.totalLatencyMs) set({ playing: false });
        if (now - playback.lastSync > 100) { playback.lastSync = now; window.dispatchEvent(new CustomEvent("synapse:tick")); }
      }

      // springs: neighbours of a dragged node lean toward it, then settle back (connectivity, shown)
      const W = refs.current.wf, d = refs.current.drag;
      const nbr = new Set<string>();
      if (d) for (const e of W.edges) { if (e.from === d.id) nbr.add(e.to); if (e.to === d.id) nbr.add(e.from); }
      if (W.nodes.length < 400) for (const n of W.nodes) {
        const sp = refs.current.springs.get(n.id) ?? { x: 0, y: 0, vx: 0, vy: 0 };
        const tx = d && nbr.has(n.id) ? d.ox * 0.18 : 0, ty = d && nbr.has(n.id) ? d.oy * 0.18 : 0;
        if (s.reduced) { sp.x = tx; sp.y = ty; sp.vx = sp.vy = 0; }
        else { const k = 140, c = 2 * Math.sqrt(k), h = dt / 1000; sp.vx += (k * (tx - sp.x) - c * sp.vx) * h; sp.vy += (k * (ty - sp.y) - c * sp.vy) * h; sp.x += sp.vx * h; sp.y += sp.vy * h; }
        refs.current.springs.set(n.id, sp);
      }

      // nodes
      const states = nodeStates(r, playback.t);
      const sel = new Set(s.selected);
      const running = !!r && playback.t < r.totalLatencyMs;
      W.nodes.forEach((n, i) => {
        if (i >= MAX) return;
        const [x, y] = pos(n.id);
        m4.makeScale(NODE_W + 2 * PAD, NODE_H + 2 * PAD, 1).setPosition(x + NODE_W / 2, y + NODE_H / 2, 0);
        nodes.setMatrixAt(i, m4);
        col.set(KIND_COLOR[NODE_SPECS[n.type]?.kind ?? "router"]);
        a.aColor.setXYZ(i, col.r, col.g, col.b);
        const st = states.get(n.id);
        const gc = st && st.state !== "idle" ? STATE_COLOR[st.state] : [0, 0, 0];
        const pulse = st?.state === "running" && !s.reduced ? 0.75 + 0.25 * Math.sin(now / 160) : 1;
        a.aGlow.setXYZW(i, gc[0], gc[1], gc[2], st ? (st.state === "running" ? 0.35 : st.latencyShare) : 0);
        a.aFlags.setXYZW(i, sel.has(n.id) ? 1 : 0, 0, st && st.state !== "idle" ? pulse : 0, running && st?.state === "idle" ? 1 : 0);
        a.aBars.setXY(i, st?.progress ?? 0, st && playback.t >= (r!.steps.find((q) => q.nodeId === n.id)?.endMs ?? Infinity) ? st.tokenShare : 0);
      });
      nodes.count = Math.min(MAX, W.nodes.length);
      nodes.instanceMatrix.needsUpdate = true;
      for (const v of Object.values(a)) v.needsUpdate = true;

      // edges + particles
      const timed = r ? edgesTimed() : [];
      const flight = new Map(timed.map((h) => [h.edgeId, h]));
      let ei = 0, pi = 0;
      const ne = Math.min(MAXE, W.edges.length);
      for (let k = 0; k < ne; k++) {
        const e = W.edges[k];
        const [ax0, ay0] = pos(e.from), [bx0, by0] = pos(e.to);
        const ax = ax0 + NODE_W, ay = ay0 + NODE_H / 2, bx = bx0, by = by0 + NODE_H / 2;
        const h = flight.get(e.id);
        const done = h && playback.t >= h.arriveMs, active = h && playback.t >= h.departMs && playback.t < h.arriveMs;
        const c = active ? [0.7, 0.85, 1] : done ? (h!.failed ? [0.8, 0.35, 0.3] : [0.42, 0.6, 0.55]) : running ? [0.16, 0.19, 0.25] : [0.3, 0.35, 0.44];
        let [px, py] = [ax, ay];
        for (let sgi = 1; sgi <= SEG; sgi++) {
          const [qx, qy] = bezier(ax, ay, bx, by, sgi / SEG);
          const o = (ei * SEG + sgi - 1) * 6;
          epos[o] = px; epos[o + 1] = py; epos[o + 3] = qx; epos[o + 4] = qy;
          for (let j = 0; j < 2; j++) { ecol[o + j * 3] = c[0]; ecol[o + j * 3 + 1] = c[1]; ecol[o + j * 3 + 2] = c[2]; }
          px = qx; py = qy;
        }
        ei++;
        if (active && !s.reduced && pi < PMAX - 4) {
          const f = (playback.t - h!.departMs) / (h!.arriveMs - h!.departMs);
          for (let j = 0; j < 4; j++) {
            const tt = f - j * 0.07;
            if (tt < 0) continue;
            const [qx, qy] = bezier(ax, ay, bx, by, tt);
            ppos.set([qx, qy, 0], pi * 3);
            const fade = 1 - j * 0.22;
            pcol.set(h!.failed ? [1 * fade, 0.45 * fade, 0.35 * fade] : [0.75 * fade, 0.9 * fade, 1 * fade], pi * 3);
            pi++;
          }
        }
      }
      egeo.setDrawRange(0, ei * SEG * 2);
      egeo.attributes.position.needsUpdate = true; egeo.attributes.color.needsUpdate = true;
      pgeo.setDrawRange(0, pi);
      pgeo.attributes.position.needsUpdate = true; pgeo.attributes.color.needsUpdate = true;

      // link being dragged out of a port
      const l = refs.current.link;
      linkLine.visible = !!l;
      if (l) {
        const [ax0, ay0] = pos(l.from), lp = linkGeo.attributes.position.array as Float32Array;
        let [px, py] = [ax0 + NODE_W, ay0 + NODE_H / 2];
        for (let sgi = 1; sgi <= SEG; sgi++) { const [qx, qy] = bezier(ax0 + NODE_W, ay0 + NODE_H / 2, l.x, l.y, sgi / SEG); lp.set([px, py, 0, qx, qy, 0], (sgi - 1) * 6); px = qx; py = qy; }
        linkGeo.attributes.position.needsUpdate = true;
      }

      renderer.render(scene, cam);

      // HTML labels follow their nodes (only when few enough to read)
      const L = labels.current;
      if (L) for (const child of Array.from(L.children) as HTMLElement[]) {
        const id = child.dataset.id!;
        const [x, y] = pos(id);
        const [sx, sy] = toScreen(x, y);
        child.style.transform = `translate(${sx}px, ${sy}px) scale(${z})`;
      }
      if (now - lastSample > 500) {
        lastSample = now;
        const inf = renderer.info;
        telemetry.sample({ calls: inf.render.calls, triangles: inf.render.triangles, points: inf.render.points, geometries: inf.memory.geometries, textures: inf.memory.textures, programs: inf.programs?.length ?? 0 }, W.nodes.length);
      }
    };
    raf = requestAnimationFrame(frame);
    requestAnimationFrame(() => telemetry.mark("sceneLoadMs", performance.now()));
    return () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); el.removeChild(cv); };
  }, []);

  // intro chapters and view changes move the camera (motion layer); the graph itself never moves on its own
  useEffect(() => { if (!stress) fit(wfLive, get().reduced ? 0 : 900); }, [viewState, stress, wfLive.nodes.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (stress) fit(wf, 0); }, [stress]); // eslint-disable-line react-hooks/exhaustive-deps

  const showLabels = !stress && zoomLevel > 0;
  const states = nodeStates(run, playback.t);
  return (
    <div className="graph" ref={host} role="application" aria-label={`Workflow canvas: ${wf.nodes.length} nodes, ${wf.edges.length} edges. Use the node list or the list view to navigate by keyboard.`}>
      <div className="labels" ref={labels} aria-hidden>
        {showLabels && wf.nodes.map((n) => {
          const st = states.get(n.id), step = run?.steps.find((s) => s.nodeId === n.id);
          return (
            <div key={n.id} data-id={n.id} className={`nlabel ${selected.includes(n.id) ? "sel" : ""}`} style={{ width: NODE_W, height: NODE_H }}>
              <b>{n.label}</b>
              <span className="kind">{NODE_SPECS[n.type]?.title ?? n.type}{n.config.model ? ` · ${String(n.config.model)}` : ""}</span>
              {zoomLevel === 2 && step && st && st.state !== "idle" ? <span className="metrics">{step.latencyMs} ms · {step.tokenIn + step.tokenOut} tok · {step.attempts.length > 1 ? `${step.attempts.length} attempts` : step.status}</span> : null}
              {n.group ? <span className="group">{n.group}</span> : null}
              <i className="port" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

let stressCache: Workflow | null = null;
const stressGraphCached = () => (stressCache ??= stressGraph());
