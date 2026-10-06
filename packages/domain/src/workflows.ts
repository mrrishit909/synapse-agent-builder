// The demo workflows: the six-node support workflow (v1 on Atlas Large) and its provider-swapped v2 (Nova Pro).
import type { Workflow } from "./graph.ts";

export const CLASSIFY_PROMPT = "You are a support triage assistant.\nClassify the e-mail into one of: billing, shipping, technical, account, cancellation, other.\nReturn JSON {category, urgency, confidence}.";
export const DRAFT_PROMPT = "You write short, friendly support replies.\nUse the knowledge-base articles and the order record.\nMention the order number when there is one. Never include personal data.";

export function supportWorkflow(modelId = "atlas-large", version = 1, fallback = "atlas-mini"): Workflow {
  return {
    id: "wf-support", name: "Support triage and reply", version,
    nodes: [
      { id: "trigger", type: "trigger.email", label: "Email received", x: 0, y: 160, config: {} },
      { id: "pii", type: "policy.pii", label: "PII filter", x: 260, y: 160, config: { kinds: ["email", "phone", "card"] } },
      { id: "classify", type: "llm.classify", label: "Classify", x: 520, y: 40, config: { model: modelId, fallback, prompt: CLASSIFY_PROMPT } },
      { id: "kb", type: "retrieval.kb", label: "Search help articles", x: 780, y: 40, config: { k: 2 } },
      { id: "crm", type: "tool.crm", label: "Look up order", x: 520, y: 290, config: { secretRef: "secret://crm-api-key", timeoutMs: 2500 } },
      { id: "draft", type: "llm.draft", label: "Draft reply", x: 1040, y: 160, config: { model: modelId, fallback, prompt: DRAFT_PROMPT } },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "pii" }, { id: "e2", from: "pii", to: "classify" }, { id: "e3", from: "classify", to: "kb" },
      { id: "e4", from: "pii", to: "crm" }, { id: "e5", from: "kb", to: "draft" }, { id: "e6", from: "crm", to: "draft" }, { id: "e7", from: "classify", to: "draft" },
    ],
  };
}

/** The sample run's scripted faults: the CRM times out once (then succeeds on retry). */
export const SAMPLE_FAULTS = { forced: { "sample:crm#1": "timeout" as const } };
