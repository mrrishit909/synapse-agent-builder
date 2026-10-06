// Workflow graphs and the compiler. A workflow is nodes + edges; compiling checks it and produces a deterministic execution plan
// (topological order, ties broken by node id) with each step's inputs bound to upstream outputs.

export type NodeType = "trigger.email" | "policy.pii" | "llm.classify" | "retrieval.kb" | "tool.crm" | "llm.draft" | "router.category" | "output.reply";

export interface WfNode {
  id: string;
  type: NodeType;
  label: string;
  x: number;
  y: number;
  /** llm: { model, prompt, fallback? }, tool: { secretRef, timeoutMs }, retrieval: { k }, router: { branches } */
  config: Record<string, unknown>;
  group?: string;
}
export interface WfEdge { id: string; from: string; to: string }
export interface Workflow { id: string; name: string; version: number; nodes: WfNode[]; edges: WfEdge[] }

export interface PlanStep { nodeId: string; type: NodeType; label: string; inputs: string[]; level: number; config: Record<string, unknown> }
export interface Plan { workflowId: string; version: number; steps: PlanStep[]; levels: number; hash: string }
export interface CompileIssue { code: string; message: string; nodeId?: string; edgeId?: string }

export const NODE_SPECS: Record<NodeType, { inputs: number | [number, number]; title: string; kind: "trigger" | "policy" | "llm" | "retrieval" | "tool" | "router" | "output" }> = {
  "trigger.email": { inputs: 0, title: "Email trigger", kind: "trigger" },
  "policy.pii": { inputs: 1, title: "PII filter", kind: "policy" },
  "llm.classify": { inputs: 1, title: "Classify (LLM)", kind: "llm" },
  "retrieval.kb": { inputs: 1, title: "Knowledge base search", kind: "retrieval" },
  "tool.crm": { inputs: 1, title: "CRM lookup (tool)", kind: "tool" },
  "llm.draft": { inputs: [1, 4], title: "Draft reply (LLM)", kind: "llm" },
  "router.category": { inputs: 1, title: "Route by category", kind: "router" },
  "output.reply": { inputs: [1, 2], title: "Send reply", kind: "output" },
};

/** FNV-1a over a canonical JSON string: stable plan and cache ids. */
export function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object"
    ? `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

export function compile(wf: Workflow): { plan: Plan | null; issues: CompileIssue[] } {
  const issues: CompileIssue[] = [];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  if (byId.size !== wf.nodes.length) issues.push({ code: "duplicate_node", message: "two nodes share an id" });
  for (const e of wf.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) issues.push({ code: "dangling_edge", message: `edge ${e.id} points at a missing node`, edgeId: e.id });
    if (e.from === e.to) issues.push({ code: "self_loop", message: `edge ${e.id} loops on itself`, edgeId: e.id });
  }
  const triggers = wf.nodes.filter((n) => n.type === "trigger.email");
  if (triggers.length !== 1) issues.push({ code: "trigger_count", message: `a workflow needs exactly one trigger (found ${triggers.length})` });
  const ins = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  const outs = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) if (byId.has(e.from) && byId.has(e.to)) { ins.get(e.to)!.push(e.from); outs.get(e.from)!.push(e.to); }
  for (const n of wf.nodes) {
    const spec = NODE_SPECS[n.type];
    if (!spec) { issues.push({ code: "unknown_type", message: `unknown node type ${n.type}`, nodeId: n.id }); continue; }
    const k = ins.get(n.id)!.length, [lo, hi] = typeof spec.inputs === "number" ? [spec.inputs, spec.inputs] : spec.inputs;
    if (k < lo || k > hi) issues.push({ code: "arity", message: `${n.label} takes ${lo === hi ? lo : `${lo}-${hi}`} input${hi === 1 ? "" : "s"}, has ${k}`, nodeId: n.id });
    if (spec.kind === "llm" && typeof n.config.model !== "string") issues.push({ code: "missing_model", message: `${n.label} has no model`, nodeId: n.id });
    if (n.type === "tool.crm" && typeof n.config.secretRef === "string" && !String(n.config.secretRef).startsWith("secret://"))
      issues.push({ code: "inline_secret", message: `${n.label}: credentials must be a secret:// reference, not a value`, nodeId: n.id });
  }
  // Kahn's algorithm with a sorted ready set: the same graph always compiles to the same order
  const indeg = new Map(wf.nodes.map((n) => [n.id, ins.get(n.id)!.length]));
  const level = new Map<string, number>();
  let ready = wf.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    level.set(id, Math.max(0, ...ins.get(id)!.map((p) => (level.get(p) ?? 0) + 1)));
    for (const c of outs.get(id)!) { indeg.set(c, indeg.get(c)! - 1); if (indeg.get(c) === 0) ready.push(c); }
    ready.sort();
  }
  if (order.length !== wf.nodes.length) issues.push({ code: "cycle", message: "the graph has a cycle", nodeId: wf.nodes.find((n) => !order.includes(n.id))?.id });
  // policy: no LLM may see the raw trigger payload; every path from the trigger to an LLM passes a PII filter
  if (triggers.length === 1 && !issues.some((i) => i.code === "cycle")) {
    const seen = new Set<string>(), stack = [triggers[0].id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id)!;
      if (NODE_SPECS[n.type]?.kind === "llm") issues.push({ code: "pii_unfiltered", message: `${n.label} can receive the raw email: put a PII filter on every path to it`, nodeId: id });
      if (n.type !== "policy.pii") stack.push(...outs.get(id)!);
    }
  }
  if (issues.length) return { plan: null, issues };
  const steps: PlanStep[] = order.map((id) => {
    const n = byId.get(id)!;
    return { nodeId: id, type: n.type, label: n.label, inputs: [...ins.get(id)!].sort(), level: level.get(id)!, config: n.config };
  });
  const body = { workflowId: wf.id, version: wf.version, steps };
  return { plan: { ...body, levels: Math.max(...steps.map((s) => s.level)) + 1, hash: hash(canonical(body)) }, issues: [] };
}

/** Synthetic large graph for the canvas and compiler stress tests: a layered DAG with n nodes and about m edges. */
export function stressGraph(n = 2000, m = 5000, seed = 7): Workflow {
  let a = seed;
  const u = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const layers = 40, per = Math.ceil(n / layers);
  const types: NodeType[] = ["llm.classify", "retrieval.kb", "tool.crm", "policy.pii"];
  const nodes: WfNode[] = Array.from({ length: n }, (_, i) => ({
    id: `s${String(i).padStart(4, "0")}`, type: i === 0 ? "trigger.email" : types[i % 4], label: `node ${i}`,
    x: Math.floor(i / per) * 260, y: (i % per) * 90, config: { model: "atlas-mini" },
  }));
  const edges: WfEdge[] = [];
  const seen = new Set<string>();
  while (edges.length < m) {
    const i = Math.floor(u() * (n - per)), j = Math.min(n - 1, (Math.floor(i / per) + 1) * per + Math.floor(u() * per));
    const k = `${i}>${j}`;
    if (i === j || seen.has(k)) continue;
    seen.add(k);
    edges.push({ id: `e${edges.length}`, from: nodes[i].id, to: nodes[j].id });
  }
  return { id: "stress", name: "stress", version: 1, nodes, edges };
}
