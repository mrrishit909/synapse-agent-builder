// Canvas performance with 2,000 nodes and 5,000 edges (section 16): renders, stays interactive, reports its cost.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { open } from "./helpers.ts";

test("2,000-node / 5,000-edge graph", async ({ page }) => {
  await open(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Stress/ }).click();
  await page.getByRole("button", { name: "Telemetry" }).click();
  await page.waitForTimeout(1000);
  const box = (await page.locator(".graph canvas").boundingBox())!;
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, i < 6 ? -120 : 120); // zoom in and out: semantic zoom thresholds
  await page.mouse.move(box.x + 700, box.y + 400); await page.mouse.down(); await page.mouse.move(box.x + 400, box.y + 300, { steps: 20 }); await page.mouse.up();
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => (window as unknown as { __synapse: { telemetry: () => Record<string, any> } }).__synapse.telemetry());
  expect(t.objects).toBe(2000);
  expect(t.fps).toBeGreaterThan(0);
  expect(t.render.calls).toBeLessThanOrEqual(4); // edges, nodes, particles, link line: one draw each
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/performance-e2e.json", JSON.stringify({ note: "headless Chrome with SwiftShader (software GL): a floor, not a GPU figure", ...t }, null, 1));
});
