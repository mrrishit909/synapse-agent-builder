// Visual regression on key motion states: mid-run (classify working, CRM timing out), the finished run, and the comparison.
import { expect, test } from "@playwright/test";
import { open, state } from "./helpers.ts";

test("mid-run glow, finished run, comparison", async ({ page }) => {
  await open(page, "/?tpl=1&t=1500");
  await expect.poll(async () => (await state(page)).run?.status).toBe("succeeded");
  await page.waitForTimeout(1200);
  await expect.poll(async () => Math.round((await state(page)).t)).toBe(1500);
  await expect(page.locator(".graph")).toHaveScreenshot("mid-run.png");
  await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(400);
  await expect(page.locator(".trace")).toHaveScreenshot("trace-end.png");
  await open(page, "/?tpl=1&swap=nova-pro&v=2&view=compare&rm=1");
  await expect(page.getByRole("complementary", { name: "Comparison" })).toContainText("Release gate");
  await expect(page.getByRole("complementary", { name: "Comparison" })).toHaveScreenshot("compare.png", { mask: [page.getByText(/ms$/).first()] });
});
