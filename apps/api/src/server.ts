// SYNAPSE API: one Fastify process standing in for the blueprint's workflow-api, compiler, agent-runtime, model-router,
// tool-executor, retrieval, evaluation, trace, secret and billing services (README "Not built" says why it is one process).
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import { randomBytes } from "node:crypto";
import {
  MODELS, SecretStore, canonical, compile, crmLookup, evaluate, gate, makeEmails, run, SAMPLE_EMAIL, type Email, type Faults, type RunResult, type Workflow,
} from "../../../packages/domain/src/index.ts";
import { audit, pool, sha256, withTenant } from "./db.ts";
import { decrypt } from "./seed.ts";
import { newId, uuidV } from "./ids.ts";

interface Auth { org: string; slug: string; role: "viewer" | "operator" | "admin"; label: string }
declare module "fastify" { interface FastifyRequest { auth?: Auth; traceId: string; t0: bigint } }

class ApiError extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}

const Err = { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, traceId: { type: "string" }, details: {} } } } };
const Any = { type: "object", additionalProperties: true };
const Arr = { type: "array", items: Any };
const NodeS = { type: "object", required: ["id", "type", "label", "x", "y", "config"], properties: { id: { type: "string", pattern: "^[a-z0-9-]{1,40}$" }, type: { type: "string" }, label: { type: "string", maxLength: 80 }, x: { type: "number" }, y: { type: "number" }, config: Any, group: { type: "string" } } };
const WorkflowS = { type: "object", required: ["id", "name", "nodes", "edges"], properties: { id: { type: "string", pattern: "^[a-z0-9-]{1,60}$" }, name: { type: "string", maxLength: 120 }, version: { type: "integer" }, nodes: { type: "array", maxItems: 2100, items: NodeS }, edges: { type: "array", maxItems: 5200, items: { type: "object", required: ["id", "from", "to"], properties: { id: { type: "string" }, from: { type: "string" }, to: { type: "string" } } } } } };
const Saved = { type: "object", properties: { id: { type: "string" }, uuid: { type: "string" }, version: { type: "integer" }, compiled: { type: "boolean" }, issues: Arr } };
const RunS = { type: "object", additionalProperties: true, required: ["id", "status", "steps", "totalCostUsd", "totalLatencyMs"], properties: { id: { type: "string" }, status: { type: "string", enum: ["succeeded", "failed"] }, steps: Arr, totalCostUsd: { type: "number" }, totalLatencyMs: { type: "number" } } };
const Faults = { type: "object", properties: { forced: { type: "object", additionalProperties: { anyOf: [{ type: "integer" }, { type: "string", enum: ["timeout", "malformed"] }] } }, providerDown: { type: "array", items: { type: "string" }, maxItems: 4 } } };
const idemHeader = { type: "object", properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 128 } }, required: ["idempotency-key"] };
const sec = [{ bearer: [] }];
const P = (k: string) => ({ type: "object", properties: { [k]: { type: "string" } } });

function limiter(capacity: number, perSec: number) {
  const b = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now(), s = b.get(key) ?? { tokens: capacity, at: now };
    s.tokens = Math.min(capacity, s.tokens + ((now - s.at) / 1000) * perSec); s.at = now;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    b.set(key, s);
    return { ok, remaining: Math.floor(s.tokens), resetS: Math.ceil((capacity - s.tokens) / perSec) };
  };
}

const EMAILS: Email[] = [SAMPLE_EMAIL, ...makeEmails()];

