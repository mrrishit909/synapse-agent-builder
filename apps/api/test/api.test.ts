// API contract, authorization matrix, tenant isolation, secrets, idempotency, failure injection, replay, release gate and the
// published endpoint, against a real Postgres. Every JSON body is validated against the OpenAPI document the server publishes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import pg from "pg";
import WebSocket from "ws";
import { supportWorkflow } from "../../../packages/domain/src/index.ts";
import { migrate } from "../src/migrate.ts";
import { seed, CRM_KEYS } from "../src/seed.ts";
import { build } from "../src/server.ts";
import { pool } from "../src/db.ts";

type App = Awaited<ReturnType<typeof build>>;
let app: App;
let spec: { paths: Record<string, Record<string, { responses: Record<string, { content?: { "application/json"?: { schema: object } } }> }>> };
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uuid", /^[0-9a-f-]{36}$/).addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)));
const OP = { authorization: "Bearer acme-builder-demo" }, VIEW = { authorization: "Bearer acme-viewer-demo" }, OTHER = { authorization: "Bearer globex-builder-demo" };
let k = 0;
const key = () => ({ "idempotency-key": `test-key-${++k}-${Date.now()}` });

async function call(method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string> = {}, body?: unknown, route?: string) {
  const r = await app.inject({ method, url, headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers, payload: body !== undefined ? JSON.stringify(body) : undefined });
  const path = route ?? url.split("?")[0];
  const schema = spec.paths[path]?.[method.toLowerCase()]?.responses?.[String(r.statusCode)]?.content?.["application/json"]?.schema;
  if (schema && String(r.headers["content-type"]).includes("json") && !ajv.validate(schema, r.json())) throw new Error(`${method} ${url} ${r.statusCode} does not match its OpenAPI schema: ${ajv.errorsText()}`);
  return r;
}
const owner = () => new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL ?? "postgresql://synapse:owner-dev-only@127.0.0.1:55440/synapse" });

beforeAll(async () => {
  await migrate();
  await seed(undefined, true);
  app = await build({ logger: false, rateLimit: 60 });
  await app.ready();
  spec = app.swagger() as unknown as typeof spec;
}, 120_000);
afterAll(async () => { await app.close(); await pool.end(); });

const v1 = supportWorkflow("atlas-large", 1), v2 = supportWorkflow("nova-pro", 2, "nova-lite");
let runId = "";

describe("contract", () => {
  it("is OpenAPI 3.1 and covers the blueprint's endpoints", () => {
    const s = app.swagger() as { openapi: string; paths: Record<string, unknown> };
    expect(s.openapi).toBe("3.1.0");
    for (const p of ["/v1/workflows", "/v1/workflows/{id}", "/v1/workflows/{id}/compile", "/v1/workflows/{id}/runs", "/v1/runs/{id}", "/v1/runs/{id}/steps", "/v1/runs/{id}/replay", "/v1/evaluations", "/v1/tools/test", "/v1/models/catalog"])
      expect(Object.keys(s.paths)).toContain(p);
  });
  it("lists the simulated model catalog publicly", async () => {
    expect((await call("GET", "/v1/models/catalog")).json().items).toHaveLength(4);
  });
});

