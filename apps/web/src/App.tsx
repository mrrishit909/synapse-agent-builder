"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@synapse/motion";
import type { NodeType } from "@synapse/domain";
import { addNode, compare, get, init, inspect, loadTemplate, playback, removeSelected, runNow, send, set, swapProvider, useApp, useVersion } from "./store.ts";
import { readLink, writeLink } from "./url.ts";
import { isIntro } from "./journey.ts";
import { telemetry } from "./runtime.ts";
import Intro from "./ui/Intro.tsx";
import { Actions, ComparePanel, Inspector, Palette as BuilderPalette, PublishDialog, TopBar, TracePanel } from "./ui/Panels.tsx";
import { Help, Palette } from "./ui/Dialogs.tsx";
import ListView from "./ui/ListView.tsx";
import Hud from "./ui/Hud.tsx";
import { fit, nodeScreenRect, toWorld } from "./canvas/GraphCanvas.tsx";

const GraphCanvas = dynamic(() => import("./canvas/GraphCanvas.tsx"), { ssr: false });

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(el?.tagName) || el?.closest?.("dialog")) return;
      const s = get();
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") { e.preventDefault(); set({ palette: true }); return; }
      if (isIntro(s.view) || e.metaKey || e.ctrlKey || e.altKey) return;
      const T = s.run?.totalLatencyMs ?? 0;
      switch (e.key) {
        case " ": e.preventDefault(); if (s.run) { if (playback.t >= T) playback.t = 0; set({ playing: !s.playing }); } break;
        case "ArrowRight": playback.t = Math.min(T, playback.t + (e.shiftKey ? 1000 : 100)); set({ playing: false }); window.dispatchEvent(new CustomEvent("synapse:tick")); break;
        case "ArrowLeft": playback.t = Math.max(0, playback.t - (e.shiftKey ? 1000 : 100)); set({ playing: false }); window.dispatchEvent(new CustomEvent("synapse:tick")); break;
        case "r": case "R": runNow(); break;
        case "l": case "L": set({ listView: !s.listView }); break;
        case "m": case "M": set({ reduced: !s.reduced }); break;
        case "p": case "P": set({ motionPaused: !s.motionPaused }); break;
        case "f": case "F": fit(s.wf); break;
        case "Delete": case "Backspace": removeSelected(); break;
        case "?": set({ help: true }); break;
        case "Escape": if (s.view === "inspect") inspect(null); else if (s.view !== "build") send({ type: "BACK" }); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Restore state from the URL once, then keep the URL in step with it. */
function useDeepLink() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const l = readLink(location.search);
    (async () => {
      if (l.rm) set({ reduced: true });
      if (l.list) set({ listView: true });
      if (l.enter || l.tpl || l.v || l.node || l.view) send({ type: "ENTER" });
      if (l.email) set({ emailId: l.email });
      if (l.tpl) { loadTemplate(); await runNow(); if (l.swap) await swapProvider(l.swap, l.swap.startsWith("nova") ? "nova-lite" : "atlas-mini"); }
      if (l.v) useVersion(l.v);
      if (l.t !== undefined) { playback.t = l.t; set({ playing: false }); }
      if (l.node) inspect(l.node);
      if (l.view === "compare") await compare();
      setTimeout(() => fit(get().wf, 0), 50);
    })();
    let last = "";
    setInterval(() => {
      const s = get();
      if (isIntro(s.view)) return;
      const vs = Object.keys(s.versions).map(Number).sort();
      const fromTemplate = s.versions[1]?.nodes.length === 6 && s.wf.nodes.length === 6;
      const swapModel = vs.length > 1 ? String(s.versions[vs.at(-1)!].nodes.find((n) => n.type.startsWith("llm."))?.config.model) : undefined;
      const link = writeLink({ tpl: fromTemplate, swap: swapModel, v: vs.length > 1 ? s.version : undefined, email: s.emailId, node: s.view === "inspect" ? s.inspect ?? undefined : undefined,
        view: s.view === "compare" ? "compare" : undefined, t: s.playing ? undefined : s.run && playback.t < s.run.totalLatencyMs ? playback.t : undefined, rm: s.reduced || undefined, list: s.listView || undefined });
      if (link !== last) { last = link; history.replaceState(null, "", link); }
    }, 400);
  }, []);
}

export default function App() {
  const view = useApp((s) => s.view);
  const listView = useApp((s) => s.listView);
  const announce = useApp((s) => s.announce);
  const reduced = useApp((s) => s.reduced);
  const intro = isIntro(view);
  useKeyboard();
  useEffect(() => {
    init();
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    set({ reduced: prefersReducedMotion() || readLink(location.search).rm === true });
    const onChange = () => set({ reduced: mq.matches });
    mq.addEventListener("change", onChange);
    telemetry.start();
    (window as unknown as { __synapse: unknown }).__synapse = { state: get, playback, telemetry: () => telemetry.s, rect: nodeScreenRect }; // read-only probe for e2e tests and the recorder
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useDeepLink();
  useEffect(() => { document.documentElement.dataset.reduced = reduced ? "1" : "0"; }, [reduced]);
  return (
    <div className={`app view-${view} ${intro ? "is-intro" : "is-sandbox"}`}>
      <a className="skip" href="#main-panels">Skip to the panels</a>
      <div className="graph-wrap" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
        const t = e.dataTransfer.getData("text/node-type") as NodeType;
        if (!t) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), [x, y] = toWorld(e.clientX - r.left, e.clientY - r.top);
        addNode(t, [x - 100, y - 42]);
      }}><GraphCanvas /></div>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      <Intro />
      {!intro ? (
        <>
          <TopBar />
          <div id="main-panels" className="panels">
            <BuilderPalette />
            <Actions />
            {listView ? <ListView /> : null}
            <Inspector />
            <ComparePanel />
          </div>
          <TracePanel />
          <Hud />
          <PublishDialog />
        </>
      ) : null}
      <Palette />
      <Help />
    </div>
  );
}
