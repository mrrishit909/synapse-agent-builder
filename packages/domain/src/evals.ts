// Evaluation: run a workflow version over the labeled e-mails and score every reply with an ensemble of evaluators
// (deterministic assertions, embedding similarity to a reference reply, a simulated LLM judge with calibration). Then compare
// versions, gate a release on regressions, and run A/B or bandit experiments. The quality differences measured here are the
// ones written into the simulated models (providers.ts): this demonstrates the harness, not any real model.
import type { Workflow } from "./graph.ts";
import { CATEGORIES, KB, cosine, draw, embed, type Category } from "./providers.ts";
import { containsPii, type Email, type SecretStore } from "./data.ts";
import { run, SemanticCache, type RunOptions, type RunResult } from "./runtime.ts";

export interface CaseResult {
  emailId: string; label: Category; predicted?: Category; categoryOk: boolean; factsFound: number; factsTotal: number;
  similarity: number; judge: number; noPii: boolean; pass: boolean; latencyMs: number; costUsd: number; retries: number; repairs: number; fallbacks: number; cached: boolean; status: string;
}
export interface EvalSummary {
  version: string; n: number; passRate: number; accuracy: number; factsRecall: number; meanSimilarity: number; judgeMean: number;
  byCategory: Record<string, { n: number; accuracy: number }>; latencyP50: number; latencyP95: number; costPerRun: number;
  retries: number; repairs: number; fallbacks: number; cacheHits: number; failedRuns: number; cases: CaseResult[];
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const reference = (e: Email) => `Thanks for getting in touch. ${e.facts.map((f) => `Regarding ${f}: we have looked into it.`).join(" ")} Our team will follow up within one business day.`;

/** Simulated LLM judge (1-5). Like real judges it is lenient: it rates many failing replies 4. */
export function judge(reply: string | undefined, pass: boolean, key: string) {
  if (!reply) return 1;
  const u = draw("judge", key);
  return pass ? (u < 0.9 ? 5 : 4) : u < 0.45 ? 4 : u < 0.8 ? 3 : 2;
}

export function evaluate(wf: Workflow, emails: Email[], o: Omit<RunOptions, "truth"> & { label?: string }): EvalSummary {
  const cases: CaseResult[] = [];
  for (const e of emails) {
    const r: RunResult = run(wf, e, { ...o, truth: e, runId: `eval-${e.id}` });
    const reply = r.output.reply ?? "";
    const factsFound = e.facts.filter((f) => reply.includes(f)).length;
    const categoryOk = r.output.category === e.label;
    const noPii = !containsPii(reply);
    const pass = r.status === "succeeded" && categoryOk && factsFound === e.facts.length && noPii;
    cases.push({ emailId: e.id, label: e.label, predicted: r.output.category, categoryOk, factsFound, factsTotal: e.facts.length, similarity: +cosine(embed(reply), embed(reference(e))).toFixed(3),
      judge: judge(reply, pass, `${o.label ?? ""}:${e.id}`), noPii, pass, latencyMs: r.totalLatencyMs, costUsd: r.totalCostUsd, retries: r.retries, repairs: r.repairs, fallbacks: r.fallbacks, cached: r.cacheHits > 0, status: r.status });
  }
  const byCategory: EvalSummary["byCategory"] = {};
  for (const c of CATEGORIES) { const xs = cases.filter((x) => x.label === c); if (xs.length) byCategory[c] = { n: xs.length, accuracy: xs.filter((x) => x.categoryOk).length / xs.length }; }
  const mean = (f: (c: CaseResult) => number) => cases.reduce((s, c) => s + f(c), 0) / cases.length;
  return {
    version: o.label ?? wf.name, n: cases.length, passRate: mean((c) => +c.pass), accuracy: mean((c) => +c.categoryOk), factsRecall: cases.reduce((s, c) => s + c.factsFound, 0) / cases.reduce((s, c) => s + c.factsTotal, 0),
    meanSimilarity: mean((c) => c.similarity), judgeMean: mean((c) => c.judge), byCategory, latencyP50: q(cases.map((c) => c.latencyMs), 0.5), latencyP95: q(cases.map((c) => c.latencyMs), 0.95),
    costPerRun: mean((c) => c.costUsd), retries: cases.reduce((s, c) => s + c.retries, 0), repairs: cases.reduce((s, c) => s + c.repairs, 0), fallbacks: cases.reduce((s, c) => s + c.fallbacks, 0),
    cacheHits: cases.filter((c) => c.cached).length, failedRuns: cases.filter((c) => c.status !== "succeeded").length, cases,
  };
}

export interface GateRule { name: string; ok: boolean; detail: string }
/** Release gate: the candidate may not drop pass rate by more than 2 points, drop any category by more than 5, or slow p95 by over 25%. */
export function gate(base: EvalSummary, cand: EvalSummary): { pass: boolean; rules: GateRule[] } {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const drops = Object.entries(cand.byCategory).map(([c, x]) => [c, (base.byCategory[c]?.accuracy ?? 0) - x.accuracy] as const).sort((a, b) => b[1] - a[1]);
  const rules: GateRule[] = [
    { name: "pass rate within 2 points", ok: cand.passRate >= base.passRate - 0.02, detail: `${pct(base.passRate)} -> ${pct(cand.passRate)}` },
    { name: "no category drops more than 5 points", ok: drops[0][1] <= 0.05, detail: `largest drop: ${drops[0][0]} ${(drops[0][1] * 100).toFixed(1)} points` },
    { name: "p95 latency no more than 25% slower", ok: cand.latencyP95 <= base.latencyP95 * 1.25, detail: `${base.latencyP95} -> ${cand.latencyP95} ms` },
    { name: "no reply contains personal data", ok: cand.cases.every((c) => c.noPii), detail: `${cand.cases.filter((c) => !c.noPii).length} with PII` },
  ];
  return { pass: rules.every((r) => r.ok), rules };
}

/** Calibrate the judge on half of the cases (empirical pass rate per score) and measure on the other half (Brier score). */
export function calibrateJudge(cases: CaseResult[]) {
  const fit = cases.filter((_, i) => i % 2 === 0), test = cases.filter((_, i) => i % 2 === 1);
  const table = new Map<number, number>();
  for (let s = 1; s <= 5; s++) { const xs = fit.filter((c) => c.judge === s); table.set(s, xs.length ? xs.filter((c) => c.pass).length / xs.length : s / 5); }
  const brier = (p: (c: CaseResult) => number) => test.reduce((a, c) => a + (p(c) - +c.pass) ** 2, 0) / test.length;
  const agree = (thr: number) => test.filter((c) => (c.judge >= thr) === c.pass).length / test.length;
  return { table: Object.fromEntries(table), brierRaw: brier((c) => (c.judge - 1) / 4), brierCalibrated: brier((c) => table.get(c.judge)!), agreementAt4: agree(4), agreementAt5: agree(5) };
}

/** Thompson-sampling bandit vs a fixed 50/50 A/B split over a stream of requests drawn from both versions' eval outcomes. */
export function experiment(a: EvalSummary, b: EvalSummary, requests = 1000, seed = 3) {
  let s = seed;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const beta = (al: number, be: number) => { // mean of a few samples from order statistics is enough for a toy sampler
    const g = (k: number) => { let x = 0; for (let i = 0; i < k; i++) x -= Math.log(1 - u()); return x; };
    const x = g(al), y = g(be); return x / (x + y);
  };
  const arms = [a, b].map((v) => ({ v, wins: 1, losses: 1, n: 0 }));
  let banditPass = 0, abPass = 0;
  for (let i = 0; i < requests; i++) {
    const c = i % a.cases.length;
    const k = beta(arms[0].wins, arms[0].losses) >= beta(arms[1].wins, arms[1].losses) ? 0 : 1;
    const ok = arms[k].v.cases[c].pass;
    arms[k].n++; if (ok) arms[k].wins++; else arms[k].losses++; if (ok) banditPass++;
    if ((u() < 0.5 ? a : b).cases[c].pass) abPass++;
  }
  return { requests, shareB: arms[1].n / requests, banditPassRate: banditPass / requests, abPassRate: abPass / requests };
}

/** Semantic cache on the draft step too: how many replies come back with someone else's order number. */
export function cacheExperiment(wf: Workflow, emails: Email[], secrets: SecretStore, threshold = 0.9) {
  const run1 = (scope: "classify" | "all") => {
    const cache = new SemanticCache(threshold);
    const s = evaluate(wf, emails, { secrets, cache, cacheScope: scope, label: `cache-${scope}` });
    const wrongOrder = s.cases.filter((c, i) => emails[i].orderId && c.factsFound < c.factsTotal && c.cached).length;
    return { hits: cache.hits, costPerRun: s.costPerRun, passRate: s.passRate, wrongOrder };
  };
  return { classifyOnly: run1("classify"), allSteps: run1("all"), threshold };
}

/** Line diff (LCS) for the prompt editor's version comparison. */
export function lineDiff(a: string, b: string) {
  const A = a.split("\n"), B = b.split("\n");
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push({ op: " ", line: A[i] }); i++; j++; }
    else if (j < B.length && (i === A.length || L[i][j + 1] >= L[i + 1][j])) { out.push({ op: "+", line: B[j] }); j++; }
    else { out.push({ op: "-", line: A[i] }); i++; }
  }
  return out;
}

export const kbIds = KB.map((k) => k.id);
