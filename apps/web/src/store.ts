// Application state, the source of truth. The canvas animates what is here (graph, run trace, playback time); it never decides.
import { useSyncExternalStore } from "react";
import {
  compile, supportWorkflow, run, handoffs, evaluate, gate, calibrateJudge, experiment, cacheExperiment, makeEmails, demoSecrets, SAMPLE_EMAIL, SAMPLE_FAULTS,
  NODE_SPECS, model, type Workflow, type WfNode, type NodeType, type CompileIssue, type Plan, type RunResult, type EvalSummary, type Email, type Faults,
} from "@synapse/domain";
import { next, type JourneyEvent, type View } from "./journey.ts";
import { makeProvider, type DataProvider } from "./provider.ts";

export interface Evals { a: EvalSummary; b: EvalSummary; gate: ReturnType<typeof gate>; calib: ReturnType<typeof calibrateJudge>; exp: ReturnType<typeof experiment>; cache: ReturnType<typeof cacheExperiment>; ms: number }
export interface Published { version: number; slug: string; url: string; keyHint: string; at: number }

export interface AppState {
  view: View;
  wf: Workflow;
  versions: Record<number, Workflow>;
  version: number;
  selected: string[];
  inspect: string | null;
  plan: Plan | null;
  issues: CompileIssue[];
  run: RunResult | null;
  runs: Record<number, RunResult>;
  emailId: string;
  emails: Email[];
  faults: { atlasDown: boolean; crmFlaky: boolean; rateLimitStorm: boolean };
  playing: boolean;
  rate: number;
  evals: Evals | null;
  evaluating: boolean;
  published: Published | null;
  publishOpen: boolean;
  publishError: string[] | null;
  listView: boolean;
  reduced: boolean;
  motionPaused: boolean;
  hud: boolean;
  palette: boolean;
  help: boolean;
  stress: boolean;
  announce: string;
  apiMode: boolean;
}

const empty: Workflow = { id: "wf-support", name: "Support triage and reply", version: 1, nodes: [], edges: [] };
const initial: AppState = {
  view: "intro0", wf: empty, versions: {}, version: 1, selected: [], inspect: null, plan: null, issues: [], run: null, runs: {},
  emailId: "sample", emails: [], faults: { atlasDown: false, crmFlaky: true, rateLimitStorm: false }, playing: false, rate: 1,
  evals: null, evaluating: false, published: null, publishOpen: false, publishError: null, listView: false, reduced: false, motionPaused: false,
  hud: false, palette: false, help: false, stress: false, announce: "", apiMode: false,
};

let state: AppState = initial;
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s();
}
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state), () => sel(initial));
}
export const send = (e: JourneyEvent) => set((s) => ({ view: next(s.view, e) }));
export const say = (announce: string) => set({ announce });
export const provider: DataProvider = makeProvider();
export const secrets = demoSecrets(); // in the static sandbox the "secret store" is this page's memory; the API keeps its own

/** Playback clock in trace milliseconds (advanced per frame by the canvas while playing). */
export const playback = { t: 0, lastSync: 0 };

function recompile(wf: Workflow) {
  const { plan, issues } = compile(wf);
  return { wf, plan, issues };
}

export function init() {
  set({ emails: [SAMPLE_EMAIL, ...makeEmails()], apiMode: provider.kind === "api" });
}

// ---------- editing ----------
const BASE: Partial<Record<NodeType, [string, string]>> = { "trigger.email": ["trigger", "Email received"], "policy.pii": ["pii", "PII filter"], "llm.classify": ["classify", "Classify"], "tool.crm": ["crm", "Look up order"], "retrieval.kb": ["kb", "Search help articles"], "llm.draft": ["draft", "Draft reply"] };
const nid = (type: NodeType, wf: Workflow) => { const base = BASE[type]?.[0] ?? type.split(".")[1]; let i = 1; while (wf.nodes.some((n) => n.id === `${base}${i === 1 ? "" : i}`)) i++; return `${base}${i === 1 ? "" : i}`; };
const DEFAULT_CONFIG: Partial<Record<NodeType, Record<string, unknown>>> = {
  "llm.classify": supportWorkflow().nodes.find((n) => n.id === "classify")!.config,
  "llm.draft": supportWorkflow().nodes.find((n) => n.id === "draft")!.config,
  "tool.crm": { secretRef: "secret://crm-api-key", timeoutMs: 2500 },
  "retrieval.kb": { k: 2 },
  "policy.pii": { kinds: ["email", "phone", "card"] },
};
const SLOTS: Partial<Record<NodeType, [number, number]>> = { "trigger.email": [0, 160], "policy.pii": [260, 160], "llm.classify": [520, 40], "tool.crm": [520, 290], "retrieval.kb": [780, 40], "llm.draft": [1040, 160] };

