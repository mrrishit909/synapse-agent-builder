"use client";
import { useEffect, useState } from "react";
import type { Snapshot } from "@synapse/telemetry";
import { telemetry } from "../runtime.ts";
import { useApp } from "../store.ts";
import { n } from "./fmt.ts";

export default function Hud() {
  const on = useApp((s) => s.hud);
  const [s, setS] = useState<Snapshot>(telemetry.s);
  useEffect(() => { const off = telemetry.subscribe(setS); return () => { off(); }; }, []);
  if (!on) return null;
  const r = s.render;
  const rows: [string, string][] = [
    ["FPS", `${s.fps} (p95 frame ${s.frameP95Ms} ms)`], ["Dropped frames", n(s.droppedFrames)], ["Long tasks", n(s.longTasks)],
    ["LCP / INP / CLS", `${s.lcpMs ?? "–"} ms / ${s.inpMs ?? "–"} ms / ${s.cls ?? "–"}`],
    ["Scene load", `${s.sceneLoadMs ?? "–"} ms`], ["Shader compile", `${s.shaderCompileMs ?? "–"} ms`],
    ["Draw calls / triangles", r ? `${r.calls} / ${n(r.triangles)}` : "–"], ["Particles drawn", r ? n(r.points) : "–"],
    ["GPU geometries / textures / programs", r ? `${r.geometries} / ${r.textures} / ${r.programs}` : "–"],
    ["Nodes drawn", n(s.objects)], ["GPU context lost", String(s.contextLost)],
  ];
  return (
    <aside className="hud" aria-label="Telemetry">
      <table><tbody>{rows.map(([a, b]) => <tr key={a}><th scope="row">{a}</th><td>{b}</td></tr>)}</tbody></table>
    </aside>
  );
}