export async function build(opts: { rateLimit?: number; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, genReqId: () => randomBytes(8).toString("hex"), bodyLimit: 2 * 1024 * 1024 });
  const limit = limiter(opts.rateLimit ?? 120, (opts.rateLimit ?? 120) / 60);
  const metrics = new Map<string, { n: number; errors: number; lat: number[] }>();
  let wsClients = 0;

  await app.register(swagger, {
    openapi: { openapi: "3.1.0", info: { title: "SYNAPSE API", version: "1.0.0", description: "Visual agent workflow builder on simulated providers. Mutations need an Idempotency-Key header. Errors are {error:{code,message,traceId}}. Lists are paginated with ?limit and ?cursor (nextCursor)." },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, servers: [{ url: "http://localhost:8440" }] },
  });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    req.t0 = process.hrtime.bigint();
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(String(req.headers.traceparent ?? ""));
    req.traceId = m ? m[1] : randomBytes(16).toString("hex");
    reply.header("traceparent", `00-${req.traceId}-${randomBytes(8).toString("hex")}-01`).header("x-content-type-options", "nosniff").header("cache-control", "no-store");
    const origin = String(req.headers.origin ?? "");
    if ((process.env.CORS_ORIGINS ?? "http://localhost:8441,http://127.0.0.1:8441").split(",").includes(origin))
      reply.header("access-control-allow-origin", origin).header("vary", "origin").header("access-control-allow-methods", "GET,POST,PUT").header("access-control-allow-headers", "authorization,content-type,idempotency-key,traceparent").header("access-control-expose-headers", "traceparent,ratelimit-limit,ratelimit-remaining,ratelimit-reset");
    if (req.method === "OPTIONS") return reply.code(204).send();
    const h = String(req.headers.authorization ?? "");
    if (h.startsWith("Bearer ") && !req.url.startsWith("/v1/endpoints/")) {
      const r = await pool.query("SELECT t.role, t.label, o.id, o.slug FROM api_tokens t JOIN organizations o ON o.id = t.organization_id WHERE t.token_sha256 = $1", [sha256(h.slice(7))]);
      if (!r.rows[0]) throw new ApiError(401, "unauthenticated", "unknown token");
      req.auth = { org: r.rows[0].id, slug: r.rows[0].slug, role: r.rows[0].role, label: r.rows[0].label };
    }
    const rl = limit(req.auth?.label ?? req.ip);
    reply.header("ratelimit-limit", opts.rateLimit ?? 120).header("ratelimit-remaining", rl.remaining).header("ratelimit-reset", rl.resetS);
    if (!rl.ok) { reply.header("retry-after", rl.resetS); throw new ApiError(429, "rate_limited", "too many requests"); }
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`;
    const m = metrics.get(route) ?? { n: 0, errors: 0, lat: [] };
    m.n++; if (reply.statusCode >= 500) m.errors++;
    m.lat.push(Number(process.hrtime.bigint() - req.t0) / 1e6); if (m.lat.length > 2000) m.lat.shift();
    metrics.set(route, m);
    req.log.info({ traceId: req.traceId, route, status: reply.statusCode, tenant: req.auth?.slug }, "request");
  });
  app.setErrorHandler((e: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (e instanceof ApiError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, traceId: req.traceId, details: e.details } });
    if (e.validation) return reply.code(400).send({ error: { code: "invalid_request", message: e.message, traceId: req.traceId } });
    req.log.error({ err: e, traceId: req.traceId }, "unhandled");
    const s = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(s).send({ error: { code: s === 500 ? "internal" : "bad_request", message: s === 500 ? "internal error" : e.message, traceId: req.traceId } });
  });

  const need = (req: FastifyRequest, role?: "operator"): Auth => {
    if (!req.auth) throw new ApiError(401, "unauthenticated", "Bearer token required");
    if (role && req.auth.role === "viewer") throw new ApiError(403, "forbidden", "viewer tokens cannot change anything");
    return req.auth;
  };
  async function idempotent(req: FastifyRequest, reply: FastifyReply, tenant: string, run: () => Promise<{ status: number; body: unknown }>) {
    const key = String(req.headers["idempotency-key"]);
    const hash = sha256(JSON.stringify(req.body ?? null) + req.url);
    const prior = await withTenant(tenant, (c) => c.query("SELECT request_sha256, status, response FROM idempotency_keys WHERE key = $1", [key]));
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash) throw new ApiError(409, "idempotency_conflict", "this Idempotency-Key was used with a different request");
      return reply.code(prior.rows[0].status).header("idempotent-replayed", "true").send(prior.rows[0].response);
    }
    const out = await run();
    await withTenant(tenant, (c) => c.query("INSERT INTO idempotency_keys (tenant_id, key, method, path, request_sha256, status, response) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [tenant, key, req.method, req.url, hash, out.status, out.body]));
    return reply.code(out.status).send(out.body);
  }
  /** Secrets for one tenant, decrypted only inside the runtime call. */
  const secretsFor = async (tenant: string) => {
    const r = await withTenant(tenant, (c) => c.query("SELECT name, nonce, value_enc FROM secrets"));
    const s = new SecretStore();
    for (const x of r.rows) s.set(x.name, decrypt(x.nonce, x.value_enc));
    return s;
  };
  const latest = async (tenant: string, slug: string, version?: number) => {
    const r = await withTenant(tenant, (c) => c.query(`SELECT id, version, graph_json FROM workflows WHERE slug = $1 AND deleted_at IS NULL ${version ? "AND version = $2" : ""} ORDER BY version DESC LIMIT 1`, version ? [slug, version] : [slug]));
    if (!r.rows[0]) throw new ApiError(404, "not_found", `no workflow ${slug}${version ? ` v${version}` : ""}`); // other tenants' workflows are invisible, so they 404 too
    return { uuid: r.rows[0].id as string, version: r.rows[0].version as number, wf: r.rows[0].graph_json as Workflow };
  };
  async function save(a: Auth, wf: Workflow, version: number, req: FastifyRequest) {
    const id = newId();
    const graph = { ...wf, version };
    const { issues } = compile(graph);
    await withTenant(a.org, async (c) => {
      await c.query("INSERT INTO workflows (id, tenant_id, workspace_id, slug, name, version, graph_json, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, a.org, uuidV("ws", a.slug), wf.id, wf.name, version, graph, issues.length ? "draft" : "valid", a.label]);
      for (const n of wf.nodes) await c.query("INSERT INTO workflow_nodes (id, tenant_id, workflow_id, node_key, node_type, provider, model, config, x, y) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [newId(), a.org, id, n.id, n.type, n.config.model ? MODELS.find((m) => m.id === n.config.model)?.provider ?? null : null, (n.config.model as string) ?? null, n.config, n.x, n.y]);
      await audit(c, a.org, a.label, "workflow.save", `${wf.id}@${version}`, { nodes: wf.nodes.length, issues: issues.length }, req.traceId);
    });
    return { id: wf.id, uuid: id, version, compiled: issues.length === 0, issues };
  }
  /** Execute and persist one run: the trace stored is the redacted one, so no secret or raw e-mail is written anywhere. */
  async function execute(a: Auth | { org: string; label: string; slug: string }, w: { uuid: string; version: number; wf: Workflow }, o: { emailId?: string; email?: { subject: string; body: string }; faults?: Faults; modelOverride?: string }, traceId: string) {
    const email: Email = o.email ? { id: `adhoc-${sha256(o.email.body).slice(0, 8)}`, subject: o.email.subject, body: o.email.body, from: "", label: "other", orderId: null, facts: [] } : EMAILS.find((e) => e.id === (o.emailId ?? "sample")) ?? SAMPLE_EMAIL;
    if (!compile(w.wf).plan) throw new ApiError(422, "does_not_compile", "workflow does not compile", compile(w.wf).issues);
    const r: RunResult = run(w.wf, email, { secrets: await secretsFor(a.org), faults: o.faults, modelOverride: o.modelOverride, truth: o.email ? undefined : email });
    const id = newId();
    const t0 = Date.now();
    await withTenant(a.org, async (c) => {
      await c.query("INSERT INTO runs (id, tenant_id, workflow_id, workflow_version, status, started_at, completed_at, total_cost_usd, total_latency_ms, options, result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [id, a.org, w.uuid, w.version, r.status, new Date(t0), new Date(t0 + r.totalLatencyMs), r.totalCostUsd, r.totalLatencyMs, { emailId: o.email ? null : email.id, email: o.email ? { subject: o.email.subject, bodySha256: sha256(o.email.body) } : null, faults: o.faults ?? null, modelOverride: o.modelOverride ?? null }, { ...r, id }]);
      const nodes = (await c.query("SELECT id, node_key FROM workflow_nodes WHERE workflow_id = $1", [w.uuid])).rows;
      for (const s of r.steps) await c.query("INSERT INTO run_steps (id, tenant_id, run_id, node_id, sequence_no, input_json, output_json, latency_ms, token_in, token_out, cost_usd, status, started_at, completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [newId(), a.org, id, nodes.find((n) => n.node_key === s.nodeId)?.id ?? null, s.seq, { input: s.input }, { output: s.output, attempts: s.attempts, error: s.error ?? null }, s.latencyMs, s.tokenIn, s.tokenOut, s.costUsd, s.status, new Date(t0 + s.startMs), new Date(t0 + s.endMs)]);
      await audit(c, a.org, a.label, "run.execute", id, { workflow: `${w.wf.id}@${w.version}`, status: r.status, costUsd: r.totalCostUsd }, traceId);
    });
    return { ...r, id };
  }
  const getRun = async (org: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(400, "invalid_request", "bad run id");
    const r = await withTenant(org, (c) => c.query("SELECT r.result, r.options, r.workflow_id, w.slug, w.version, w.graph_json FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1", [id]));
    if (!r.rows[0]) throw new ApiError(404, "not_found", `no run ${id}`);
    return r.rows[0];
  };

  // ---------- routes ----------
  app.get("/healthz", { schema: { hide: true } }, async () => { await pool.query("SELECT 1"); return { ok: true }; });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/metrics", { schema: { hide: true } }, async (_, reply) => {
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    const lines = ["# TYPE synapse_requests_total counter", "# TYPE synapse_request_latency_ms summary"];
    for (const [r, m] of metrics) {
      lines.push(`synapse_requests_total{route="${r}"} ${m.n}`, `synapse_request_errors_total{route="${r}"} ${m.errors}`);
      for (const p of [0.5, 0.95, 0.99]) lines.push(`synapse_request_latency_ms{route="${r}",quantile="${p}"} ${q(m.lat, p).toFixed(2)}`);
    }
    lines.push(`synapse_db_pool_total ${pool.totalCount}`, `synapse_db_pool_waiting ${pool.waitingCount}`, `synapse_ws_streams ${wsClients}`);
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  app.get("/v1/models/catalog", { schema: { tags: ["models"], summary: "Simulated providers: price list, latency and quality profile", response: { 200: { type: "object", properties: { items: Arr, note: { type: "string" } } } } } }, async () =>
    ({ items: MODELS, note: "simulated providers; prices and behaviour are set in packages/domain/src/providers.ts" }));

  app.post("/v1/workflows", { schema: { tags: ["workflows"], security: sec, headers: idemHeader, body: WorkflowS, response: { 201: Saved, 400: Err, 401: Err, 403: Err, 409: Err } } }, async (req, reply) => {
    const a = need(req, "operator");
    return idempotent(req, reply, a.org, async () => {
      const wf = req.body as Workflow;
      const exists = await withTenant(a.org, (c) => c.query("SELECT 1 FROM workflows WHERE slug = $1 LIMIT 1", [wf.id]));
      if (exists.rows[0]) throw new ApiError(409, "exists", `workflow ${wf.id} exists: PUT a new version`);
      return { status: 201, body: await save(a, wf, 1, req) };
    });
  });
  app.put("/v1/workflows/:id", { schema: { tags: ["workflows"], security: sec, summary: "Save a new version", headers: idemHeader, params: P("id"), body: WorkflowS, response: { 200: Saved, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } }, async (req, reply) => {
    const a = need(req, "operator");
    return idempotent(req, reply, a.org, async () => {
      const cur = await latest(a.org, (req.params as { id: string }).id);
      const wf = req.body as Workflow;
      // saving a graph identical to an existing version returns that version instead of making a new one
      const all = await withTenant(a.org, (c) => c.query("SELECT id, version, graph_json FROM workflows WHERE slug = $1 AND deleted_at IS NULL", [cur.wf.id]));
      const same = all.rows.find((r) => canonical({ ...r.graph_json, version: 0 }) === canonical({ ...wf, id: cur.wf.id, version: 0 }));
      if (same) return { status: 200, body: { id: cur.wf.id, uuid: same.id, version: same.version, compiled: !!compile(same.graph_json).plan, issues: [] } };
      return { status: 200, body: await save(a, { ...wf, id: cur.wf.id }, Math.max(cur.version + 1, wf.version ?? 0), req) };
    });
  });
  app.get("/v1/workflows/:id", { schema: { tags: ["workflows"], security: sec, params: P("id"), querystring: { type: "object", properties: { version: { type: "integer" } } }, response: { 200: { type: "object", properties: { version: { type: "integer" }, workflow: Any }, additionalProperties: true }, 401: Err, 404: Err } } }, async (req) => {
    const w = await latest(need(req).org, (req.params as { id: string }).id, (req.query as { version?: number }).version);
    return { version: w.version, workflow: w.wf };
  });
  app.post("/v1/workflows/:id/compile", { schema: { tags: ["workflows"], security: sec, params: P("id"), response: { 200: { type: "object", properties: { ok: { type: "boolean" }, plan: { anyOf: [Any, { type: "null" }] }, issues: Arr } }, 401: Err, 404: Err } } }, async (req) => {
    const w = await latest(need(req).org, (req.params as { id: string }).id);
    const { plan, issues } = compile(w.wf);
    return { ok: !!plan, plan, issues };
  });
  app.post("/v1/workflows/:id/runs", { schema: { tags: ["runs"], security: sec, headers: idemHeader, params: P("id"), body: { type: "object", properties: { version: { type: "integer" }, emailId: { type: "string", pattern: "^(sample|em-\\d{3})$" }, email: { type: "object", required: ["subject", "body"], properties: { subject: { type: "string", maxLength: 300 }, body: { type: "string", maxLength: 20000 } } }, faults: Faults, modelOverride: { type: "string" } } }, response: { 201: { type: "object", properties: { run: RunS } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err, 422: Err } } }, async (req, reply) => {
    const a = need(req, "operator");
    return idempotent(req, reply, a.org, async () => {
      const b = req.body as { version?: number; emailId?: string; email?: { subject: string; body: string }; faults?: Faults; modelOverride?: string };
      if (b.modelOverride && b.modelOverride !== "auto" && !MODELS.some((m) => m.id === b.modelOverride)) throw new ApiError(400, "unknown_model", `no model ${b.modelOverride}`);
      const w = await latest(a.org, (req.params as { id: string }).id, b.version);
      return { status: 201, body: { run: await execute(a, w, b, req.traceId) } };
    });
  });
  app.get("/v1/runs/:id", { schema: { tags: ["runs"], security: sec, params: P("id"), response: { 200: RunS, 400: Err, 401: Err, 404: Err } } }, async (req) => (await getRun(need(req).org, (req.params as { id: string }).id)).result);
  app.get("/v1/runs/:id/steps", { schema: { tags: ["runs"], security: sec, params: P("id"), querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, cursor: { type: "string" } } }, response: { 200: { type: "object", properties: { items: Arr, nextCursor: { type: ["string", "null"] } } }, 400: Err, 401: Err, 404: Err } } }, async (req) => {
    const a = need(req), id = (req.params as { id: string }).id;
    await getRun(a.org, id);
    const q = req.query as { limit: number; cursor?: string };
    const after = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) : -1;
    const r = await withTenant(a.org, (c) => c.query("SELECT sequence_no, input_json, output_json, latency_ms, token_in, token_out, cost_usd, status, started_at, completed_at FROM run_steps WHERE run_id = $1 AND sequence_no > $2 ORDER BY sequence_no LIMIT $3", [id, after, q.limit + 1]));
    const items = r.rows.slice(0, q.limit).map((x) => ({ ...x, cost_usd: Number(x.cost_usd) }));
    return { items, nextCursor: r.rows.length > q.limit ? Buffer.from(String(items.at(-1)!.sequence_no)).toString("base64url") : null };
  });
  app.post("/v1/runs/:id/replay", { schema: { tags: ["runs"], security: sec, headers: idemHeader, params: P("id"), response: { 201: { type: "object", properties: { run: RunS, identical: { type: "boolean" }, differences: { type: "array", items: { type: "string" } } } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } }, async (req, reply) => {
    const a = need(req, "operator");
    return idempotent(req, reply, a.org, async () => {
      const old = await getRun(a.org, (req.params as { id: string }).id);
      if (!old.options.emailId) throw new ApiError(400, "not_replayable", "ad-hoc e-mails are not stored, so their runs cannot be replayed");
      const w = await latest(a.org, old.slug, old.version);
      const fresh = await execute(a, w, { emailId: old.options.emailId, faults: old.options.faults ?? undefined, modelOverride: old.options.modelOverride ?? undefined }, req.traceId);
      const strip = (r: RunResult) => r.steps.map((s) => canonical(s)); // jsonb reorders keys: compare canonically
      const A = strip(old.result), B = strip(fresh);
      const differences = A.map((s, i) => (s === B[i] ? null : `step ${i}`)).filter((x): x is string => !!x);
      return { status: 201, body: { run: fresh, identical: differences.length === 0 && A.length === B.length, differences } };
    });
  });
  app.post("/v1/evaluations", { schema: { tags: ["evaluations"], security: sec, headers: idemHeader, body: { type: "object", required: ["workflowId", "versions"], properties: { workflowId: { type: "string" }, versions: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 } } }, response: { 201: { type: "object", properties: { summaries: Arr, gate: Any } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } }, async (req, reply) => {
    const a = need(req, "operator");
    return idempotent(req, reply, a.org, async () => {
      const b = req.body as { workflowId: string; versions: [number, number] };
      const s = await secretsFor(a.org);
      const [wa, wb] = await Promise.all(b.versions.map((v) => latest(a.org, b.workflowId, v)));
      const emails = EMAILS.filter((e) => e.id !== "sample");
      const ea = evaluate(wa.wf, emails, { secrets: s, label: `v${wa.version}` }), eb = evaluate(wb.wf, emails, { secrets: s, label: `v${wb.version}` });
      const g = gate(ea, eb);
      await withTenant(a.org, async (c) => {
        for (const [w, e] of [[wa, ea], [wb, eb]] as const)
          await c.query("INSERT INTO evaluations (id, tenant_id, evaluator_type, score, rationale, metadata) VALUES ($1,$2,'suite',$3,$4,$5)", [newId(), a.org, e.passRate, `pass rate of v${w.version} on ${e.n} labeled e-mails`, { workflow: b.workflowId, version: w.version, against: wa.version, gate: w === wb ? g : null, summary: { ...e, cases: undefined } }]);
        await audit(c, a.org, a.label, "evaluation.run", b.workflowId, { versions: b.versions, gate: g.pass }, req.traceId);
      });
      return { status: 201, body: { summaries: [ea, eb].map((e) => ({ ...e, cases: undefined })), gate: g } };
    });
  });
  app.post("/v1/tools/test", { schema: { tags: ["tools"], security: sec, headers: idemHeader, body: { type: "object", required: ["tool", "orderId"], properties: { tool: { type: "string", enum: ["crm"] }, orderId: { type: "string", pattern: "^ORD-\\d{5}$" } } }, response: { 200: { type: "object", properties: { status: { type: "integer" }, latencyMs: { type: "integer" }, result: Any } }, 400: Err, 401: Err, 403: Err, 409: Err } } }, async (req, reply) => {
    const a = need(req, "operator");
    return idempotent(req, reply, a.org, async () => {
      const s = await secretsFor(a.org);
      const r = crmLookup((req.body as { orderId: string }).orderId, { key: `tooltest:${req.id}`, attempt: 1, apiKey: s.resolve("secret://crm-api-key") });
      return { status: 200, body: { status: r.status, latencyMs: r.latencyMs, result: r.ok ? JSON.parse(r.text) : { error: s.scrub(r.error ?? "") } } };
    });
  });
  app.post("/v1/workflows/:id/publish", { schema: { tags: ["endpoints"], security: sec, headers: idemHeader, params: P("id"), body: { type: "object", properties: { version: { type: "integer" } } }, response: { 201: { type: "object", properties: { slug: { type: "string" }, url: { type: "string" }, key: { type: "string" }, version: { type: "integer" } } }, 401: Err, 403: Err, 404: Err, 409: Err, 422: Err } } }, async (req, reply) => {
    const a = need(req, "operator");
    return idempotent(req, reply, a.org, async () => {
      const w = await latest(a.org, (req.params as { id: string }).id, (req.body as { version?: number } | undefined)?.version);
      if (!compile(w.wf).plan) throw new ApiError(422, "does_not_compile", "only a workflow that compiles can be published");
      // the release gate: the latest evaluation of this version against an earlier one must have passed
      const ev = await withTenant(a.org, (c) => c.query("SELECT metadata FROM evaluations WHERE metadata->>'workflow' = $1 AND (metadata->>'version')::int = $2 AND metadata->'gate' IS NOT NULL AND metadata->'gate' <> 'null' ORDER BY ctid DESC LIMIT 1", [w.wf.id, w.version]));
      const g = ev.rows[0]?.metadata.gate;
      if (g && !g.pass) throw new ApiError(409, "gate_failed", `v${w.version} failed the release gate`, g.rules.filter((r: { ok: boolean }) => !r.ok));
      const slug = `${a.slug}-${w.wf.id}-v${w.version}`, key = `sk_${randomBytes(18).toString("base64url")}`;
      await withTenant(a.org, async (c) => {
        await c.query("INSERT INTO endpoints (slug, tenant_id, workflow_id, key_sha256, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO UPDATE SET key_sha256 = EXCLUDED.key_sha256", [slug, a.org, w.uuid, sha256(key), a.label]);
        await audit(c, a.org, a.label, "endpoint.publish", slug, { version: w.version }, req.traceId);
      });
      return { status: 201, body: { slug, url: `${process.env.PUBLIC_API_URL ?? "http://localhost:8440"}/v1/endpoints/${slug}/invoke`, key, version: w.version } };
    });
  });
  app.post("/v1/endpoints/:slug/invoke", { schema: { tags: ["endpoints"], summary: "Run a published workflow (auth: the endpoint key)", params: P("slug"), body: { type: "object", required: ["subject", "body"], properties: { subject: { type: "string", maxLength: 300 }, body: { type: "string", maxLength: 20000 } } }, response: { 200: { type: "object", properties: { runId: { type: "string" }, category: { type: "string" }, reply: { type: "string" }, latencyMs: { type: "number" }, costUsd: { type: "number" } } }, 401: Err, 404: Err } } }, async (req) => {
    const slug = (req.params as { slug: string }).slug, k = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const e = await pool.query("SELECT e.tenant_id, e.workflow_id, e.key_sha256, o.slug AS org FROM endpoints e JOIN organizations o ON o.id = e.tenant_id WHERE e.slug = $1", [slug]);
    if (!e.rows[0]) throw new ApiError(404, "not_found", `no endpoint ${slug}`);
    if (sha256(k) !== e.rows[0].key_sha256) throw new ApiError(401, "unauthenticated", "endpoint key required");
    const t = e.rows[0].tenant_id as string;
    const w = await withTenant(t, (c) => c.query("SELECT id, version, graph_json FROM workflows WHERE id = $1", [e.rows[0].workflow_id]));
    const r = await execute({ org: t, label: `endpoint:${slug}`, slug: e.rows[0].org }, { uuid: w.rows[0].id, version: w.rows[0].version, wf: w.rows[0].graph_json }, { email: req.body as { subject: string; body: string } }, req.traceId);
    return { runId: r.id, category: r.output.category ?? "", reply: r.output.reply ?? "", latencyMs: r.totalLatencyMs, costUsd: r.totalCostUsd };
  });
  app.get("/v1/audit", { schema: { tags: ["admin"], security: sec, response: { 200: { type: "object", properties: { items: Arr, chainValid: { type: "boolean" } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const r = await withTenant(a.org, (c) => c.query("SELECT tenant_id, actor, action, target, detail, prev_hash, hash, at FROM audit_log ORDER BY id"));
    let prev = "genesis", ok = true;
    for (const x of r.rows) { if (x.prev_hash !== prev || sha256(prev + canonical({ tenant: x.tenant_id, actor: x.actor, action: x.action, target: x.target, detail: x.detail })) !== x.hash) ok = false; prev = x.hash; }
    return { items: r.rows.map((x) => ({ actor: x.actor, action: x.action, target: x.target, at: x.at })), chainValid: ok };
  });
  app.post("/v1/telemetry", { schema: { hide: true } }, async (req, reply) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object") throw new ApiError(400, "invalid_request", "telemetry sample must be an object");
    await pool.query("INSERT INTO client_telemetry (sample) VALUES ($1)", [body]);
    return reply.code(204).send();
  });

  // trace stream: replays a stored run's step events at its own pace (?rate=1 real time), so a client can animate it live
  app.get("/v1/runs/:id/stream", { websocket: true, schema: { hide: true } }, async (socket, req) => {
    const token = String((req.query as { token?: string }).token ?? "");
    const rate = Math.max(0.1, Math.min(20, Number((req.query as { rate?: string }).rate ?? 1)));
    const t = await pool.query("SELECT o.id FROM api_tokens a JOIN organizations o ON o.id = a.organization_id WHERE a.token_sha256 = $1", [sha256(token)]);
    if (!t.rows[0]) { socket.send(JSON.stringify({ error: { code: "unauthenticated", message: "token query parameter required" } })); socket.close(); return; }
    let r: RunResult;
    try { r = (await getRun(t.rows[0].id, (req.params as { id: string }).id)).result; } catch { socket.send(JSON.stringify({ error: { code: "not_found", message: "no such run" } })); socket.close(); return; }
    wsClients++;
    const events = r.steps.flatMap((s) => [{ t: s.startMs, type: "step.start", nodeId: s.nodeId }, ...s.attempts.map((x) => ({ t: x.startMs + x.latencyMs, type: "attempt.end", nodeId: s.nodeId, status: x.status, error: x.error ?? null })), { t: s.endMs, type: "step.end", nodeId: s.nodeId, status: s.status, latencyMs: s.latencyMs, tokens: s.tokenIn + s.tokenOut, costUsd: s.costUsd }]).sort((a, b) => a.t - b.t);
    const timers = events.map((e) => setTimeout(() => socket.readyState === 1 && socket.send(JSON.stringify(e)), e.t / rate));
    timers.push(setTimeout(() => { if (socket.readyState === 1) { socket.send(JSON.stringify({ t: r.totalLatencyMs, type: "run.end", status: r.status })); socket.close(); } }, r.totalLatencyMs / rate + 20));
    socket.on("close", () => { timers.forEach(clearTimeout); wsClients--; });
  });

  return app;
}