describe("workflows, runs, authz", () => {
  it("authorization matrix for saving a workflow", async () => {
    expect((await call("POST", "/v1/workflows", key(), v1)).statusCode).toBe(401);
    expect((await call("POST", "/v1/workflows", { ...VIEW, ...key() }, v1)).statusCode).toBe(403);
    expect((await call("POST", "/v1/workflows", { ...OP }, v1)).statusCode).toBe(400); // no Idempotency-Key
    const r = await call("POST", "/v1/workflows", { ...OP, ...key() }, v1);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id: "wf-support", version: 1, compiled: true });
    expect((await call("POST", "/v1/workflows", { ...OP, ...key() }, v1)).statusCode).toBe(409);
    const p = await call("PUT", "/v1/workflows/wf-support", { ...OP, ...key() }, v2, "/v1/workflows/{id}");
    expect(p.json().version).toBe(2);
    expect((await call("GET", "/v1/workflows/wf-support?version=1", OP, undefined, "/v1/workflows/{id}")).json().workflow.nodes[2].config.model).toBe("atlas-large");
    expect((await call("POST", "/v1/workflows/wf-support/compile", OP, undefined, "/v1/workflows/{id}/compile")).json().ok).toBe(true);
    const bad = await call("POST", "/v1/workflows", { ...OP, ...key() }, { ...v1, id: "wf-bad", edges: [] });
    expect(bad.json().compiled).toBe(false);
    expect((await call("POST", "/v1/workflows/wf-bad/runs", { ...OP, ...key() }, {}, "/v1/workflows/{id}/runs")).json().error.code).toBe("does_not_compile");
  });
  it("runs the sample with the scripted CRM timeout and stores a redacted trace", async () => {
    const r = await call("POST", "/v1/workflows/wf-support/runs", { ...OP, ...key() }, { version: 1, emailId: "sample", faults: { forced: { "sample:crm#1": "timeout" } } }, "/v1/workflows/{id}/runs");
    expect(r.statusCode).toBe(201);
    const run = r.json().run;
    runId = run.id;
    expect(run.status).toBe("succeeded");
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === "crm").attempts.map((a: { status: number }) => a.status)).toEqual([504, 200]);
    expect(run.output.category).toBe("billing");
    const one = await call("GET", `/v1/runs/${runId}`, OP, undefined, "/v1/runs/{id}");
    expect(one.json().totalCostUsd).toBeCloseTo(run.totalCostUsd, 12);
    const page = await call("GET", `/v1/runs/${runId}/steps?limit=4`, OP, undefined, "/v1/runs/{id}/steps");
    expect(page.json().items).toHaveLength(4);
    const rest = await call("GET", `/v1/runs/${runId}/steps?limit=4&cursor=${page.json().nextCursor}`, OP, undefined, "/v1/runs/{id}/steps");
    expect(rest.json().items.map((s: { sequence_no: number }) => s.sequence_no)).toEqual([4, 5]);
  });
  it("never lets a secret or the raw e-mail reach a response or a stored row", async () => {
    const c = owner(); await c.connect();
    const dump = JSON.stringify((await c.query("SELECT result, options FROM runs")).rows) + JSON.stringify((await c.query("SELECT input_json, output_json FROM run_steps")).rows);
    await c.end();
    for (const v of Object.values(CRM_KEYS)) expect(dump).not.toContain(v);
    expect(dump).not.toContain("jordan.lee@example.com");
    expect(dump).not.toContain("4242");
    expect(dump).toContain("secret://crm-api-key");
    const resp = (await call("GET", `/v1/runs/${runId}`, OP, undefined, "/v1/runs/{id}")).body;
    for (const v of Object.values(CRM_KEYS)) expect(resp).not.toContain(v);
  });
  it("replay gives identical step ordering and values", async () => {
    const r = await call("POST", `/v1/runs/${runId}/replay`, { ...OP, ...key() }, {}, "/v1/runs/{id}/replay");
    expect(r.json().identical).toBe(true);
    expect(r.json().run.id).not.toBe(runId);
  });
  it("failure injection: 429, 500s with fallback, provider outage with and without the router", async () => {
    const go = (body: object) => call("POST", "/v1/workflows/wf-support/runs", { ...OP, ...key() }, { version: 1, emailId: "sample", ...body }, "/v1/workflows/{id}/runs").then((r) => r.json().run);
    const a = await go({ faults: { forced: { "sample:classify:atlas-large#1": 429 } } });
    expect(a.steps[2].attempts.map((x: { status: number; backoffMs: number }) => `${x.status}:${x.backoffMs}`)).toEqual(["429:0", "200:1000"]);
    const b = await go({ faults: { forced: { "sample:classify:atlas-large#1": 500, "sample:classify:atlas-large#2": 500, "sample:classify:atlas-large#3": 500 } } });
    expect(b.fallbacks).toBe(1);
    expect((await go({ faults: { providerDown: ["Atlas AI"] } })).status).toBe("failed");
    const d = await go({ faults: { providerDown: ["Atlas AI"] }, modelOverride: "auto" });
    expect(d.status).toBe("succeeded");
    expect(d.steps[2].model).toBe("nova-pro");
    expect((await call("POST", "/v1/workflows/wf-support/runs", { ...OP, ...key() }, { modelOverride: "gpt-9" }, "/v1/workflows/{id}/runs")).json().error.code).toBe("unknown_model");
  });
  it("tests a tool with the tenant's own credential", async () => {
    const r = await call("POST", "/v1/tools/test", { ...OP, ...key() }, { tool: "crm", orderId: "ORD-48213" });
    expect(r.json().result.found).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("another organisation cannot read, run or guess Acme's workflows and runs", async () => {
    expect((await call("GET", "/v1/workflows/wf-support", OTHER, undefined, "/v1/workflows/{id}")).statusCode).toBe(404);
    expect((await call("GET", `/v1/runs/${runId}`, OTHER, undefined, "/v1/runs/{id}")).statusCode).toBe(404);
    expect((await call("POST", "/v1/workflows/wf-support/runs", { ...OTHER, ...key() }, {}, "/v1/workflows/{id}/runs")).statusCode).toBe(404);
    expect((await call("POST", `/v1/runs/${runId}/replay`, { ...OTHER, ...key() }, {}, "/v1/runs/{id}/replay")).statusCode).toBe(404);
    // Globex may own a workflow with the same id: it is a different row
    expect((await call("POST", "/v1/workflows", { ...OTHER, ...key() }, v1)).statusCode).toBe(201);
    expect((await call("GET", "/v1/workflows/wf-support", OTHER, undefined, "/v1/workflows/{id}")).json().version).toBe(1);
  });
  it("row-level security holds for raw queries and cross-tenant inserts", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://synapse_app:app-dev-only@127.0.0.1:55440/synapse" });
    await c.connect();
    expect((await c.query("SELECT count(*)::int n FROM runs")).rows[0].n).toBe(0);
    expect((await c.query("SELECT count(*)::int n FROM secrets")).rows[0].n).toBe(0);
    const g = (await c.query("SELECT id FROM organizations WHERE slug = 'globex'")).rows[0].id;
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant', $1, true)", [g]);
    expect((await c.query("SELECT count(*)::int n FROM secrets")).rows[0].n).toBe(1);
    await expect(c.query("INSERT INTO secrets (tenant_id, name, nonce, value_enc) SELECT id, 'x', '\\x00', '\\x00' FROM organizations WHERE slug = 'acme'")).rejects.toThrow(/row-level security/);
    await c.query("ROLLBACK"); await c.end();
  });
});

