// The agent runtime. Executes a compiled plan on a virtual clock: each step starts when all its inputs have finished (plus a
// hand-off between services), calls its provider, retries 429/500/timeouts with backoff, repairs malformed JSON once, then falls
// back to the node's fallback model. Everything recorded in the trace is redacted: PII never reaches a model, secrets never leave
// the secret store. Same plan + options + seed = the same trace, step for step.
import { compile, hash, type Plan, type Workflow } from "./graph.ts";
import { MODELS, callModel, cosine, crmLookup, embed, model, searchKb, tokens, type Category, type Faults, type ModelSpec, type ProviderCall } from "./providers.ts";
import { redact, containsPii, type Email, type SecretStore } from "./data.ts";

export const HANDOFF_MS = 150; // queue + network between steps in an orchestrator
export interface RetryPolicy { max: number; baseMs: number }
export const DEFAULT_RETRY: RetryPolicy = { max: 2, baseMs: 250 };

export interface RouterPolicy { wQuality: number; wCost: number; wLatency: number }
/** quality minus 0.02 per dollar-per-thousand-calls minus 0.03 per second of expected latency */
export const BALANCED: RouterPolicy = { wQuality: 1, wCost: 0.02, wLatency: 0.00003 };

/** Pick a model for a prompt: must fit the context and be healthy; then the best weighted score. */
export function route(prompt: string, policy: RouterPolicy, unhealthy: string[] = []) {
  const t = tokens(prompt);
  const cands = MODELS.filter((m) => m.contextTokens >= t && !unhealthy.includes(m.provider));
  if (!cands.length) return null;
  const score = (m: ModelSpec) => policy.wQuality * m.quality - policy.wCost * ((t * m.inPerM + 200 * m.outPerM) / 1e6) * 1000 - policy.wLatency * (m.latencyMs + 200 * m.perOutTokMs);
  const best = [...cands].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
  return { model: best, reason: `best weighted score of ${cands.length} healthy models that fit ${t} tokens` };
}

export class SemanticCache {
  entries: { model: string; vec: number[]; key: string; output: string }[] = [];
  hits = 0; misses = 0;
  threshold: number;
  constructor(threshold = 0.95) { this.threshold = threshold; }
  get(modelId: string, text: string) {
    const v = embed(text);
    const e = this.entries.find((x) => x.model === modelId && cosine(x.vec, v) >= this.threshold);
    if (e) this.hits++; else this.misses++;
    return e?.output ?? null;
  }
  put(modelId: string, text: string, output: string) { this.entries.push({ model: modelId, vec: embed(text), key: hash(text), output }); }
}

export interface RunOptions {
  secrets: SecretStore;
  faults?: Faults;
  retry?: RetryPolicy;
  /** replace every LLM node's model (the "swap provider" action); "auto" = router */
  modelOverride?: string;
  router?: RouterPolicy;
  cache?: SemanticCache;
  /** which steps may use the cache: classification only (default), or drafts too (unsafe: see the evaluation) */
  cacheScope?: "classify" | "all";
  /** ground truth for the simulators (label and facts); the runtime itself never reads it */
  truth?: Pick<Email, "label" | "facts">;
  runId?: string;
}

export type StepStatus = "ok" | "error" | "cached";
export interface Attempt { n: number; model?: string; provider?: string; status: number; error?: string; latencyMs: number; startMs: number; kind: "call" | "repair" | "fallback"; backoffMs: number; tokenIn: number; tokenOut: number; costUsd: number }
export interface StepRecord {
  seq: number; nodeId: string; type: string; label: string; status: StepStatus; startMs: number; endMs: number; latencyMs: number;
  model?: string; provider?: string; tokenIn: number; tokenOut: number; costUsd: number; input: string; output: string; attempts: Attempt[]; error?: string; note?: string;
}
export interface RunResult {
  id: string; workflowId: string; version: number; planHash: string; status: "succeeded" | "failed";
  steps: StepRecord[]; totalCostUsd: number; totalLatencyMs: number; tokens: { in: number; out: number };
  output: { category?: Category; urgency?: string; reply?: string; articles?: string[]; crm?: unknown };
  retries: number; fallbacks: number; repairs: number; cacheHits: number;
}

const ORDER_RE = /ORD-\d{5}/;

export function run(wf: Workflow, email: Pick<Email, "id" | "body" | "subject">, o: RunOptions): RunResult {
  const { plan, issues } = compile(wf);
  if (!plan) throw new Error(`workflow does not compile: ${issues.map((i) => i.code).join(", ")}`);
  return execute(plan, email, o);
}

