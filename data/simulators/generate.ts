// Synthetic data generator: labeled e-mails, trace fixtures (success, tool timeout, malformed output, model fallback, provider
// outage), the provider price list and the evaluation baseline, with provenance. Deterministic for a given seed.
// Run: node data/simulators/generate.ts   (writes data/fixtures/*.json)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { MODELS, SAMPLE_EMAIL, SAMPLE_FAULTS, demoSecrets, evaluate, gate, makeEmails, run, supportWorkflow } from "../../packages/domain/src/index.ts";

const out = new URL("../fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
const seed = Number(process.env.SEED ?? 11);
const emails = makeEmails(60, seed), secrets = demoSecrets();
const v1 = supportWorkflow("atlas-large", 1), v2 = supportWorkflow("nova-pro", 2, "nova-lite");
const fx = (faults: object, wf = v1) => run(wf, SAMPLE_EMAIL, { secrets, faults, truth: SAMPLE_EMAIL });
const traces = {
  success: fx({}),
  toolTimeout: fx(SAMPLE_FAULTS),
  malformedOutput: fx({ forced: { "sample:classify:nova-pro#1": "malformed" } }, v2),
  modelFallback: fx({ forced: { "sample:classify:atlas-large#1": 500, "sample:classify:atlas-large#2": 500, "sample:classify:atlas-large#3": 500 } }),
  providerOutage: fx({ providerDown: ["Atlas AI"] }),
};
const a = evaluate(v1, emails, { secrets, label: "v1" }), b = evaluate(v2, emails, { secrets, label: "v2" });
const files: Record<string, unknown> = {
  "emails.json": { seed, count: emails.length, emails: emails.map(({ id, subject, body, label, orderId, facts, nearDuplicateOf }) => ({ id, subject, body, label, orderId, facts, nearDuplicateOf })) },
  "traces.json": traces,
  "models.json": { note: "simulated providers and an invented price list", models: MODELS },
  "eval-baseline.json": { v1: { ...a, cases: undefined }, v2: { ...b, cases: undefined }, gate: gate(a, b) },
};
const sha: Record<string, string> = {};
for (const [name, body] of Object.entries(files)) { const s = JSON.stringify(body, null, 1); writeFileSync(new URL(name, out), s); sha[name] = createHash("sha256").update(s).digest("hex"); }
const checks = {
  emails: emails.length, labelsPresent: emails.every((e) => e.label && e.facts.length), nearDuplicates: emails.filter((e) => e.nearDuplicateOf).length,
  traceStatuses: Object.fromEntries(Object.entries(traces).map(([k, r]) => [k, r.status])),
  secretsAbsent: secrets.values().every((v) => !JSON.stringify(files).includes(v)),
};
if (!checks.secretsAbsent || !checks.labelsPresent) throw new Error("quality checks failed: " + JSON.stringify(checks));
writeFileSync(new URL("provenance.json", out), JSON.stringify({ datasets: Object.keys(files).map((f) => ({ file: f, provider: "synthetic: packages/domain (this repository)", license: "MIT", seed, transformationVersion: "synapse-fixtures-v1", sha256: sha[f] })), qualityChecks: checks }, null, 1));
console.log(JSON.stringify(checks));
