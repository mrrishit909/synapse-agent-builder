"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { NODE_SPECS, MODELS, CLASSIFY_PROMPT, DRAFT_PROMPT, lineDiff, model, type NodeType, type StepRecord } from "@synapse/domain";
import {
  addNode, compare, connect, get, groupSelected, inspect, loadTemplate, playback, publish, removeSelected, replay, runNow, select, send, set, setConfig,
  swapProvider, useApp, useVersion, type AppState,
} from "../store.ts";
import { fit, nodeScreenRect } from "../canvas/GraphCanvas.tsx";
import { ms, pct, usd, n as num } from "./fmt.ts";

const PALETTE: NodeType[] = ["trigger.email", "policy.pii", "llm.classify", "tool.crm", "retrieval.kb", "llm.draft"];
const useTick = () => { const [, f] = useState(0); useEffect(() => { const h = () => f((k) => k + 1); window.addEventListener("synapse:tick", h); return () => window.removeEventListener("synapse:tick", h); }, []); };

export function TopBar() {
  const version = useApp((s) => s.version);
  const versions = useApp((s) => s.versions);
  const plan = useApp((s) => s.plan);
  const issues = useApp((s) => s.issues);
  const list = useApp((s) => s.listView), reduced = useApp((s) => s.reduced), paused = useApp((s) => s.motionPaused), hud = useApp((s) => s.hud);
  const [ops, setOps] = useState(false);
  const faults = useApp((s) => s.faults), stress = useApp((s) => s.stress);
  return (
    <header className="topbar">
      <div className="brand"><b>SYNAPSE</b><span className="badge" title="Models, tools and data are simulators in this repository">SIMULATED PROVIDERS</span></div>
      <span className={`pill ${plan ? "ok" : "bad"}`} role="status">{plan ? `● compiled · ${plan.steps.length} steps · ${plan.levels} levels` : `▲ ${issues[0]?.message ?? "empty workflow"}`}</span>
      <label className="ver">Version <select value={version} onChange={(e) => useVersion(+e.target.value)}>{Object.keys(versions).map((v) => <option key={v} value={v}>v{v}</option>)}{!versions[version] ? <option value={version}>v{version} (draft)</option> : null}</select></label>
      <nav aria-label="View controls">
        <button onClick={() => set({ palette: true })}>Search <kbd>⌘K</kbd></button>
        <button aria-pressed={list} onClick={() => set({ listView: !list })}>List view</button>
        <button aria-pressed={reduced} onClick={() => set({ reduced: !reduced })}>Reduced motion</button>
        <button aria-pressed={paused} onClick={() => set({ motionPaused: !paused })}>{paused ? "Resume motion" : "Pause motion"}</button>
        <button aria-pressed={hud} onClick={() => set({ hud: !hud })}>Telemetry</button>
        <button onClick={() => set({ help: true })}>Keys</button>
        <div className="menu">
          <button aria-expanded={ops} onClick={() => setOps(!ops)}>Failure lab ▾</button>
          {ops ? (
            <div className="menu-pop" role="menu">
              <button role="menuitemcheckbox" aria-checked={faults.crmFlaky} onClick={() => { setOps(false); set((s) => ({ faults: { ...s.faults, crmFlaky: !s.faults.crmFlaky } })); }}>CRM times out on the first call</button>
              <button role="menuitemcheckbox" aria-checked={faults.atlasDown} onClick={() => { setOps(false); set((s) => ({ faults: { ...s.faults, atlasDown: !s.faults.atlasDown } })); }}>Atlas AI is down (500s)</button>
              <button role="menuitemcheckbox" aria-checked={faults.rateLimitStorm} onClick={() => { setOps(false); set((s) => ({ faults: { ...s.faults, rateLimitStorm: !s.faults.rateLimitStorm } })); }}>Rate-limit storm (429 on first call)</button>
              <button role="menuitemcheckbox" aria-checked={stress} onClick={() => { setOps(false); set({ stress: !stress }); }}>{stress ? "Back to the workflow" : "Stress: 2,000 nodes, 5,000 edges"}</button>
            </div>
          ) : null}
        </div>
      </nav>
    </header>
  );
}

