// Load test: concurrent clients running the workflow (each request a full simulated run, persisted), mixed with reads; then N
// WebSocket trace streams held open at once.
// node tests/performance/load.ts [base] [clients] [seconds] [streams]
import WebSocket from "ws";
import { supportWorkflow } from "../../packages/domain/src/index.ts";

const [base = "http://127.0.0.1:8440", clients = "32", secs = "10", streams = "1000"] = process.argv.slice(2);
const H = { authorization: "Bearer acme-builder-demo", "content-type": "application/json" };
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
let n = 0;
const key = () => `load-${Date.now()}-${++n}`;

await fetch(`${base}/v1/workflows`, { method: "POST", headers: { ...H, "idempotency-key": key() }, body: JSON.stringify(supportWorkflow()) });
const first = await (await fetch(`${base}/v1/workflows/wf-support/runs`, { method: "POST", headers: { ...H, "idempotency-key": key() }, body: JSON.stringify({ emailId: "sample" }) })).json();
const runId = first.run.id;

const lat: Record<string, number[]> = { run: [], read: [] };
let errors = 0;
const end = Date.now() + +secs * 1000;
await Promise.all(Array.from({ length: +clients }, async (_, c) => {
  for (let i = c; Date.now() < end; i++) {
    const isRun = i % 4 === 0, t = performance.now();
    const r = isRun
      ? await fetch(`${base}/v1/workflows/wf-support/runs`, { method: "POST", headers: { ...H, "idempotency-key": key() }, body: JSON.stringify({ emailId: `em-${String(1 + (i % 60)).padStart(3, "0")}` }) }).catch(() => null)
      : await fetch(`${base}/v1/runs/${runId}`, { headers: H }).catch(() => null);
    (isRun ? lat.run : lat.read).push(performance.now() - t);
    if (!r || r.status >= 400) errors++;
    await r?.arrayBuffer();
  }
}));
const sum = (a: number[]) => ({ n: a.length, p50: +q(a, 0.5).toFixed(1), p95: +q(a, 0.95).toFixed(1), p99: +q(a, 0.99).toFixed(1) });

let open = 0, failed = 0, ended = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: +streams }, () => new Promise<void>((ok) => {
  const s = new WebSocket(`${base.replace(/^http/, "ws")}/v1/runs/${runId}/stream?token=acme-builder-demo&rate=4`);
  s.on("open", () => open++);
  s.on("message", (m) => { if (JSON.parse(String(m)).type === "run.end") ended++; });
  s.on("close", () => ok());
  s.on("error", () => { failed++; ok(); });
})));
console.log(JSON.stringify({ base, clients: +clients, seconds: +secs, rps: Math.round((lat.run.length + lat.read.length) / +secs), runs: sum(lat.run), reads: sum(lat.read), errors, streams: { requested: +streams, open, failed, completed: ended, ms: Date.now() - t0 } }, null, 1));
