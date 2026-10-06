// Data providers. The public sandbox runs the runtime in the page (StaticProvider); the Docker stack builds the site with
// NEXT_PUBLIC_API_URL and runs workflows on the API (ApiProvider), where runs are stored, streamed and audited.
import type { Email, Faults, RunResult, Workflow } from "@synapse/domain";
import { SynapseClient } from "@synapse/sdk";

export interface PublishResult { slug: string; url: string; keyHint: string }
export interface DataProvider {
  readonly kind: "static" | "api";
  run(wf: Workflow, email: Email, faults: Faults): Promise<RunResult>;
  publish(wf: Workflow): Promise<PublishResult>;
  /** API mode: store the comparison so the server-side release gate sees it */
  evaluate?(wf: Workflow, versions: [number, number]): Promise<{ gate: { pass: boolean } }>;
}

export class StaticProvider implements DataProvider {
  readonly kind = "static" as const;
  async run(): Promise<RunResult> { throw new Error("static runs happen in the page"); }
  async publish(wf: Workflow) {
    // nothing leaves the browser: the endpoint is what the API would create, and "Try it" runs locally
    return { slug: `${wf.id}-v${wf.version}`, url: `https://api.synapse.example/v1/endpoints/${wf.id}-v${wf.version}/invoke`, keyHint: "sk_demo_…(simulated)" };
  }
}

export class ApiProvider implements DataProvider {
  readonly kind = "api" as const;
  private c: SynapseClient;
  constructor(url: string, token: string) { this.c = new SynapseClient(url, token); }
  async run(wf: Workflow, email: Email, faults: Faults) {
    const saved = await this.c.saveWorkflow(wf);
    const r = await this.c.startRun(saved.id, { emailId: email.id, faults });
    return r.run;
  }
  async evaluate(wf: Workflow, versions: [number, number]) { return this.c.evaluate({ workflowId: wf.id, versions }); }
  async publish(wf: Workflow) {
    const saved = await this.c.saveWorkflow(wf);
    const p = await this.c.publish(saved.id, saved.version);
    return { slug: p.slug, url: p.url, keyHint: `${p.key.slice(0, 10)}… (shown once)` };
  }
}

export function makeProvider(): DataProvider {
  const api = process.env.NEXT_PUBLIC_API_URL;
  return api ? new ApiProvider(api, process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "acme-builder-demo") : new StaticProvider();
}
