// Provider outage and rate-limit storm are demonstrable and recoverable.
import { expect, test } from "@playwright/test";
import { open, state } from "./helpers.ts";

test("Atlas outage fails the run; the router recovers it on another provider", async ({ page }) => {
  await open(page, "/?tpl=1");
  await expect.poll(async () => (await state(page)).run?.status).toBe("succeeded");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Atlas AI is down (500s)" }).click();
  await page.getByRole("button", { name: "Run on e-mail" }).click();
  await expect.poll(async () => (await state(page)).run?.status).toBe("failed");
  await page.getByRole("table", { name: "Trace waterfall" }).getByRole("button", { name: "Classify" }).click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("all 6 attempts failed");
  await page.getByLabel("Swap model to").selectOption("auto");
  await page.getByRole("button", { name: "Swap and rerun" }).click();
  await expect.poll(async () => (await state(page)).run?.status).toBe("succeeded");
  await page.getByRole("table", { name: "Trace waterfall" }).getByRole("button", { name: "Classify" }).click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("nova-pro");
});

test("rate-limit storm: every model call waits a second and retries", async ({ page }) => {
  await open(page, "/?tpl=1");
  await expect.poll(async () => (await state(page)).run?.status).toBe("succeeded");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Rate-limit storm/ }).click();
  await page.getByRole("button", { name: "Run on e-mail" }).click();
  await expect.poll(async () => (await state(page)).run?.steps).toEqual(expect.arrayContaining(["classify:ok:2", "draft:ok:2"]));
  await page.getByRole("table", { name: "Trace waterfall" }).getByRole("button", { name: "Draft reply" }).click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("rate limited");
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("1.00 s");
});
