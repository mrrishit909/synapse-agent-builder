// Typed client for the SYNAPSE API (shapes match docs/openapi.json): bearer token, a W3C traceparent per call, an Idempotency-Key on
// every mutation, cursor pagination, and error bodies turned into ApiError.
import type { Email, EvalSummary, Faults, RunResult, Workflow } from "@synapse/domain";

export class ApiError extends Error {
  status: number; code: string; traceId?: string; details?: unknown;
  constructor(status: number, code: string, message: string, traceId?: string, details?: unknown) { super(message); this.status = status; this.code = code; this.traceId = traceId; this.details = details; }
}
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export class SynapseClient {
  private base: string; private token?: string;
  constructor(base: string, token?: string) { this.base = base.replace(/\/$/, ""); this.token = token; }
  async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { traceparent: `00-${hex(16)}-${hex(8)}-01`, ...extra };
    if (this.token && !headers.authorization) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? crypto.randomUUID();
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "http_error", j?.error?.message ?? r.statusText, j?.error?.traceId, j?.error?.details);
    return j as T;
  }
  /** Create the workflow, or save a new version of it (PUT) if it exists. */
  async saveWorkflow(wf: Workflow) {
    try { return await this.req<{ id: string; version: number }>("PUT", `/v1/workflows/${wf.id}`, wf); }
    catch (e) { if (e instanceof ApiError && e.status === 404) return this.req<{ id: string; version: number }>("POST", "/v1/workflows", wf); throw e; }
  }
  compile(id: string) { return this.req<{ ok: boolean; plan: unknown; issues: unknown[] }>("POST", `/v1/workflows/${id}/compile`, {}); }
  startRun(id: string, body: { emailId?: string; email?: Pick<Email, "subject" | "body">; faults?: Faults; modelOverride?: string }) { return this.req<{ run: RunResult }>("POST", `/v1/workflows/${id}/runs`, body); }
  run(id: string) { return this.req<RunResult>("GET", `/v1/runs/${id}`); }
  steps(id: string, cursor?: string) { return this.req<{ items: RunResult["steps"]; nextCursor: string | null }>("GET", `/v1/runs/${id}/steps${cursor ? `?cursor=${cursor}` : ""}`); }
  replay(id: string) { return this.req<{ run: RunResult; identical: boolean }>("POST", `/v1/runs/${id}/replay`, {}); }
  evaluate(body: { workflowId: string; versions: number[] }) { return this.req<{ summaries: Omit<EvalSummary, "cases">[]; gate: { pass: boolean } }>("POST", "/v1/evaluations", body); }
  testTool(body: { tool: "crm"; orderId: string }) { return this.req<{ status: number; latencyMs: number }>("POST", "/v1/tools/test", body); }
  models() { return this.req<{ items: unknown[] }>("GET", "/v1/models/catalog"); }
  publish(id: string, version?: number) { return this.req<{ slug: string; url: string; key: string; version: number }>("POST", `/v1/workflows/${id}/publish`, version ? { version } : {}); }
  invoke(slug: string, key: string, email: { subject: string; body: string }) { return this.req<{ category: string; reply: string; runId: string }>("POST", `/v1/endpoints/${slug}/invoke`, email, undefined, { authorization: `Bearer ${key}` }); }
}
