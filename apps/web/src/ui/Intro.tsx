"use client";
// The public story, four chapters scrolled over the live canvas. Every number is computed in the page from the same runtime.
import { useEffect, useMemo, useRef } from "react";
import { evaluate, gate, makeEmails, supportWorkflow } from "@synapse/domain";
import { get, loadTemplate, playback, runNow, secrets, send, set, useApp } from "../store.ts";
import { fit } from "../canvas/GraphCanvas.tsx";
import { readLink } from "../url.ts";
import { ms, pct } from "./fmt.ts";

export default function Intro() {
  const ref = useRef<HTMLDivElement>(null);
  const view = useApp((s) => s.view);
  const run = useApp((s) => s.run);
  const headline = useMemo(() => {
    const em = makeEmails();
    const a = evaluate(supportWorkflow("atlas-large", 1), em, { secrets, label: "v1" }), b = evaluate(supportWorkflow("nova-pro", 2, "nova-lite"), em, { secrets, label: "v2" });
    return { a, b, g: gate(a, b) };
  }, []);

  useEffect(() => {
    const el = ref.current!;
    const onScroll = () => {
      const secs = [...el.querySelectorAll<HTMLElement>("[data-chapter]")];
      const mid = el.scrollTop + el.clientHeight / 2;
      const n = Math.max(0, secs.findLastIndex((s) => s.offsetTop <= mid));
      if (get().view !== `intro${n}`) {
        send({ type: "CHAPTER", n });
        const wf = get().wf;
        if (n === 0) fit(wf, get().reduced ? 0 : 1200);
        if (n === 1) { fit(wf, get().reduced ? 0 : 900); playback.t = 0; set({ playing: !get().reduced }); if (get().reduced) playback.t = get().run?.totalLatencyMs ?? 0; }
        if (n === 2) { playback.t = get().run?.totalLatencyMs ?? 0; set({ playing: false, selected: ["crm"] }); }
        if (n === 3) set({ selected: ["classify", "draft"] });
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const l = readLink(location.search);
    if (l.enter || l.tpl || l.v || l.node || l.view) return; // a deep link decides what is loaded
    loadTemplate(); set({ emailId: "sample" }); runNow().then(() => { set({ playing: false }); playback.t = 0; });
  }, []);

  const crm = run?.steps.find((s) => s.nodeId === "crm");
  const start = (template: boolean) => {
    if (template) loadTemplate();
    else set({ wf: { ...get().wf, nodes: [], edges: [] }, plan: null, issues: [], run: null, runs: {}, versions: {}, selected: [] });
    send({ type: "ENTER" });
    setTimeout(() => fit(get().wf), 0);
  };
  return (
    <div className="intro" ref={ref} aria-label="Introduction" hidden={!view.startsWith("intro")}>
      <section data-chapter="0" className="chapter">
        <p className="kicker">SYNAPSE · visual AI infrastructure</p>
        <h1>An agent is a graph. Most teams can&apos;t see theirs.</h1>
        <p>This canvas is a working support agent: six steps, two models, a tool and a search. Scroll to watch it handle an e-mail.</p>
        <p className="badge-line"><span className="badge">SIMULATED PROVIDERS</span> The models, the CRM and the knowledge base are deterministic simulators in this repository. Nothing calls a real model.</p>
      </section>
      <section data-chapter="1" className="chapter">
        <h2>Watch one e-mail move through it.</h2>
        <p>Particles carry each step&apos;s output along its edges at real speed. A node glows while it works; the glow&apos;s reach is its share of the run&apos;s time, and the bar under it is its tokens.</p>
        {run ? <p>This run: {run.steps.length} steps in {ms(run.totalLatencyMs)}, {run.tokens.in + run.tokens.out} tokens. The PII filter took out {run.steps[1]?.note?.replace("redacted ", "")} before any model saw the text.</p> : null}
      </section>
      <section data-chapter="2" className="chapter">
        <h2>A step failed. You can see where, and what happened next.</h2>
        {crm ? <p>The order lookup timed out after {ms(crm.attempts[0]?.latencyMs ?? 0)}. The runtime waited {ms(crm.attempts[1]?.backoffMs ?? 0)} and retried; the second call took {ms(crm.attempts[1]?.latencyMs ?? 0)}. Classification ran in parallel, so the draft only waited for the lookup.</p> : null}
      </section>
      <section data-chapter="3" className="chapter">
        <h2>Swap the model. Compare. Gate the release.</h2>
        <p>On {headline.a.n} labeled e-mails, Nova Pro instead of Atlas Large costs {pct(1 - headline.b.costPerRun / headline.a.costPerRun)} less and is {pct(1 - headline.b.latencyP95 / headline.a.latencyP95)} faster at p95, and classifies slightly better ({pct(headline.b.accuracy)} vs {pct(headline.a.accuracy)}). But its replies drop the order number more often, so the end-to-end pass rate falls from {pct(headline.a.passRate)} to {pct(headline.b.passRate)}, and the release gate {headline.g.pass ? "lets it through" : "blocks it"}.</p>
        <div className="cta">
          <button className="primary" onClick={() => start(false)}>Build it yourself</button>
          <button className="ghost" onClick={() => start(true)}>Open with the template</button>
        </div>
      </section>
    </div>
  );
}