export function Palette() {
  const wf = useApp((s) => s.wf);
  const selected = useApp((s) => s.selected);
  const emailId = useApp((s) => s.emailId);
  const emails = useApp((s) => s.emails);
  const plan = useApp((s) => s.plan);
  const [target, setTarget] = useState("");
  const have = (t: NodeType) => wf.nodes.some((n) => n.type === t);
  const wanted: [string, string][] = [["trigger", "pii"], ["pii", "classify"], ["pii", "crm"], ["classify", "kb"], ["classify", "draft"], ["kb", "draft"], ["crm", "draft"]];
  const linked = (a: string, b: string) => wf.edges.some((e) => e.from === a && e.to === b);
  return (
    <aside className="panel left" aria-label="Builder">
      <h2>Node palette</h2>
      <p className="muted small">Drag onto the canvas, or press a button to place it.</p>
      <ul className="nodepal">
        {PALETTE.map((t) => (
          <li key={t}>
            <button draggable onDragStart={(e) => e.dataTransfer.setData("text/node-type", t)} onClick={() => addNode(t)} aria-label={`Add ${NODE_SPECS[t].title}`} className={`pal kind-${NODE_SPECS[t].kind}`}>
              <span>{NODE_SPECS[t].title}</span>{have(t) ? <small>✓ placed</small> : null}
            </button>
          </li>
        ))}
      </ul>
      <h3>Build the support workflow</h3>
      <ol className="checklist">
        <li className={PALETTE.every(have) ? "done" : ""}>Place the six nodes ({PALETTE.filter(have).length}/6)</li>
        <li className={wanted.every(([a, b]) => linked(a, b)) ? "done" : ""}>Connect them ({wanted.filter(([a, b]) => linked(a, b)).length}/7): drag from a node&apos;s right edge, or select one and pick a target below</li>
        <li className={plan ? "done" : ""}>It compiles</li>
      </ol>
      {selected.length === 1 ? (
        <div className="row">
          <label>Connect {selected[0]} to <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Connection target"><option value="">…</option>{wf.nodes.filter((n) => n.id !== selected[0]).map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}</select></label>
          <button disabled={!target} onClick={() => { connect(selected[0], target); setTarget(""); }}>Connect</button>
        </div>
      ) : null}
      {selected.length > 1 ? <div className="row"><button onClick={() => groupSelected("triage")}>Group {selected.length} nodes</button></div> : null}
      {selected.length ? <div className="row"><button onClick={() => removeSelected()}>Delete selected</button></div> : null}
      <div className="row">
        <button onClick={() => { loadTemplate(); setTimeout(() => fit(get().wf), 0); }}>Do it for me (template)</button>
        <button onClick={() => fit(get().wf)}>Fit view</button>
      </div>
      <h3>Input</h3>
      <label className="block">E-mail <select value={emailId} onChange={(e) => set({ emailId: e.target.value })}>{emails.slice(0, 30).map((e) => <option key={e.id} value={e.id}>{e.id === "sample" ? "Sample: charged twice" : `${e.id} · ${e.label}`}</option>)}</select></label>
      <pre className="email">{emails.find((e) => e.id === emailId)?.body}</pre>
      <NodeList />
    </aside>
  );
}

/** Keyboard route to every node (the canvas itself is pointer-driven). */
function NodeList() {
  const wf = useApp((s) => s.wf);
  if (!wf.nodes.length || wf.nodes.length > 50) return null;
  return (
    <>
      <h3>Nodes</h3>
      <ul className="mini">{wf.nodes.map((n) => <li key={n.id}><button onClick={() => inspect(n.id)}>{n.label} <small>{n.id}</small></button></li>)}</ul>
    </>
  );
}

