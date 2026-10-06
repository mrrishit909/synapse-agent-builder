import { describe, expect, it } from "vitest";
import {
  compile, stressGraph, supportWorkflow, run, execute, handoffs, route, BALANCED, SemanticCache, demoSecrets, SecretStore, SAMPLE_EMAIL, SAMPLE_FAULTS,
  makeEmails, redact, containsPii, evaluate, gate, calibrateJudge, experiment, cacheExperiment, lineDiff, MODELS, model, costUsd, tokens, searchKb, cueCategory,
  callModel, crmLookup, hash, canonical, embed, cosine, judge, CLASSIFY_PROMPT, type Workflow,
} from "../src/index.ts";

const sec = demoSecrets();
const wf = supportWorkflow();

describe("compiler", () => {
  it("compiles the support workflow to a stable plan (snapshot)", () => {
    const { plan, issues } = compile(wf);
    expect(issues).toEqual([]);
    expect(plan!.steps.map((s) => `${s.nodeId}@${s.level}<${s.inputs.join(",")}`)).toMatchInlineSnapshot(`
      [
        "trigger@0<",
        "pii@1<trigger",
        "classify@2<pii",
        "crm@2<pii",
        "kb@3<classify",
        "draft@4<classify,crm,kb",
      ]
    `);
    expect(plan!.hash).toBe(compile(structuredClone(wf)).plan!.hash);
    // node order in the JSON does not change the plan
    expect(compile({ ...wf, nodes: [...wf.nodes].reverse(), edges: [...wf.edges].reverse() }).plan!.hash).toBe(plan!.hash);
  });
  it("rejects broken graphs with a reason per node", () => {
    const codes = (w: Workflow) => compile(w).issues.map((i) => i.code).sort();
    expect(codes({ ...wf, edges: [...wf.edges, { id: "x", from: "draft", to: "pii" }] })).toContain("cycle");
    expect(codes({ ...wf, edges: wf.edges.filter((e) => e.id !== "e2").concat({ id: "y", from: "trigger", to: "classify" }) })).toContain("pii_unfiltered");
    expect(codes({ ...wf, nodes: wf.nodes.map((n) => (n.id === "crm" ? { ...n, config: { secretRef: "crm_live_abc" } } : n)) })).toContain("inline_secret");
    expect(codes({ ...wf, nodes: wf.nodes.map((n) => (n.id === "draft" ? { ...n, config: {} } : n)) })).toContain("missing_model");
    expect(codes({ ...wf, nodes: wf.nodes.filter((n) => n.id !== "trigger") })).toEqual(expect.arrayContaining(["dangling_edge", "trigger_count"]));
    expect(codes({ ...wf, edges: [...wf.edges, { id: "z", from: "kb", to: "kb" }] })).toContain("self_loop");
    expect(codes({ ...wf, nodes: [...wf.nodes, { ...wf.nodes[0] }] })).toContain("duplicate_node");
    expect(codes({ ...wf, nodes: [...wf.nodes, { id: "q", type: "bogus" as never, label: "q", x: 0, y: 0, config: {} }] })).toContain("unknown_type");
    expect(codes({ ...wf, edges: wf.edges.filter((e) => e.id !== "e6") }).length).toBe(0); // draft takes 1-4 inputs
    expect(codes({ ...wf, edges: wf.edges.filter((e) => e.id !== "e4") })).toContain("arity"); // crm has none
  });
  it("compiles 2,000 nodes and 5,000 edges quickly and deterministically", () => {
    const g = stressGraph();
    expect(g.nodes).toHaveLength(2000); expect(g.edges).toHaveLength(5000);
    const t0 = performance.now();
    const order = topoOnly(g);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(order).toEqual(topoOnly(stressGraph()));
  });
  it("hash and canonical JSON ignore key order", () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(hash("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});
function topoOnly(g: Workflow) {
  // the stress graph has no PII policy, so check order through the issues-free subset: compile the DAG ignoring policy
  const r = compile({ ...g, nodes: g.nodes.map((n) => ({ ...n, type: n.type.startsWith("llm") ? "retrieval.kb" : n.type })) });
  return r.plan?.steps.map((s) => s.nodeId) ?? r.issues.map((i) => i.code);
}

describe("runtime", () => {
  const sample = () => run(wf, SAMPLE_EMAIL, { secrets: sec, faults: SAMPLE_FAULTS, truth: SAMPLE_EMAIL });
  it("runs the six steps, schedules in parallel, retries the CRM timeout", () => {
    const r = sample();
    expect(r.status).toBe("succeeded");
    expect(r.steps.map((s) => s.nodeId)).toEqual(["trigger", "pii", "classify", "crm", "kb", "draft"]);
    const by = Object.fromEntries(r.steps.map((s) => [s.nodeId, s]));
    expect(by.classify.startMs).toBe(by.crm.startMs); // both wait only for the PII filter
    expect(by.crm.attempts.map((a) => a.status)).toEqual([504, 200]);
    expect(by.crm.attempts[1].backoffMs).toBe(250);
    expect(by.draft.startMs).toBe(Math.max(by.kb.endMs, by.crm.endMs, by.classify.endMs) + 150);
    expect(r.output.category).toBe("billing");
    expect(r.output.reply).toContain("ORD-48213");
    expect(r.output.articles).toEqual(["KB-102", "KB-101"]);
    expect(r.retries).toBe(1);
    expect(handoffs(wf, r)).toHaveLength(7);
  });
  it("replays identically: same plan, options and seed give the same trace", () => {
    expect(JSON.stringify(sample())).toBe(JSON.stringify(sample()));
  });
  it("keeps PII away from models and secrets out of every trace payload", () => {
    const r = sample();
    const json = JSON.stringify(r);
    for (const v of sec.values()) expect(json).not.toContain(v);
    expect(json).toContain("secret://crm-api-key");
    for (const s of r.steps.filter((x) => x.type.startsWith("llm."))) expect(containsPii(s.input)).toBe(false);
    expect(r.steps[1].note).toBe("redacted 1 email, 1 phone, 1 card");
    const bad = new SecretStore(); bad.set("crm-api-key", "wrong");
    const r2 = run(wf, SAMPLE_EMAIL, { secrets: bad, truth: SAMPLE_EMAIL });
    expect(r2.steps.find((s) => s.nodeId === "crm")!.error).toBe("CRM rejected the credentials");
    expect(() => bad.resolve("plain")).toThrow(); expect(() => bad.resolve("secret://nope")).toThrow();
  });
  it("429 waits a second; 500s exhaust retries then fall back; a dead provider fails over", () => {
    const f = { forced: { "sample:classify:atlas-large#1": 429 as const } };
    const a = run(wf, SAMPLE_EMAIL, { secrets: sec, faults: f, truth: SAMPLE_EMAIL }).steps[2];
    expect(a.attempts.map((x) => x.status)).toEqual([429, 200]);
    expect(a.attempts[1].backoffMs).toBe(1000);
    const f2 = { forced: { "sample:classify:atlas-large#1": 500, "sample:classify:atlas-large#2": 500, "sample:classify:atlas-large#3": 500 } as Record<string, 500> };
    const b = run(wf, SAMPLE_EMAIL, { secrets: sec, faults: f2, truth: SAMPLE_EMAIL });
    expect(b.steps[2].attempts.map((x) => `${x.kind}:${x.model}:${x.status}`)).toEqual(["call:atlas-large:500", "call:atlas-large:500", "call:atlas-large:500", "fallback:atlas-mini:200"]);
    expect(b.fallbacks).toBe(1); expect(b.status).toBe("succeeded");
    const c = run(wf, SAMPLE_EMAIL, { secrets: sec, faults: { providerDown: ["Atlas AI"] }, truth: SAMPLE_EMAIL });
    expect(c.status).toBe("failed"); // both models of the chain are Atlas
    const d = run(wf, SAMPLE_EMAIL, { secrets: sec, faults: { providerDown: ["Atlas AI"] }, modelOverride: "auto", truth: SAMPLE_EMAIL });
    expect(d.status).toBe("succeeded");
    expect(d.steps[2].model).toBe("nova-pro");
    const e = run(wf, SAMPLE_EMAIL, { secrets: sec, faults: { forced: { "sample:crm#1": "timeout", "sample:crm#2": "timeout", "sample:crm#3": "timeout" } }, truth: SAMPLE_EMAIL });
    expect(e.steps[3].status).toBe("error"); expect(e.status).toBe("succeeded"); // the draft goes ahead without the order record
  });
  it("repairs malformed JSON once, then falls back", () => {
    const f = { forced: { "sample:classify:nova-pro#1": "malformed" as const } };
    const a = run(supportWorkflow("nova-pro", 2, "nova-lite"), SAMPLE_EMAIL, { secrets: sec, faults: f, truth: SAMPLE_EMAIL });
    expect(a.steps[2].attempts.map((x) => `${x.kind}:${x.error ?? x.status}`)).toEqual(["call:malformed JSON", "repair:200"]);
    expect(a.repairs).toBe(1);
    const f2 = { forced: { "sample:classify:nova-pro#1": "malformed", "sample:classify:nova-pro#2": "malformed" } as Record<string, "malformed"> };
    const b = run(supportWorkflow("nova-pro", 2, "nova-lite"), SAMPLE_EMAIL, { secrets: sec, faults: f2, truth: SAMPLE_EMAIL });
    expect(b.steps[2].attempts.at(-1)!.kind).toBe("fallback");
  });
  it("cost is the sum of its steps and matches the price list (reconciliation)", () => {
    for (const e of makeEmails().slice(0, 20)) {
      const r = run(supportWorkflow("nova-pro", 2, "nova-lite"), e, { secrets: sec, truth: e });
      const fromAttempts = r.steps.flatMap((s) => s.attempts.filter((a) => a.model).map((a) => costUsd(model(a.model!), a.tokenIn, a.tokenOut))).reduce((s, x) => s + x, 0);
      const kb = r.steps.find((s) => s.type === "retrieval.kb")!.costUsd;
      expect(r.totalCostUsd).toBeCloseTo(r.steps.reduce((s, x) => s + x.costUsd, 0), 15);
      expect(r.totalCostUsd).toBeCloseTo(fromAttempts + kb, 12);
      expect(r.tokens.in).toBe(r.steps.reduce((s, x) => s + x.tokenIn, 0));
    }
  });
  it("refuses to run a workflow that does not compile, and a plan that leaks PII", () => {
    expect(() => run({ ...wf, edges: [] }, SAMPLE_EMAIL, { secrets: sec })).toThrow(/does not compile/);
    const { plan } = compile(wf);
    const leaky = { ...plan!, steps: plan!.steps.filter((s) => s.nodeId !== "pii").map((s) => ({ ...s, inputs: s.inputs.map((i) => (i === "pii" ? "trigger" : i)) })) };
    expect(() => execute(leaky, SAMPLE_EMAIL, { secrets: sec })).toThrow(/PII reached/);
  });
});

describe("providers, routing, cache", () => {
  it("router picks a healthy model that fits, and avoids a down provider", () => {
    expect(route("hi", BALANCED)!.model.id).toBe("nova-pro");
    expect(route("hi", { wQuality: 10, wCost: 0, wLatency: 0 })!.model.id).toBe("atlas-large");
    expect(route("hi", BALANCED, ["Atlas AI"])!.model.id).toBe("nova-pro");
    expect(route("hi", BALANCED, ["Nova Labs"])!.model.id).toBe("atlas-mini");
    expect(route("x".repeat(4 * 150_000), BALANCED)!.model.id).toBe("atlas-large"); // only one has 200k context
    expect(route("x".repeat(4 * 300_000), BALANCED)).toBeNull();
    expect(callModel(model("nova-lite"), "classify", "x".repeat(4 * 40_000), { key: "k", attempt: 1 }).status).toBe(400);
  });
  it("semantic cache hits near-identical text for the same model only", () => {
    const c = new SemanticCache(0.85);
    c.put("atlas-mini", "Where is my order ORD-12345? The tracking has not moved in a week and the delivery is late.", "{}");
    expect(c.get("atlas-mini", "Where is my order ORD-99999? The tracking has not moved in a week and the delivery is late.")).toBe("{}");
    expect(c.get("nova-pro", "Where is my order ORD-99999? The tracking has not moved in a week and the delivery is late.")).toBeNull();
    expect(c.get("atlas-mini", "Please reset my password")).toBeNull();
    expect([c.hits, c.misses]).toEqual([1, 2]);
  });
  it("simulators are deterministic and sensible", () => {
    expect(cueCategory("please cancel and refund")).toBe("cancellation");
    expect(cueCategory("nothing here")).toBe("other");
    expect(searchKb("charged twice refund", 1, "billing")[0].id).toBe("KB-101");
    expect(tokens("abcd")).toBe(1);
    expect(MODELS).toHaveLength(4);
    expect(() => model("gpt")).toThrow();
    expect(cosine(embed("tracking late delivery"), embed("late delivery tracking"))).toBeCloseTo(1, 9);
    expect(crmLookup(null, { key: "k", attempt: 1, apiKey: "crm_live_x" }).text).toBe('{"found":false}');
    expect(crmLookup("ORD-1", { key: "k", attempt: 1, apiKey: "crm_live_x", faults: { forced: { "k#1": 500 } } }).status).toBe(500);
    expect(callModel(model("atlas-large"), "classify", `${CLASSIFY_PROMPT}\n\nurgent: charged twice`, { key: "k", attempt: 1, content: "urgent: charged twice" }).text).toContain('"urgency":"high"');
  });
});

describe("data and evaluation", () => {
  const em = makeEmails();
  it("generates labeled e-mails with near-duplicates and redacts PII", () => {
    expect(em.length).toBeGreaterThan(60);
    expect(em.filter((e) => e.nearDuplicateOf).length).toBeGreaterThan(0);
    expect(new Set(em.map((e) => e.id)).size).toBe(em.length);
    const r = redact("mail a.b@x.io or +1 (555) 014-2290, visa ending 4242");
    expect(r.text).toBe("mail [EMAIL] or [PHONE], [CARD]");
    expect(containsPii(r.text)).toBe(false);
  });
  const v1 = evaluate(supportWorkflow("atlas-large", 1), em, { secrets: sec, label: "v1" });
  const v2 = evaluate(supportWorkflow("nova-pro", 2, "nova-lite"), em, { secrets: sec, label: "v2" });
  it("scores versions and the gate blocks a regression", () => {
    expect(v1.n).toBe(em.length);
    expect(v1.passRate).toBeGreaterThan(v2.passRate);
    expect(v2.costPerRun).toBeLessThan(v1.costPerRun * 0.4);
    expect(v2.latencyP95).toBeLessThan(v1.latencyP95);
    expect(v2.repairs).toBeGreaterThan(0);
    const g = gate(v1, v2);
    expect(g.pass).toBe(false);
    expect(g.rules.find((r) => !r.ok)!.name).toBe("pass rate within 2 points");
    expect(gate(v1, v1).pass).toBe(true);
    // evaluation regression gate on the current baseline: it may not silently get worse
    expect(v1.passRate).toBeGreaterThanOrEqual(0.85);
  });
  it("calibrates the lenient judge, runs bandit vs A/B, measures the cache", () => {
    const c = calibrateJudge(v1.cases.concat(v2.cases));
    expect(c.brierCalibrated).toBeLessThan(c.brierRaw);
    expect(judge(undefined, false, "x")).toBe(1);
    const x = experiment(v1, v2);
    expect(x.shareB).toBeLessThan(0.5);
    expect(x.banditPassRate).toBeGreaterThanOrEqual(x.abPassRate - 0.01);
    const ce = cacheExperiment(supportWorkflow(), em, sec);
    expect(ce.classifyOnly.wrongOrder).toBe(0);
    expect(ce.allSteps.wrongOrder).toBeGreaterThan(5);
  });
  it("diffs prompt versions line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc").map((d) => d.op + d.line)).toEqual([" a", "+B", "-b", " c"]);
  });
});
