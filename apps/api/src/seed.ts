// Seeds two organisations, demo tokens, and each organisation's encrypted CRM credential. Workflows come from the clients.
// Demo tokens are local-only and printed in the README.
import pg from "pg";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { uuidV } from "./ids.ts";
import { sha256 } from "./db.ts";

export const ORGS = [
  { id: uuidV("org", "acme"), slug: "acme", name: "Acme Support", plan: "scale" },
  { id: uuidV("org", "globex"), slug: "globex", name: "Globex Help Desk", plan: "startup" },
] as const;
export const TOKENS = [
  { token: "acme-builder-demo", org: "acme", role: "operator" },
  { token: "acme-viewer-demo", org: "acme", role: "viewer" },
  { token: "globex-builder-demo", org: "globex", role: "operator" },
] as const;
/** The simulated CRM accepts any key starting crm_live_; each tenant gets its own. */
export const CRM_KEYS: Record<string, string> = { acme: "crm_live_AcmeLocalDemoKey", globex: "crm_live_GlobexLocalDemoKey" };

const key = () => Buffer.from(sha256(process.env.SECRET_KEY ?? "local-dev-secret-key-not-for-production"), "hex");
export function encrypt(value: string) {
  const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), nonce);
  return { nonce, enc: Buffer.concat([c.update(value, "utf8"), c.final(), c.getAuthTag()]) };
}
export function decrypt(nonce: Buffer, enc: Buffer) {
  const d = createDecipheriv("aes-256-gcm", key(), nonce);
  d.setAuthTag(enc.subarray(enc.length - 16));
  return Buffer.concat([d.update(enc.subarray(0, enc.length - 16)), d.final()]).toString("utf8");
}

export async function seed(url = process.env.OWNER_DATABASE_URL ?? "postgresql://synapse:owner-dev-only@127.0.0.1:55440/synapse", reset = false) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  if (reset) await c.query("TRUNCATE endpoints, evaluations, run_steps, runs, workflow_nodes, workflows, workspaces, secrets, api_tokens, idempotency_keys, audit_log, client_telemetry, organizations CASCADE");
  if ((await c.query("SELECT count(*)::int n FROM organizations")).rows[0].n > 0 && !reset) { await c.query("ROLLBACK"); await c.end(); return; }
  for (const o of ORGS) {
    await c.query("INSERT INTO organizations (id, slug, name, plan) VALUES ($1,$2,$3,$4)", [o.id, o.slug, o.name, o.plan]);
    await c.query("INSERT INTO workspaces (id, name, owner_org_id) VALUES ($1,$2,$3)", [uuidV("ws", o.slug), `${o.name} workspace`, o.id]);
    const e = encrypt(CRM_KEYS[o.slug]);
    await c.query("INSERT INTO secrets (tenant_id, name, nonce, value_enc) VALUES ($1,'crm-api-key',$2,$3)", [o.id, e.nonce, e.enc]);
  }
  for (const t of TOKENS) await c.query("INSERT INTO api_tokens (token_sha256, organization_id, role, label) VALUES ($1,$2,$3,$4)", [sha256(t.token), ORGS.find((o) => o.slug === t.org)!.id, t.role, t.token]);
  await c.query("COMMIT");
  await c.end();
  console.log(JSON.stringify({ msg: "seeded", orgs: ORGS.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) await seed(undefined, process.argv.includes("--reset"));
