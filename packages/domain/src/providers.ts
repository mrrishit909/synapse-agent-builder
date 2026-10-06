// Simulated model providers, tools and retrieval. Nothing here calls a real model: each "model" is a deterministic function of
// (model, input, attempt, seed) whose accuracy, latency, malformed-output rate and pricing are set in MODELS. The workflow,
// runtime, routing and evaluation code treat them exactly as they would treat real provider adapters.
import { hash } from "./graph.ts";
import { mulberry32 } from "./rng.ts";

export interface ModelSpec {
  id: string; provider: string; label: string;
  inPerM: number; outPerM: number; // USD per million tokens (synthetic price list)
  latencyMs: number; perOutTokMs: number; contextTokens: number;
  quality: number; // probability of a correct classification on a clear email
  malformedRate: number; // share of outputs that are not valid JSON
  rate429: number; rate500: number;
}

export const MODELS: ModelSpec[] = [
  { id: "atlas-large", provider: "Atlas AI", label: "Atlas Large", inPerM: 3, outPerM: 15, latencyMs: 900, perOutTokMs: 9, contextTokens: 200_000, quality: 0.96, malformedRate: 0.005, rate429: 0.01, rate500: 0.003 },
  { id: "atlas-mini", provider: "Atlas AI", label: "Atlas Mini", inPerM: 0.25, outPerM: 1.25, latencyMs: 320, perOutTokMs: 3, contextTokens: 128_000, quality: 0.88, malformedRate: 0.01, rate429: 0.01, rate500: 0.003 },
  { id: "nova-pro", provider: "Nova Labs", label: "Nova Pro", inPerM: 1, outPerM: 4, latencyMs: 520, perOutTokMs: 4.5, contextTokens: 64_000, quality: 0.93, malformedRate: 0.06, rate429: 0.02, rate500: 0.005 },
  { id: "nova-lite", provider: "Nova Labs", label: "Nova Lite", inPerM: 0.1, outPerM: 0.4, latencyMs: 210, perOutTokMs: 2, contextTokens: 32_000, quality: 0.81, malformedRate: 0.03, rate429: 0.02, rate500: 0.005 },
];
export const model = (id: string) => {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model ${id}`);
  return m;
};

/** About four characters per token, the usual rule of thumb for English. */
export const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));
export const costUsd = (m: ModelSpec, tin: number, tout: number) => (tin * m.inPerM + tout * m.outPerM) / 1e6;

/** Seeded uniform in [0,1) from any key: the simulators' only source of chance. */
export const draw = (...key: (string | number)[]) => mulberry32(parseInt(hash(key.join("|")), 16))();
function lognormal(median: number, sigma: number, ...key: (string | number)[]) {
  const u1 = Math.max(1e-9, draw(...key, "a")), u2 = draw(...key, "b");
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
}

export const CATEGORIES = ["billing", "shipping", "technical", "account", "cancellation", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
const CUES: Record<Category, string[]> = {
  billing: ["charged twice", "refund", "invoice", "overcharged", "payment"],
  shipping: ["where is my order", "tracking", "delivery", "late", "package"],
  technical: ["crash", "error", "bug", "won't load", "login fails"],
  account: ["change my email", "reset my password", "update my address", "two-factor"],
  cancellation: ["cancel", "close my account", "stop my subscription", "unsubscribe me"],
  other: ["question", "feedback", "partnership", "compliment"],
};

/** What a careful reader would label the email: the category whose cues appear, cancellation winning ties (labeling rule). */
export function cueCategory(text: string): Category {
  const t = text.toLowerCase();
  const hits = CATEGORIES.map((c) => [c, CUES[c].filter((k) => t.includes(k)).length] as const).filter(([, n]) => n > 0);
  if (!hits.length) return "other";
  if (hits.some(([c]) => c === "cancellation")) return "cancellation";
  return [...hits].sort((a, b) => b[1] - a[1])[0][0];
}

export interface ProviderCall { ok: boolean; status: number; text: string; latencyMs: number; tokenIn: number; tokenOut: number; costUsd: number; error?: string }

export interface Faults {
  /** force an HTTP status on given (node, attempt) pairs, e.g. { "classify#1": 429 } */
  forced?: Record<string, number | "timeout" | "malformed">;
  /** a whole provider down (every call returns 500) */
  providerDown?: string[];
}

/** One LLM call. `task` decides what the model produces; correctness and failures are drawn from the model's profile. */
export function callModel(m: ModelSpec, task: "classify" | "draft", prompt: string, ctx: { key: string; attempt: number; faults?: Faults; truth?: Category; facts?: string[]; content?: string }): ProviderCall {
  const k = [m.id, task, ctx.key, ctx.attempt];
  const tin = tokens(prompt);
  const forced = ctx.faults?.forced?.[`${ctx.key}#${ctx.attempt}`];
  const fail = (status: number, error: string, latency: number): ProviderCall => ({ ok: false, status, text: "", latencyMs: Math.round(latency), tokenIn: status === 429 ? 0 : tin, tokenOut: 0, costUsd: 0, error });
  if (tin > m.contextTokens) return fail(400, "context length exceeded", 40);
  if (ctx.faults?.providerDown?.includes(m.provider) || forced === 500 || (forced === undefined && draw(...k, "500") < m.rate500)) return fail(500, `${m.provider}: internal error`, lognormal(m.latencyMs * 0.4, 0.3, ...k));
  if (forced === 429 || (forced === undefined && draw(...k, "429") < m.rate429)) return fail(429, `${m.provider}: rate limited`, 60);
  if (forced === "timeout") return fail(504, "timed out", 30_000);
  let text: string;
  if (task === "classify") {
    const content = (ctx.content ?? prompt).toLowerCase(); // the e-mail, not the instructions (which name every category)
    const truth = ctx.truth ?? cueCategory(content);
    const ambiguous = CATEGORIES.filter((c) => CUES[c].some((q) => content.includes(q))).length > 1;
    const pCorrect = ambiguous ? m.quality - (1 - m.quality) * 2.2 : m.quality;
    const correct = draw(...k.slice(0, 3), "correct") < pCorrect; // same answer on a retry: the model is consistent, not lucky
    const wrong = CATEGORIES.filter((c) => c !== truth);
    const cat = correct ? truth : wrong[Math.floor(draw(...k.slice(0, 3), "which") * wrong.length)];
    const conf = correct ? 0.72 + 0.27 * draw(...k, "conf") : 0.45 + 0.4 * draw(...k, "conf");
    text = JSON.stringify({ category: cat, urgency: /asap|urgent|today|immediately/i.test(content) ? "high" : "normal", confidence: +conf.toFixed(2) });
  } else {
    const facts = ctx.facts ?? [];
    const kept = facts.filter((f, i) => draw(...k.slice(0, 3), "fact", i) < (m.quality + 0.03));
    text = `Hi there,\n\nThanks for getting in touch. ${kept.map((f) => `Regarding ${f}: we have looked into it.`).join(" ")} ` +
      `Here is what happens next: our team will follow up within one business day.\n\nBest regards,\nSupport`;
  }
  const malformed = forced === "malformed" || (forced === undefined && task === "classify" && draw(...k, "json") < m.malformedRate);
  if (malformed) text = text.slice(0, Math.max(5, Math.floor(text.length * 0.55))); // truncated mid-object
  const tout = tokens(text);
  const latency = lognormal(m.latencyMs, 0.32, ...k) + tout * m.perOutTokMs;
  return { ok: true, status: 200, text, latencyMs: Math.round(latency), tokenIn: tin, tokenOut: tout, costUsd: costUsd(m, tin, tout) };
}