describe("evaluation, release gate, published endpoint", () => {
  let endpoint = { slug: "", key: "" };
  it("evaluates two versions and the gate blocks publishing the regression", async () => {
    const e = await call("POST", "/v1/evaluations", { ...OP, ...key() }, { workflowId: "wf-support", versions: [1, 2] });
    expect(e.statusCode).toBe(201);
    expect(e.json().gate.pass).toBe(false);
    expect(e.json().summaries[1].costPerRun).toBeLessThan(e.json().summaries[0].costPerRun);
    const blocked = await call("POST", "/v1/workflows/wf-support/publish", { ...OP, ...key() }, { version: 2 }, "/v1/workflows/{id}/publish");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("gate_failed");
    const ok = await call("POST", "/v1/workflows/wf-support/publish", { ...OP, ...key() }, { version: 1 }, "/v1/workflows/{id}/publish");
    expect(ok.statusCode).toBe(201);
    endpoint = ok.json();
    expect(endpoint.key).toMatch(/^sk_/);
  });
  it("the endpoint runs with its key, refuses without it, and stores no key", async () => {
    const body = { subject: "Double charge", body: "I was charged twice for order ORD-77777, please refund. Call +1 (555) 012-3456." };
    expect((await call("POST", `/v1/endpoints/${endpoint.slug}/invoke`, { authorization: "Bearer sk_wrong" }, body, "/v1/endpoints/{slug}/invoke")).statusCode).toBe(401);
    const r = await call("POST", `/v1/endpoints/${endpoint.slug}/invoke`, { authorization: `Bearer ${endpoint.key}` }, body, "/v1/endpoints/{slug}/invoke");
    expect(r.statusCode).toBe(200);
    expect(r.json().reply).not.toContain("555");
    const c = owner(); await c.connect();
    expect(JSON.stringify((await c.query("SELECT * FROM endpoints")).rows)).not.toContain(endpoint.key);
    await c.end();
    expect((await call("POST", "/v1/endpoints/nope/invoke", { authorization: `Bearer ${endpoint.key}` }, body, "/v1/endpoints/{slug}/invoke")).statusCode).toBe(404);
  });
});