export function addNode(type: NodeType, at?: [number, number]) {
  const wf = state.wf;
  const id = nid(type, wf);
  const [x, y] = at ?? SLOTS[type] ?? [wf.nodes.length * 60, 420];
  const node: WfNode = { id, type, label: BASE[type]?.[1] ?? NODE_SPECS[type].title, x, y, config: structuredClone(DEFAULT_CONFIG[type] ?? {}) };
  set({ ...recompile({ ...wf, nodes: [...wf.nodes, node] }), selected: [id] });
  say(`Added ${node.label}.`);
  return id;
}
export function connect(from: string, to: string) {
  const wf = state.wf;
  if (from === to || wf.edges.some((e) => e.from === from && e.to === to)) return;
  let k = wf.edges.length + 1; while (wf.edges.some((e) => e.id === `e${k}`)) k++;
  set(recompile({ ...wf, edges: [...wf.edges, { id: `e${k}`, from, to }] }));
  say(`Connected ${from} to ${to}.`);
}
export function removeSelected() {
  const del = new Set(state.selected);
  if (!del.size) return;
  const wf = state.wf;
  set({ ...recompile({ ...wf, nodes: wf.nodes.filter((n) => !del.has(n.id)), edges: wf.edges.filter((e) => !del.has(e.from) && !del.has(e.to)) }), selected: [], inspect: null });
}
export function moveNode(id: string, x: number, y: number) {
  set((s) => ({ wf: { ...s.wf, nodes: s.wf.nodes.map((n) => (n.id === id ? { ...n, x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 } : n)) } }));
}
export function groupSelected(name: string) {
  const ids = new Set(state.selected);
  set((s) => ({ wf: { ...s.wf, nodes: s.wf.nodes.map((n) => (ids.has(n.id) ? { ...n, group: name } : n)) } }));
}
export function setConfig(id: string, patch: Record<string, unknown>) {
  const wf = state.wf;
  set(recompile({ ...wf, nodes: wf.nodes.map((n) => (n.id === id ? { ...n, config: { ...n.config, ...patch } } : n)) }));
}
export function loadTemplate() {
  const wf = supportWorkflow("atlas-large", 1);
  set({ ...recompile(wf), versions: { 1: wf }, version: 1, selected: [], inspect: null, run: null, runs: {}, evals: null, published: null });
  say("Loaded the six-node support workflow.");
}
export function select(ids: string[]) { set({ selected: ids }); }
export function inspect(id: string | null) {
  set({ inspect: id, selected: id ? [id] : [] });
  send({ type: id ? "INSPECT" : "BACK" });
}

// ---------- running ----------
export function faultsNow(email: Email): Faults {
  const f = state.faults;
  const forced: Record<string, number | "timeout" | "malformed"> = {};
  if (f.crmFlaky && email.id === "sample") Object.assign(forced, SAMPLE_FAULTS.forced);
  if (f.rateLimitStorm) for (const n of state.wf.nodes) if (n.type.startsWith("llm.")) forced[`${email.id}:${n.id}:${String(n.config.model)}#1`] = 429;
  return { forced, providerDown: f.atlasDown ? ["Atlas AI"] : [] };
}