// ---------- retrieval: a tiny knowledge base and a hashing-trick embedding ----------
export const KB = [
  { id: "KB-101", category: "billing", title: "Refunds for duplicate charges", text: "If you were charged twice we refund the duplicate payment within 5 business days." },
  { id: "KB-102", category: "billing", title: "Reading your invoice", text: "Invoices list each charge, tax and payment method." },
  { id: "KB-201", category: "shipping", title: "Tracking a late delivery", text: "Use the tracking link; deliveries late by more than 3 days get a reshipment." },
  { id: "KB-202", category: "shipping", title: "Missing package", text: "If tracking shows delivered but the package is missing, we open a carrier claim." },
  { id: "KB-301", category: "technical", title: "App crashes on launch", text: "Update to the latest version and clear the cache; send logs if the crash continues." },
  { id: "KB-302", category: "technical", title: "Login errors", text: "Login fails after five attempts lock the account for 15 minutes; reset the password to unlock." },
  { id: "KB-401", category: "account", title: "Changing your email address", text: "Change your email in Settings, Account; we confirm the new address by link." },
  { id: "KB-402", category: "account", title: "Password reset", text: "Reset your password from the sign-in page; links expire after one hour." },
  { id: "KB-501", category: "cancellation", title: "Cancelling a subscription", text: "Cancel any time in Settings, Billing; access continues to the end of the period." },
  { id: "KB-601", category: "other", title: "Contacting the team", text: "For feedback and partnerships write to our team; we reply within a week." },
];
const STOP = new Set("the a an and or to of for in on my i me is it we you your our with be was by at this that please have has not no".split(" "));
export function embed(text: string, dim = 256): number[] {
  const v = new Array(dim).fill(0);
  for (const w of (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((x) => !STOP.has(x))) { const h = parseInt(hash(w), 16); v[h % dim] += h & 1 ? 1 : -1; }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const KB_VECS = KB.map((d) => embed(`${d.title} ${d.text}`));
/** Hybrid search: embedding similarity plus a boost for articles tagged with the classified category (a metadata filter). */
export function searchKb(query: string, k = 2, category?: string) {
  const q = embed(query);
  return KB.map((d, i) => ({ ...d, score: +(cosine(q, KB_VECS[i]) + (d.category === category ? 0.5 : 0)).toFixed(3) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

// ---------- the CRM tool ----------
export function crmLookup(orderId: string | null, ctx: { key: string; attempt: number; faults?: Faults; apiKey: string }): ProviderCall {
  const forced = ctx.faults?.forced?.[`${ctx.key}#${ctx.attempt}`];
  if (!ctx.apiKey.startsWith("crm_live_")) return { ok: false, status: 401, text: "", latencyMs: 30, tokenIn: 0, tokenOut: 0, costUsd: 0, error: "CRM rejected the credentials" };
  if (forced === "timeout") return { ok: false, status: 504, text: "", latencyMs: 2500, tokenIn: 0, tokenOut: 0, costUsd: 0, error: "CRM timed out after 2,500 ms" };
  if (forced === 500) return { ok: false, status: 500, text: "", latencyMs: 180, tokenIn: 0, tokenOut: 0, costUsd: 0, error: "CRM internal error" };
  const latency = 120 + 160 * draw("crm", ctx.key, ctx.attempt);
  if (!orderId) return { ok: true, status: 200, text: JSON.stringify({ found: false }), latencyMs: Math.round(latency), tokenIn: 0, tokenOut: 0, costUsd: 0 };
  const statuses = ["shipped", "processing", "delivered", "refunded"];
  const r = { found: true, orderId, status: statuses[parseInt(hash(orderId), 16) % 4], carrier: ["UPS", "DHL", "USPS"][parseInt(hash(orderId + "c"), 16) % 3] };
  return { ok: true, status: 200, text: JSON.stringify(r), latencyMs: Math.round(latency), tokenIn: 0, tokenOut: 0, costUsd: 0 };
}