describe("idempotency, audit, operations", () => {
  it("replays the same key, refuses a reused key with a different body", async () => {
    const h = { ...OP, "idempotency-key": "same-key-0001" };
    const a = await call("POST", "/v1/workflows/wf-support/runs", h, { version: 1, emailId: "em-002" }, "/v1/workflows/{id}/runs");
    const b = await call("POST", "/v1/workflows/wf-support/runs", h, { version: 1, emailId: "em-002" }, "/v1/workflows/{id}/runs");
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json().run.id).toBe(a.json().run.id);
    expect((await call("POST", "/v1/workflows/wf-support/runs", h, { version: 1, emailId: "em-003" }, "/v1/workflows/{id}/runs")).statusCode).toBe(409);
  });
  it("keeps a valid hash-chained audit log per tenant", async () => {
    const a = await call("GET", "/v1/audit", OP);
    expect(a.json().chainValid).toBe(true);
    expect(a.json().items.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(["workflow.save", "run.execute", "evaluation.run", "endpoint.publish"]));
    expect((await call("GET", "/v1/audit", OTHER)).json().items.every((x: { action: string }) => x.action === "workflow.save")).toBe(true);
  });
  it("streams a stored run's trace over WebSocket in order", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/runs/${runId}/stream?token=acme-builder-demo&rate=20`);
    const events: { t: number; type: string }[] = [];
    await new Promise<void>((ok, bad) => { ws.on("message", (m: Buffer) => { const e = JSON.parse(String(m)); events.push(e); if (e.type === "run.end") ok(); }); setTimeout(() => bad(new Error("stream did not end")), 5000); });
    ws.close();
    expect(events[0]).toMatchObject({ type: "step.start", nodeId: "trigger" });
    expect(events.at(-1)!.type).toBe("run.end");
    for (let i = 1; i < events.length; i++) expect(events[i].t).toBeGreaterThanOrEqual(events[i - 1].t);
    expect(events.filter((e) => e.type === "attempt.end").length).toBeGreaterThan(3);
  });
  it("propagates trace ids, exposes metrics, rate-limits with headers", async () => {
    const tp = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const r = await app.inject({ method: "GET", url: "/v1/models/catalog", headers: { traceparent: tp } });
    expect(String(r.headers.traceparent)).toContain("0123456789abcdef0123456789abcdef");
    expect((await app.inject({ method: "GET", url: "/metrics" })).body).toMatch(/synapse_request_latency_ms\{route="POST \/v1\/workflows\/:id\/runs",quantile="0.95"\}/);
    let last = 200;
    for (let i = 0; i < 80 && last !== 429; i++) last = (await app.inject({ method: "GET", url: "/v1/models/catalog", headers: VIEW })).statusCode;
    expect(last).toBe(429);
    const nope = await call("GET", `/v1/runs/${runId}`, VIEW, undefined, "/v1/runs/{id}");
    expect(nope.statusCode).toBe(429);
    expect(nope.headers["retry-after"]).toBeDefined();
  });
});
