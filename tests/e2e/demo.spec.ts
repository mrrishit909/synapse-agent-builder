// Blueprint 02, section 17, end to end as a user would do it.
import { expect, test } from "@playwright/test";
import { open, state } from "./helpers.ts";

test("build six nodes -> run on an e-mail -> particles -> failed tool step -> swap provider -> compare -> publish", async ({ page }) => {
  await open(page);
  // the story runs over the live canvas
  await expect(page.getByRole("heading", { name: /An agent is a graph/ })).toBeVisible();
  const intro = page.getByLabel("Introduction");
  for (const n of [1, 2, 3]) {
    await intro.evaluate((el, k) => el.querySelectorAll("[data-chapter]")[k].scrollIntoView(), n);
    await expect.poll(async () => (await state(page)).view).toBe(`intro${n}`);
  }
  await expect(page.getByText(/release gate blocks it/)).toBeVisible();
  await page.getByRole("button", { name: "Build it yourself" }).click();
  await expect.poll(async () => (await state(page)).nodes).toBe(0);

  // 1. build the support workflow from six nodes
  const builder = page.getByRole("complementary", { name: "Builder" });
  for (const t of ["Email trigger", "PII filter", "Classify (LLM)", "CRM lookup (tool)", "Knowledge base search", "Draft reply (LLM)"]) await builder.getByRole("button", { name: `Add ${t}` }).click();
  for (const [a, b] of [["trigger", "pii"], ["pii", "classify"], ["pii", "crm"], ["classify", "kb"], ["classify", "draft"], ["kb", "draft"], ["crm", "draft"]]) {
    await builder.getByRole("list").last().getByRole("button", { name: new RegExp(` ${a}$`) }).click();
    await page.getByLabel("Connection target").selectOption(b);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await expect(page.getByRole("status").filter({ hasText: "compiled · 6 steps" })).toBeVisible();
  await expect(builder.getByText("It compiles")).toBeVisible();

  // 2-3. run it on the sample e-mail; the trace plays on the canvas in real time
  await page.getByRole("button", { name: "Run on e-mail" }).click();
  await expect.poll(async () => (await state(page)).playing).toBe(true);
  await expect.poll(async () => (await state(page)).t).toBeGreaterThan(200);
  const s = await state(page);
  expect(s.run!.status).toBe("succeeded");
  expect(s.run!.steps).toContain("crm:ok:2");
  await expect.poll(async () => (await state(page)).playing, { timeout: 15_000 }).toBe(false);

  // 4. open the failed tool step: retry with backoff
  await page.getByRole("table", { name: "Trace waterfall" }).getByRole("button", { name: "Look up order" }).click();
  const insp = page.getByRole("complementary", { name: "Inspector" });
  await expect(insp).toContainText("ok after 2 attempts");
  await expect(insp).toContainText("CRM timed out after 2,500 ms");
  await expect(insp).toContainText("250 ms");
  await expect(insp).toContainText("secret://crm-api-key");

  // 5. swap the model provider and rerun
  await page.getByRole("button", { name: "Swap and rerun" }).click();
  await expect.poll(async () => (await state(page)).version).toBe(2);

  // 6. compare latency, cost and quality between versions
  await page.getByRole("button", { name: "Compare versions" }).click();
  const cmp = page.getByRole("complementary", { name: "Comparison" });
  await expect(cmp.getByRole("heading", { name: /v1 vs v2/ })).toBeVisible();
  await expect(cmp).toContainText("Release gate: blocks v2");
  const e = (await state(page)).evals!;
  expect(e.a).toBeGreaterThan(e.b);

  // 7. publish as an API endpoint: the gate refuses v2, v1 goes out
  await page.getByRole("button", { name: "Publish as API" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: "Publish v2" }).click();
  await expect(dlg.getByRole("alert")).toContainText("pass rate within 2 points");
  await dlg.getByRole("button", { name: "Publish v1" }).click();
  await expect(dlg).toContainText("Published v1");
  await expect(dlg).toContainText("/invoke");
  await dlg.getByRole("button", { name: "Close" }).click();

  // deep link restores the comparison
  await expect.poll(() => page.url()).toContain("swap=nova-pro");
  await open(page, "/?tpl=1&swap=nova-pro&v=2&view=compare");
  await expect(page.getByRole("complementary", { name: "Comparison" })).toContainText("Release gate: blocks v2");
});