export function execute(plan: Plan, email: Pick<Email, "id" | "body" | "subject">, o: RunOptions): RunResult {
  const retry = o.retry ?? DEFAULT_RETRY;
  const out = new Map<string, { text: string; endMs: number; data?: unknown }>();
  const steps: StepRecord[] = [];
  const unhealthy = [...(o.faults?.providerDown ?? [])];
  let retries = 0, fallbacks = 0, repairs = 0, cacheHits = 0;
  const scrub = (s: string) => o.secrets.scrub(s);

  for (const [seq, st] of plan.steps.entries()) {
    const ready = Math.max(0, ...st.inputs.map((i) => out.get(i)!.endMs + HANDOFF_MS));
    const upstream = st.inputs.map((i) => out.get(i)!);
    const inputText = upstream.map((u) => u.text).join("\n---\n");
    const rec: StepRecord = { seq, nodeId: st.nodeId, type: st.type, label: st.label, status: "ok", startMs: ready, endMs: ready, latencyMs: 0, tokenIn: 0, tokenOut: 0, costUsd: 0, input: "", output: "", attempts: [] };
    const key = `${email.id}:${st.nodeId}`;
    let text = "", data: unknown;

    if (st.type === "trigger.email") {
      text = `Subject: ${email.subject}\n\n${email.body}`;
      rec.input = "(raw e-mail, kept out of the trace)"; rec.output = `${text.length} characters received`; rec.latencyMs = 5;
    } else if (st.type === "policy.pii") {
      const r = redact(inputText);
      text = r.text; data = r.found;
      rec.input = "(raw e-mail)"; rec.output = text; rec.latencyMs = 3;
      rec.note = Object.keys(r.found).length ? `redacted ${Object.entries(r.found).map(([k, n]) => `${n} ${k}`).join(", ")}` : "nothing to redact";
    } else if (st.type === "retrieval.kb") {
      const cat = (upstream.find((u) => (u.data as { category?: string })?.category)?.data as { category?: string })?.category ?? "";
      const hits = searchKb(inputText, Number(st.config.k ?? 2), cat);
      text = hits.map((h) => `${h.id} ${h.title}: ${h.text}`).join("\n"); data = hits.map((h) => h.id);
      rec.input = `${cat} + e-mail text`; rec.output = hits.map((h) => `${h.id} (${h.score})`).join(", ");
      rec.latencyMs = 45 + Math.round(30 * ((parseInt(hash(key), 16) % 100) / 100));
      rec.tokenIn = tokens(inputText); rec.costUsd = (rec.tokenIn * 0.02) / 1e6; // embedding price, synthetic
    } else if (st.type === "tool.crm") {
      const ref = String(st.config.secretRef ?? "");
      const apiKey = o.secrets.resolve(ref);
      const orderId = inputText.match(ORDER_RE)?.[0] ?? null;
      rec.input = `GET /orders/${orderId ?? "(none)"}  Authorization: Bearer ${ref}`;
      let t = ready, res: ProviderCall | null = null;
      for (let n = 1; n <= retry.max + 1; n++) {
        res = crmLookup(orderId, { key, attempt: n, faults: o.faults, apiKey });
        const backoff = n === 1 ? 0 : retry.baseMs * 2 ** (n - 2);
        t += backoff;
        rec.attempts.push({ n, status: res.status, error: res.error ? scrub(res.error) : undefined, latencyMs: res.latencyMs, startMs: t, kind: "call", backoffMs: backoff, tokenIn: 0, tokenOut: 0, costUsd: 0 });
        t += res.latencyMs;
        if (res.ok || res.status === 401) break;
        retries++;
      }
      rec.latencyMs = t - ready;
      if (!res!.ok) { rec.status = "error"; rec.error = scrub(res!.error ?? "failed"); text = "CRM unavailable"; }
      else { text = res!.text; data = JSON.parse(res!.text); rec.output = scrub(res!.text); }
    } else if (st.type === "llm.classify" || st.type === "llm.draft") {
      const task = st.type === "llm.classify" ? "classify" : "draft";
      const prompt = `${String(st.config.prompt ?? "")}\n\n${inputText}`;
      if (containsPii(prompt)) throw new Error(`policy violation: PII reached ${st.label}`); // compile() should make this impossible
      const chosen = o.modelOverride === "auto" || st.config.model === "auto" ? route(prompt, o.router ?? BALANCED, unhealthy) : null;
      const primary = model(chosen?.model.id ?? (o.modelOverride && o.modelOverride !== "auto" ? o.modelOverride : String(st.config.model)));
      const chain = [primary, ...(st.config.fallback ? [model(String(st.config.fallback))] : [])].filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i);
      rec.input = prompt;
      if (chosen) rec.note = `router: ${chosen.model.id} (${chosen.reason})`;
      const cacheable = o.cache && (task === "classify" || o.cacheScope === "all");
      const cached = cacheable ? o.cache!.get(primary.id, prompt) : null;
      let t = ready, final: ProviderCall | null = null, used: ModelSpec = primary, parsed: unknown = null;
      if (cached) {
        final = { ok: true, status: 200, text: cached, latencyMs: 4, tokenIn: 0, tokenOut: 0, costUsd: 0 };
        rec.status = "cached"; cacheHits++; t += 4;
      } else {
        outer: for (const [mi, m] of chain.entries()) {
          if (mi > 0) fallbacks++;
          let failures = 0, repaired = false, n = 0;
          while (failures <= retry.max) {
            const prev = rec.attempts.at(-1);
            // back off before a retry: 1 s after a 429, exponential after errors; none before a repair or a fallback's first call
            const backoff = !prev || prev.model !== m.id || prev.error === "malformed JSON" ? 0 : prev.status === 429 ? 1000 : retry.baseMs * 2 ** (failures - 1);
            t += backoff;
            n++;
            const res = callModel(m, task, repaired ? `${prompt}\n\nReturn only valid JSON.` : prompt, { key: `${key}:${m.id}`, attempt: n, faults: o.faults, truth: o.truth?.label, facts: o.truth?.facts, content: inputText });
            const kind: Attempt["kind"] = mi > 0 && n === 1 ? "fallback" : prev?.error === "malformed JSON" ? "repair" : "call";
            rec.attempts.push({ n: rec.attempts.length + 1, model: m.id, provider: m.provider, status: res.status, error: res.error, latencyMs: res.latencyMs, startMs: t, kind, backoffMs: backoff, tokenIn: res.tokenIn, tokenOut: res.tokenOut, costUsd: res.costUsd });
            t += res.latencyMs;
            rec.tokenIn += res.tokenIn; rec.tokenOut += res.tokenOut; rec.costUsd += res.costUsd;
            if (!res.ok) { if (res.status === 400) break; failures++; retries++; continue; }
            if (task === "classify") {
              try { parsed = JSON.parse(res.text); } catch {
                rec.attempts.at(-1)!.error = "malformed JSON";
                if (!repaired) { repaired = true; repairs++; continue; } // one repair re-prompt, outside the retry budget
                break;
              }
            }
            final = res; used = m; break outer;
          }
          if (rec.attempts.filter((x) => x.model === m.id && x.status >= 500).length > retry.max && !unhealthy.includes(m.provider)) unhealthy.push(m.provider);
        }
        if (final && cacheable) o.cache!.put(primary.id, prompt, final.text);
      }
      rec.latencyMs = t - ready;
      rec.model = used.id; rec.provider = used.provider;
      if (!final) { rec.status = "error"; rec.error = `all ${rec.attempts.length} attempts failed (${[...new Set(rec.attempts.map((a) => a.error ?? a.status))].join(", ")})`; text = ""; }
      else {
        text = final.text; rec.output = final.text;
        data = task === "classify" ? (parsed ?? JSON.parse(final.text)) : { reply: final.text };
      }
    } else {
      text = inputText; rec.output = "(passed through)"; rec.latencyMs = 2;
    }
    rec.endMs = rec.startMs + rec.latencyMs;
    rec.input = scrub(rec.input); rec.output = scrub(rec.output);
    out.set(st.nodeId, { text, endMs: rec.endMs, data });
    steps.push(rec);
  }

  const find = (type: string) => steps.find((s) => s.type === type);
  const cls = out.get(find("llm.classify")?.nodeId ?? "")?.data as { category?: Category; urgency?: string } | undefined;
  const draft = out.get(find("llm.draft")?.nodeId ?? "")?.data as { reply?: string } | undefined;
  const failed = steps.some((s) => s.status === "error" && s.type.startsWith("llm."));
  return {
    id: o.runId ?? `run-${hash(`${plan.hash}:${email.id}:${o.modelOverride ?? ""}:${JSON.stringify(o.faults ?? {})}`)}`,
    workflowId: plan.workflowId, version: plan.version, planHash: plan.hash, status: failed ? "failed" : "succeeded", steps,
    totalCostUsd: steps.reduce((s, x) => s + x.costUsd, 0), totalLatencyMs: Math.max(...steps.map((s) => s.endMs)),
    tokens: { in: steps.reduce((s, x) => s + x.tokenIn, 0), out: steps.reduce((s, x) => s + x.tokenOut, 0) },
    output: { category: cls?.category, urgency: cls?.urgency, reply: draft?.reply, articles: out.get(find("retrieval.kb")?.nodeId ?? "")?.data as string[], crm: out.get(find("tool.crm")?.nodeId ?? "")?.data },
    retries, fallbacks, repairs, cacheHits,
  };
}

/** Edges as timed hand-offs, for the canvas particles: from the upstream step's end to the downstream step's start. */
export function handoffs(wf: Workflow, r: RunResult) {
  const at = new Map(r.steps.map((s) => [s.nodeId, s]));
  return wf.edges.filter((e) => at.has(e.from) && at.has(e.to)).map((e) => ({ edgeId: e.id, from: e.from, to: e.to, departMs: at.get(e.from)!.endMs, arriveMs: at.get(e.from)!.endMs + HANDOFF_MS, failed: at.get(e.from)!.status === "error" }));
}
