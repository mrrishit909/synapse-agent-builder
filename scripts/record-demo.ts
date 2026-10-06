// Records the section 17 scenario as a captioned video (docs/video/demo.webm, then ffmpeg -> demo.mp4). Drives the static export
// served by scripts/serve.ts on :8449. Captions are an overlay injected for the recording only.
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";

const url = process.env.URL ?? "http://127.0.0.1:8449/";
const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
mkdirSync("docs/video", { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "docs/video", size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const wait = (ms: number) => page.waitForTimeout(ms);
async function caption(p: Page, text: string, ms = 3500) {
  if (process.env.DEBUG) console.log("caption:", text.slice(0, 60));
  await p.evaluate((t) => {
    let el = document.getElementById("rec-caption");
    if (!el) { el = document.createElement("div"); el.id = "rec-caption"; el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99;max-width:860px;padding:10px 16px;border-radius:10px;background:rgba(5,7,11,.92);border:1px solid #5ef2c2;color:#e6ebf2;font:15px/1.4 system-ui;text-align:center;pointer-events:none"; document.body.appendChild(el); }
    el.textContent = t;
  }, text);
  await wait(ms);
}
const st = <T,>(f: string) => page.evaluate((src) => new Function("s", `return ${src}`)((window as any).__synapse.state()), f) as Promise<T>;
const rect = (id: string) => page.evaluate((i) => (window as any).__synapse.rect(i), id) as Promise<{ x: number; y: number; w: number; h: number }>;

await page.goto(url);
await page.waitForFunction(() => (window as any).__synapse?.state().run, null, { timeout: 30_000 });
const intro = page.getByLabel("Introduction");
await caption(page, "SYNAPSE: an agent workflow as a living graph. Every model, tool and search here is a deterministic simulator; nothing calls a real model.", 5000);
await intro.evaluate((el) => el.querySelectorAll("[data-chapter]")[1].scrollIntoView({ behavior: "smooth" }));
await caption(page, "One support e-mail runs through six steps. Particles carry each step's output along its edges at real speed; nodes glow while they work.", 7000);
await intro.evaluate((el) => el.querySelectorAll("[data-chapter]")[2].scrollIntoView({ behavior: "smooth" }));
await caption(page, "The order lookup times out after 2.5 s: the runtime waits 250 ms and retries, and the draft waits only for it.", 5500);
await intro.evaluate((el) => el.querySelectorAll("[data-chapter]")[3].scrollIntoView({ behavior: "smooth" }));
await caption(page, "The question the product answers: swap the model, compare, and let a release gate decide.", 5000);
await page.getByRole("button", { name: "Build it yourself" }).click();
await caption(page, "Building it from an empty canvas: place six nodes from the palette.", 2500);
const builder = page.getByRole("complementary", { name: "Builder" });
for (const t of ["Email trigger", "PII filter", "Classify (LLM)", "CRM lookup (tool)", "Knowledge base search", "Draft reply (LLM)"]) { await builder.getByRole("button", { name: `Add ${t}` }).click(); await wait(450); }
await page.keyboard.press("f"); await wait(1200);
await caption(page, "Connect them by dragging from a node's right edge. The compiler checks the graph as you go: a model may not see the e-mail until a PII filter has.", 1500);
const drag = async (a: string, b: string) => {
  const A = await rect(a), B = await rect(b), box = (await page.locator(".graph canvas").boundingBox())!;
  await page.mouse.move(box.x + A.x + A.w - 6, box.y + A.y + A.h / 2); await page.mouse.down();
  await page.mouse.move(box.x + B.x + B.w / 2, box.y + B.y + B.h / 2, { steps: 18 }); await page.mouse.up(); await wait(250);
};
for (const [a, b] of [["trigger", "pii"], ["pii", "classify"], ["pii", "crm"], ["classify", "kb"], ["classify", "draft"], ["kb", "draft"], ["crm", "draft"]]) await drag(a, b);
await caption(page, `It compiles: ${await st<number>("s.plan ? s.plan.steps.length : 0")} steps in ${await st<number>("s.plan ? s.plan.levels : 0")} levels. Classification and the order lookup can run in parallel.`, 4000);
if (process.env.DEBUG) await page.screenshot({ path: "/tmp/claude-501/syn/rec-debug.png" });
await page.getByRole("button", { name: "Run on e-mail" }).click();
await caption(page, "Running it on the sample e-mail: watch the particles, the glow and the waterfall below fill in together.", 6500);
await page.getByRole("table", { name: "Trace waterfall" }).getByRole("button", { name: "Look up order" }).click();
await caption(page, "Opening the failed tool step: attempt 1 timed out, 250 ms backoff, attempt 2 succeeded. The credential is a secret:// reference; its value never reaches the trace.", 7000);
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Swap and rerun" }).click();
await caption(page, "Swap the model provider: every call now goes to Nova Pro, falling back to Nova Lite. Same e-mail, new run.", 6000);
await page.getByRole("button", { name: "Compare versions" }).click();
await wait(1200);
await caption(page, `Both versions on 64 labeled e-mails. Nova Pro: ${await st<string>("(100 * (1 - s.evals.b.costPerRun / s.evals.a.costPerRun)).toFixed(0)")}% cheaper, faster at p95, and slightly better at classifying.`, 6000);
await caption(page, `But its replies drop the order number more often: end-to-end pass rate ${await st<string>("(s.evals.a.passRate * 100).toFixed(1)")}% vs ${await st<string>("(s.evals.b.passRate * 100).toFixed(1)")}%. The gate blocks it.`, 6000);
await page.getByRole("complementary", { name: "Comparison" }).evaluate((el) => el.scrollTo({ top: 600, behavior: "smooth" }));
await caption(page, "The regression matrix shows which e-mails changed. A lenient simulated judge is calibrated against the deterministic checks; caching drafts would quote other customers' orders.", 7500);
await page.getByRole("button", { name: "Publish as API" }).click();
await page.getByRole("dialog").getByRole("button", { name: "Publish v2" }).click();
await caption(page, "Publishing v2 is refused, with the reasons.", 3500);
await page.getByRole("dialog").getByRole("button", { name: "Publish v1" }).click();
await caption(page, "v1 goes out as an endpoint. In the Docker stack this creates a real endpoint with a hashed key; here it is simulated.", 5000);
await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitemcheckbox", { name: "Atlas AI is down (500s)" }).click();
await page.getByLabel("Version").selectOption("1"); await wait(300);
await page.getByRole("button", { name: "Run on e-mail" }).click();
await caption(page, "Failure: Atlas AI goes down. Both its models fail every retry, so the run fails, and the canvas shows where.", 6000);
await page.getByLabel("Swap model to").selectOption("auto");
await page.getByRole("button", { name: "Swap and rerun" }).click();
await caption(page, "Switch to the router: it skips the unhealthy provider and picks Nova Pro on quality, cost and latency. The run recovers.", 6000);
const A = await rect("kb"), box = (await page.locator(".graph canvas").boundingBox())!;
await page.mouse.move(box.x + A.x + 60, box.y + A.y + 30); await page.mouse.down(); await page.mouse.move(box.x + A.x + 60, box.y + A.y - 120, { steps: 30 }); await wait(600); await page.mouse.up();
await caption(page, "Nodes are spring-linked: drag one and its neighbours lean after it, then settle.", 3500);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 140); await wait(120); }
await caption(page, "Zooming out drops detail: names first, then shapes only. Zoom in for live metrics.", 3500);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -140); await wait(120); }
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitemcheckbox", { name: /Stress/ }).click();
await caption(page, "Stress: 2,000 nodes and 5,000 edges, still three draw calls.", 4500);
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitemcheckbox", { name: /Back to the workflow/ }).click();
await page.keyboard.press("l");
await caption(page, "Everything on the canvas is also in tables: nodes, edges and the trace, without WebGL or motion.", 4500);
await page.keyboard.press("l");
await page.getByRole("button", { name: "Telemetry" }).click();
await caption(page, "Telemetry: frame rate, Web Vitals and draw calls, measured live. Code and write-up: github.com/mrrishit909/synapse-agent-builder", 5000);
console.log(JSON.stringify(await page.evaluate(() => (window as any).__synapse.telemetry())));
const v = page.video();
await ctx.close(); await browser.close();
if (v) renameSync(await v.path(), "docs/video/demo.webm");
console.log("wrote docs/video/demo.webm");