export function Actions() {
  const plan = useApp((s) => s.plan);
  const run = useApp((s) => s.run);
  const versions = useApp((s) => s.versions);
  const playing = useApp((s) => s.playing);
  const [swap, setSwap] = useState("nova-pro");
  const nv = Object.keys(versions).length;
  return (
    <div className="actions" role="toolbar" aria-label="Run">
      <button className="primary" disabled={!plan} onClick={() => runNow()}>Run on e-mail</button>
      <button disabled={!run} onClick={() => replay()}>Replay</button>
      <button disabled={!run} onClick={() => { playback.t = 0; set({ playing: true }); }}>{playing ? "Playing…" : "Play trace"}</button>
      <label>Swap model to <select value={swap} onChange={(e) => setSwap(e.target.value)}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>)}<option value="auto">Router (auto)</option></select></label>
      <button disabled={!plan} onClick={() => swapProvider(swap, swap === "auto" ? "atlas-mini" : swap.startsWith("nova") ? "nova-lite" : "atlas-mini")}>Swap and rerun</button>
      <button disabled={nv < 2} onClick={() => compare()}>Compare versions</button>
      <button disabled={!plan} onClick={() => { set({ publishOpen: true }); send({ type: "PUBLISH" }); }}>Publish as API</button>
    </div>
  );
}

const statusText = (s: StepRecord) => s.status === "error" ? "failed" : s.status === "cached" ? "cache hit" : s.attempts.length > 1 ? `ok after ${s.attempts.length} attempts` : "ok";

