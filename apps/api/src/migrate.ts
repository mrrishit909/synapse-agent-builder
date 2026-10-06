// Applies migrations/*.sql in order, once each, as the database owner. Migrations are additive (new tables/columns only), so an
// older API version keeps working against a newer schema; the rollback plan is forward-fix.
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

export async function migrate(url = process.env.OWNER_DATABASE_URL ?? "postgresql://synapse:owner-dev-only@127.0.0.1:55440/synapse") {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())");
  const done = new Set((await c.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await c.query("BEGIN");
    await c.query(readFileSync(new URL(f, dir), "utf8"));
    await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [f]);
    await c.query("COMMIT");
    console.log(JSON.stringify({ msg: "migration applied", version: f }));
  }
  await c.end();
}

if (import.meta.url === `file://${process.argv[1]}`) await migrate();
