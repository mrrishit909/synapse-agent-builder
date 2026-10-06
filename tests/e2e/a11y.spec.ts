import { expect, test } from "@playwright/test";
import { open, state } from "./helpers.ts";

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("runs land on their final state with every number shown", async ({ page }) => {
    await open(page, "/?tpl=1");
    await expect.poll(async () => (await state(page)).run?.status).toBe("succeeded");
    const s = await state(page);
    expect(s.reduced).toBe(true);
    expect(s.playing).toBe(false);
    expect(s.t).toBe(s.run!.total);
    await expect(page.getByRole("table", { name: "Trace waterfall" })).toContainText("Look up order");
  });
});

test("keyboard only: run, inspect from the node list, list view, back out", async ({ page }) => {
  await open(page, "/?tpl=1");
  await expect.poll(async () => (await state(page)).run?.status).toBe("succeeded");
  await page.keyboard.press("r");
  await page.getByRole("complementary", { name: "Builder" }).getByRole("button", { name: /Look up order/ }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await state(page)).inspect).toBe("crm");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(page)).view).toBe("build");
  await page.keyboard.press("l");
  await expect(page.getByRole("main", { name: "List view" })).toContainText("compiles");
  const unnamed = await page.locator("button:visible").evaluateAll((bs) => bs.filter((b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
  expect(unnamed).toBe(0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();
});
