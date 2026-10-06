import { expect, type Page } from "@playwright/test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test probe over the page's state
export const state = (page: Page): Promise<any> => page.evaluate(() => {
  const h = (window as unknown as { __synapse?: { state: () => Record<string, unknown>; playback: { t: number } } }).__synapse;
  if (!h) return { view: null } as Record<string, unknown>;
  const s = h.state() as Record<string, any>;
  return { view: s.view, nodes: s.wf.nodes.length, edges: s.wf.edges.length, plan: !!s.plan, run: s.run ? { status: s.run.status, retries: s.run.retries, total: s.run.totalLatencyMs, steps: s.run.steps.map((x: any) => `${x.nodeId}:${x.status}:${x.attempts.length}`) } : null,
    version: s.version, versions: Object.keys(s.versions).length, evals: s.evals ? { gate: s.evals.gate.pass, a: s.evals.a.passRate, b: s.evals.b.passRate } : null, published: s.published, reduced: s.reduced, playing: s.playing, t: h.playback.t, inspect: s.inspect };
});
export async function open(page: Page, url = "/") {
  await page.goto(url);
  await expect.poll(async () => (await state(page)).view, { timeout: 30_000 }).not.toBeNull();
}