export async function runNow(opts: { replayOf?: RunResult } = {}) {
  const s = state;
  if (!s.plan) { say(`Cannot run: ${s.issues[0]?.message ?? "the workflow is empty"}.`); return null; }
  const email = s.emails.find((e) => e.id === s.emailId) ?? SAMPLE_EMAIL;
  // the API mode runs on the server; the static sandbox runs the same runtime here
  const r = provider.kind === "api" ? await provider.run(s.wf, email, faultsNow(email)) : run(s.wf, email, { secrets, faults: faultsNow(email), truth: email });
  if (opts.replayOf && JSON.stringify(opts.replayOf.steps) !== JSON.stringify(r.steps)) say("Replay differs from the original run.");
  playback.t = 0;
  set((x) => ({ run: r, runs: { ...x.runs, [x.wf.version]: r }, playing: !x.reduced, version: x.wf.version, versions: { ...x.versions, [x.wf.version]: x.wf } }));
  if (s.reduced) playback.t = r.totalLatencyMs;
  const failed = r.steps.filter((x) => x.attempts.some((a) => a.status !== 200 || a.error));
  say(`Run ${r.status}: ${r.steps.length} steps, ${(r.totalLatencyMs / 1000).toFixed(2)} seconds, $${r.totalCostUsd.toFixed(5)}. ${failed.length ? `${failed.map((f) => f.label).join(", ")} needed a retry or fallback.` : ""}`);
  return r;
}
export const replay = () => (state.run ? runNow({ replayOf: state.run }) : null);
export const edgesTimed = () => (state.run ? handoffs(state.wf, state.run) : []);

/** Swap every model in the workflow for another provider's (a new version), then run it. */
export function swapProvider(modelId: string, fallback: string) {
  const s = state;
  const v = Math.max(1, ...Object.keys(s.versions).map(Number)) + 1;
  const wf: Workflow = { ...s.wf, version: v, nodes: s.wf.nodes.map((n) => (n.type.startsWith("llm.") ? { ...n, config: { ...n.config, model: modelId, fallback } } : n)) };
  set({ ...recompile(wf), versions: { ...s.versions, [v]: wf }, version: v });
  say(`Version ${v}: every model call now uses ${modelId === "auto" ? "the router" : model(modelId).label}, falling back to ${model(fallback).label}.`);
  return runNow();
}
export function useVersion(v: number) {
  const wf = state.versions[v];
  if (!wf) return;
  set((s) => ({ ...recompile(wf), version: v, run: s.runs[v] ?? null }));
  playback.t = state.run?.totalLatencyMs ?? 0;
}

export async function compare() {
  const s = state;
  const vs = Object.keys(s.versions).map(Number).sort();
  if (vs.length < 2) return;
  set({ evaluating: true });
  send({ type: "COMPARE" });
  await new Promise((r) => setTimeout(r, 30)); // let the panel paint "evaluating"
  const t0 = performance.now();
  const emails = s.emails.filter((e) => e.id !== "sample");
  const a = evaluate(s.versions[vs[0]], emails, { secrets, label: `v${vs[0]}` });
  const b = evaluate(s.versions[vs.at(-1)!], emails, { secrets, label: `v${vs.at(-1)}` });
  const evals: Evals = { a, b, gate: gate(a, b), calib: calibrateJudge([...a.cases, ...b.cases]), exp: experiment(a, b), cache: cacheExperiment(s.versions[vs[0]], emails, secrets), ms: performance.now() - t0 };
  if (provider.evaluate) { for (const v of vs) await provider.run(s.versions[v], SAMPLE_EMAIL, {}); await provider.evaluate(s.versions[vs[0]], [vs[0], vs.at(-1)!]); } // registers both versions server-side
  set({ evals, evaluating: false });
  say(`Evaluated ${emails.length} e-mails per version. Pass rate ${(a.passRate * 100).toFixed(1)}% versus ${(b.passRate * 100).toFixed(1)}%. Release gate ${evals.gate.pass ? "passes" : "fails"}.`);
}

export async function publish(version: number) {
  const s = state;
  if (s.evals && version === Number(s.evals.b.version.slice(1)) && !s.evals.gate.pass) {
    set({ publishError: s.evals.gate.rules.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`) });
    say("Publishing blocked by the release gate.");
    return null;
  }
  let res;
  try { res = await provider.publish(s.versions[version] ?? s.wf); }
  catch (e) {
    const d = (e as { details?: { name: string; detail: string }[] }).details;
    set({ publishError: d?.map((r) => `${r.name}: ${r.detail}`) ?? [(e as Error).message] });
    return null;
  }
  set({ published: { version, slug: res.slug, url: res.url, keyHint: res.keyHint, at: Date.now() }, publishError: null });
  say(`Version ${version} published at ${res.url}.`);
  return res;
}