export function Inspector() {
  const id = useApp((s) => s.inspect);
  const view = useApp((s) => s.view);
  const node = useApp((s) => s.wf.nodes.find((n) => n.id === s.inspect) ?? null);
  const step = useApp((s) => s.run?.steps.find((x) => x.nodeId === s.inspect) ?? null);
  const ref = useRef<HTMLElement>(null);
  const reduced = useApp((s) => s.reduced);
  // shared-element transition: the inspector grows out of the node that was clicked
  useEffect(() => {
    if (!id || !ref.current || reduced) return;
    const r = nodeScreenRect(id), box = ref.current.getBoundingClientRect();
    if (!r) return;
    const canvas = document.querySelector(".graph")!.getBoundingClientRect();
    const dx = canvas.left + r.x - box.left, dy = canvas.top + r.y - box.top;
    ref.current.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${r.w / box.width}, ${r.h / box.height})`, opacity: 0.4 }, { transform: "none", opacity: 1 }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
  }, [id, reduced]);
  if (view !== "inspect" || !node) return null;
  const isLlm = node.type.startsWith("llm.");
  return (
    <aside className="panel right" ref={ref} aria-label="Inspector">
      <p className="kicker">{NODE_SPECS[node.type].title}</p>
      <h2>{node.label} <small>{node.id}</small></h2>
      {isLlm ? <LlmConfig id={node.id} cfg={node.config} /> : null}
      {node.type === "tool.crm" ? <p className="small">Credentials: <code>{String(node.config.secretRef)}</code>, resolved inside the runtime; the value never reaches the browser trace or the logs.</p> : null}
      {step ? (
        <section aria-label="Last step">
          <h3>Last run: {statusText(step)}</h3>
          <dl className="kv">
            <dt>Started / took</dt><dd>{ms(step.startMs)} / {ms(step.latencyMs)}</dd>
            {step.model ? <><dt>Model</dt><dd>{step.model} ({step.provider})</dd></> : null}
            <dt>Tokens in / out</dt><dd>{num(step.tokenIn)} / {num(step.tokenOut)}</dd>
            <dt>Cost</dt><dd>{usd(step.costUsd)}</dd>
            {step.note ? <><dt>Note</dt><dd>{step.note}</dd></> : null}
            {step.error ? <><dt>Error</dt><dd className="bad">{step.error}</dd></> : null}
          </dl>
          <h3>Attempts</h3>
          <table className="attempts">
            <thead><tr><th scope="col">#</th><th scope="col">What</th><th scope="col">Result</th><th scope="col">Wait</th><th scope="col">Took</th></tr></thead>
            <tbody>{step.attempts.length ? step.attempts.map((a) => (
              <tr key={a.n} className={a.status !== 200 || a.error ? "warn" : ""}><td>{a.n}</td><td>{a.kind}{a.model ? ` · ${a.model}` : ""}</td><td>{a.error ?? a.status}</td><td>{a.backoffMs ? ms(a.backoffMs) : "–"}</td><td>{ms(a.latencyMs)}</td></tr>
            )) : <tr><td colSpan={5}>no external call</td></tr>}</tbody>
          </table>
          <details><summary>Input (redacted)</summary><pre>{step.input}</pre></details>
          <details><summary>Output</summary><pre>{step.output}</pre></details>
        </section>
      ) : <p className="muted">Run the workflow to see this step&apos;s trace.</p>}
      <button className="ghost" onClick={() => inspect(null)}>Close</button>
    </aside>
  );
}

function LlmConfig({ id, cfg }: { id: string; cfg: Record<string, unknown> }) {
  const base = id.startsWith("classify") ? CLASSIFY_PROMPT : DRAFT_PROMPT;
  const [draft, setDraft] = useState(String(cfg.prompt ?? ""));
  useEffect(() => setDraft(String(cfg.prompt ?? "")), [cfg.prompt]);
  const diff = useMemo(() => lineDiff(base, draft), [base, draft]);
  return (
    <div>
      <label className="block">Model <select value={String(cfg.model)} onChange={(e) => setConfig(id, { model: e.target.value })}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}<option value="auto">Router (auto)</option></select></label>
      <label className="block">Fallback <select value={String(cfg.fallback ?? "")} onChange={(e) => setConfig(id, { fallback: e.target.value || undefined })}><option value="">none</option>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      {cfg.model !== "auto" ? <p className="small muted">{model(String(cfg.model)).label}: ${model(String(cfg.model)).inPerM}/${model(String(cfg.model)).outPerM} per million tokens in/out (simulated price list)</p> : null}
      <label className="block">Prompt <textarea rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setConfig(id, { prompt: draft })} /></label>
      {diff.some((d) => d.op !== " ") ? <pre className="diff" aria-label="Prompt changes against v1">{diff.map((d, i) => <span key={i} className={d.op === "+" ? "add" : d.op === "-" ? "del" : ""}>{d.op} {d.line}{"\n"}</span>)}</pre> : <p className="small muted">Prompt unchanged from v1.</p>}
    </div>
  );
}

export function TracePanel() {
  useTick();
  const run = useApp((s) => s.run);
  const rate = useApp((s) => s.rate);
  if (!run) return <footer className="trace empty"><p className="muted">No run yet. Build or load the workflow, then press <b>Run on e-mail</b>.</p></footer>;
  const T = run.totalLatencyMs, x = (t: number) => (t / T) * 100;
  const maxCost = Math.max(...run.steps.map((s) => s.costUsd), 1e-12);
  return (
    <footer className="trace" aria-label="Trace">
      <div className="trace-head">
        <b>Run {run.id.slice(4, 12)}</b>
        <span className={run.status === "succeeded" ? "ok" : "bad"}>{run.status}</span>
        <span>{ms(T)} end to end</span><span>{usd(run.totalCostUsd)}</span><span>{num(run.tokens.in)} / {num(run.tokens.out)} tokens</span>
        <span>{run.retries} retries · {run.repairs} repairs · {run.fallbacks} fallbacks</span>
        <label>Playback <select value={rate} onChange={(e) => set({ rate: +e.target.value })}>{[0.25, 0.5, 1, 2].map((r) => <option key={r} value={r}>{r}×</option>)}</select></label>
        <input type="range" aria-label="Trace time" min={0} max={T} value={Math.round(playback.t)} onChange={(e) => { playback.t = +e.target.value; set({ playing: false }); window.dispatchEvent(new CustomEvent("synapse:tick")); }} />
        <output>{ms(playback.t)}</output>
      </div>
      <div className="waterfall" role="table" aria-label="Trace waterfall">
        {run.steps.map((s) => (
          <div key={s.nodeId} className="wf-row" role="row">
            <span role="cell"><button className="wf-name" onClick={() => inspect(s.nodeId)}>{s.label}</button></span>
            <div role="cell" className="wf-track" aria-label={`${s.label}: starts ${ms(s.startMs)}, takes ${ms(s.latencyMs)}, ${statusText(s)}`}>
              {s.attempts.length ? s.attempts.map((a) => <span key={a.n} className={`wf-bar ${a.status !== 200 || a.error ? "err" : "ok"}`} style={{ left: `${x(a.startMs)}%`, width: `${Math.max(0.3, x(a.latencyMs))}%` }} title={`${a.kind} ${a.error ?? a.status}`} />)
                : <span className="wf-bar ok" style={{ left: `${x(s.startMs)}%`, width: `${Math.max(0.3, x(s.latencyMs))}%` }} />}
              {s.attempts.filter((a) => a.backoffMs).map((a) => <span key={`b${a.n}`} className="wf-bar wait" style={{ left: `${x(a.startMs - a.backoffMs)}%`, width: `${x(a.backoffMs)}%` }} title={`backoff ${a.backoffMs} ms`} />)}
            </div>
            <span role="cell" className="wf-cost" title="cost (flame width)"><i style={{ width: `${(s.costUsd / maxCost) * 100}%` }} />{s.costUsd ? usd(s.costUsd) : "–"}</span>
          </div>
        ))}
        <div className="wf-cursor" style={{ left: `calc(150px + (100% - 270px) * ${playback.t / T})` }} aria-hidden />
      </div>
    </footer>
  );
}

export function ComparePanel() {
  const view = useApp((s) => s.view);
  const ev = useApp((s) => s.evals);
  const busy = useApp((s) => s.evaluating);
  if (view !== "compare") return null;
  if (busy || !ev) return <aside className="panel right wide" aria-label="Comparison"><p role="status">Evaluating both versions on the labeled e-mails…</p></aside>;
  const { a, b } = ev;
  const row = (label: string, f: (s: typeof a) => string, better?: (x: typeof a, y: typeof a) => boolean) => (
    <tr><th scope="row">{label}</th><td>{f(a)}</td><td className={better ? (better(b, a) ? "good" : "bad") : ""}>{f(b)}</td></tr>
  );
  const cats = Object.keys(a.byCategory);
  return (
    <aside className="panel right wide" aria-label="Comparison">
      <h2>{a.version} vs {b.version} <small>{a.n} labeled e-mails each · {Math.round(ev.ms)} ms</small></h2>
      <table className="cmp">
        <thead><tr><th /><th scope="col">{a.version}</th><th scope="col">{b.version}</th></tr></thead>
        <tbody>
          {row("Pass rate (all checks)", (s) => pct(s.passRate), (x, y) => x.passRate >= y.passRate)}
          {row("Category accuracy", (s) => pct(s.accuracy), (x, y) => x.accuracy >= y.accuracy)}
          {row("Facts in reply", (s) => pct(s.factsRecall), (x, y) => x.factsRecall >= y.factsRecall)}
          {row("Latency p50 / p95", (s) => `${ms(s.latencyP50)} / ${ms(s.latencyP95)}`, (x, y) => x.latencyP95 <= y.latencyP95)}
          {row("Cost per 1,000 runs", (s) => `$${(s.costPerRun * 1000).toFixed(2)}`, (x, y) => x.costPerRun <= y.costPerRun)}
          {row("Repairs / retries / fallbacks", (s) => `${s.repairs} / ${s.retries} / ${s.fallbacks}`)}
          {row("Judge mean (1–5)", (s) => s.judgeMean.toFixed(2))}
        </tbody>
      </table>
      <h3>Accuracy by category</h3>
      <div className="cats">{cats.map((c) => (
        <div key={c} className="cat"><span>{c}</span>
          <i className="bar a" style={{ width: `${a.byCategory[c].accuracy * 100}%` }} title={`${a.version} ${pct(a.byCategory[c].accuracy)}`} />
          <i className="bar b" style={{ width: `${(b.byCategory[c]?.accuracy ?? 0) * 100}%` }} title={`${b.version} ${pct(b.byCategory[c]?.accuracy ?? 0)}`} />
          <small>{pct(a.byCategory[c].accuracy)} → {pct(b.byCategory[c]?.accuracy ?? 0)}</small></div>
      ))}</div>
      <h3>Release gate: <span className={ev.gate.pass ? "good" : "bad"}>{ev.gate.pass ? "passes" : "blocks"} {b.version}</span></h3>
      <ul className="gate">{ev.gate.rules.map((r) => <li key={r.name} className={r.ok ? "good" : "bad"}>{r.ok ? "✓" : "✗"} {r.name} <small>({r.detail})</small></li>)}</ul>
      <h3>Regression matrix <small>each square is one e-mail: filled = passed</small></h3>
      <div className="matrix" role="img" aria-label={`${a.version} passed ${a.cases.filter((c) => c.pass).length}, ${b.version} passed ${b.cases.filter((c) => c.pass).length}; ${a.cases.filter((c, i) => c.pass && !b.cases[i].pass).length} e-mails pass only in ${a.version}`}>
        {[a, b].map((s) => <div key={s.version} className="mrow"><span>{s.version}</span>{s.cases.map((c, i) => <i key={c.emailId} className={`${c.pass ? "p" : "f"} ${c.pass !== (s === a ? b : a).cases[i].pass ? "diff" : ""}`} title={`${c.emailId} ${c.label}: ${c.pass ? "pass" : `fail (${!c.categoryOk ? `said ${c.predicted}` : c.factsFound < c.factsTotal ? "missing a fact" : "other"})`}`} />)}</div>)}
      </div>
      <h3>Evaluators</h3>
      <p className="small">Simulated LLM judge vs the deterministic checks: agreement {pct(ev.calib.agreementAt4)} at score ≥ 4; it passes {pct(ev.calib.table[4] ?? 0)} of the replies it scores 4. Calibrated on half the cases, Brier score {ev.calib.brierRaw.toFixed(3)} → {ev.calib.brierCalibrated.toFixed(3)} on the other half.</p>
      <p className="small">Experiment over {num(ev.exp.requests)} requests: a Thompson-sampling bandit sent {pct(ev.exp.shareB)} to {b.version} and passed {pct(ev.exp.banditPassRate)}; a 50/50 A/B split passed {pct(ev.exp.abPassRate)}.</p>
      <p className="small">Semantic cache (threshold {ev.cache.threshold}): on classification only, {ev.cache.classifyOnly.hits} hits and 0 wrong order numbers; on drafts too, {ev.cache.allSteps.hits} hits and <b>{ev.cache.allSteps.wrongOrder} replies quoting another customer&apos;s order</b>. The cache stays on classification only.</p>
      <p className="muted small">The quality differences come from the simulated models&apos; settings: this shows the harness, not real models.</p>
      <button className="ghost" onClick={() => send({ type: "BACK" })}>Back to the canvas</button>
    </aside>
  );
}

export function PublishDialog() {
  const open = useApp((s) => s.publishOpen);
  const versions = useApp((s) => s.versions);
  const pub = useApp((s) => s.published);
  const err = useApp((s) => s.publishError);
  const ev = useApp((s) => s.evals);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current!; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); const c = () => { set({ publishOpen: false }); send({ type: "BACK" }); }; d.addEventListener("close", c); return () => d.removeEventListener("close", c); }, [open]);
  const vs = Object.keys(versions).map(Number);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="pub-title">
      <h2 id="pub-title">Publish as an API endpoint</h2>
      <p className="small">{ev ? `Release gate on the last comparison: ${ev.gate.pass ? "passes" : `blocks ${ev.b.version}`}.` : "Compare versions first to run the release gate."}</p>
      <div className="row">{vs.map((v) => <button key={v} onClick={() => publish(v)}>Publish v{v}</button>)}</div>
      {err ? <ul className="errors" role="alert">{err.map((e) => <li key={e}>Blocked: {e}</li>)}</ul> : null}
      {pub ? (
        <div role="status">
          <p>Published <b>v{pub.version}</b>.</p>
          <pre className="code">{`curl -X POST ${pub.url} \\\n  -H "Authorization: Bearer ${pub.keyHint}" \\\n  -H "Idempotency-Key: $(uuidgen)" \\\n  -d '{"subject":"…","body":"…"}'`}</pre>
          <p className="muted small">{get().apiMode ? "The key is shown once and stored hashed." : "Public sandbox: nothing is deployed; the Docker stack creates a real endpoint with a hashed key."}</p>
        </div>
      ) : null}
      <button onClick={() => set({ publishOpen: false })}>Close</button>
    </dialog>
  );
}

export type { AppState };
