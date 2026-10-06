// Synthetic support e-mails with labels (category, order id, facts a good reply must mention), PII redaction, and secret handling.
import { rng } from "./rng.ts";
import type { Category } from "./providers.ts";

export interface Email { id: string; subject: string; body: string; from: string; label: Category; orderId: string | null; facts: string[]; nearDuplicateOf?: string }

const NAMES = ["Avery", "Jordan", "Riley", "Sam", "Morgan", "Casey", "Quinn", "Drew", "Taylor", "Reese"];
const TEMPLATES: Record<Category, string[]> = {
  billing: ["I was charged twice for order {order} and need a refund.", "My invoice for {order} shows I was overcharged on the payment."],
  shipping: ["Where is my order {order}? The tracking hasn't moved in a week.", "The delivery for {order} is late and the package never arrived."],
  technical: ["The app keeps showing an error and will crash when I open it.", "Login fails every time with an error since the update."],
  account: ["Please change my email on the account to the new one.", "I need to reset my password, the link doesn't work."],
  cancellation: ["Please cancel my subscription, I no longer need it.", "I want to close my account and stop my subscription."],
  other: ["I have a question about a partnership with your team.", "Just some feedback: the new design is a real compliment to the product."],
};
// emails that mention two categories: the labeling rule says cancellation wins, billing beats shipping when the charge is the ask
const AMBIGUOUS: [Category, string][] = [
  ["cancellation", "I was charged twice for {order}; please refund it and cancel my subscription."],
  ["billing", "The delivery of {order} was fine but I was charged twice, please refund the payment."],
  ["cancellation", "Login fails all the time so please cancel my plan and close my account."],
];

export function makeEmails(n = 60, seed = 11): Email[] {
  const r = rng(seed);
  const cats = Object.keys(TEMPLATES) as Category[];
  const out: Email[] = [];
  for (let i = 0; i < n; i++) {
    const amb = i % 10 === 7;
    const [label, tpl] = amb ? AMBIGUOUS[Math.floor(i / 10) % AMBIGUOUS.length] : (() => { const c = cats[i % cats.length]; return [c, r.pick(TEMPLATES[c])] as [Category, string]; })();
    const needsOrder = tpl.includes("{order}");
    const orderId = needsOrder ? `ORD-${r.int(10000, 99999)}` : null;
    const name = r.pick(NAMES);
    const phone = r.u() < 0.4 ? ` You can call me on +1 (555) 01${r.int(10, 99)}-${r.int(1000, 9999)}.` : "";
    const body = `Hello,\n\n${tpl.replace("{order}", orderId ?? "")}${phone} ${r.u() < 0.2 ? "This is urgent, please help today." : ""}\n\nThanks,\n${name}`;
    const facts = [...(orderId ? [`order ${orderId}`] : []), `the ${label} request`];
    out.push({ id: `em-${String(i + 1).padStart(3, "0")}`, subject: tpl.split(" ").slice(0, 6).join(" "), body, from: `${name.toLowerCase()}.${i}@example.com`, label, orderId, facts });
  }
  // near-duplicates: same wording, different order number (what a semantic cache can get wrong)
  for (let i = 0; i < Math.round(n * 0.15); i++) {
    const src = out[(i * 7) % n];
    if (!src.orderId) continue;
    const orderId = `ORD-${r.int(10000, 99999)}`;
    out.push({ ...src, id: `em-${String(out.length + 1).padStart(3, "0")}`, body: src.body.replaceAll(src.orderId, orderId), orderId, facts: src.facts.map((f) => f.replace(src.orderId!, orderId)), nearDuplicateOf: src.id });
  }
  return out;
}

export const SAMPLE_EMAIL: Email = {
  id: "sample", subject: "Charged twice for my order", from: "jordan.lee@example.com", label: "billing", orderId: "ORD-48213",
  body: "Hello,\n\nI was charged twice for order ORD-48213 and need a refund. My card ending 4242 shows both payments. You can reach me at jordan.lee@example.com or +1 (555) 014-2290.\n\nThanks,\nJordan",
  facts: ["order ORD-48213", "the billing request"],
};

const PII = [
  { kind: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { kind: "phone", re: /\+?\d{1,2}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g },
  { kind: "card", re: /\b(?:card|visa|mastercard)\s+(?:ending\s+)?\d{4}\b/gi },
];
/** Redact PII; returns the text and what was found (counts only, never the values). */
export function redact(text: string) {
  const found: Record<string, number> = {};
  let out = text;
  for (const p of PII) out = out.replace(p.re, () => { found[p.kind] = (found[p.kind] ?? 0) + 1; return `[${p.kind.toUpperCase()}]`; });
  return { text: out, found };
}
export const containsPii = (s: string) => PII.some((p) => new RegExp(p.re.source, p.re.flags).test(s));

/** Secret store: values live here only. Steps refer to secret://name; traces show the reference, never the value. */
export class SecretStore {
  private m = new Map<string, string>();
  set(name: string, value: string) { this.m.set(name, value); }
  resolve(ref: string) {
    if (!ref.startsWith("secret://")) throw new Error("not a secret reference");
    const v = this.m.get(ref.slice(9));
    if (v === undefined) throw new Error(`unknown secret ${ref}`);
    return v;
  }
  /** Replace any known secret value inside a string (defence in depth for error messages and payloads). */
  scrub(s: string) { let o = s; for (const v of this.m.values()) o = o.split(v).join("***"); return o; }
  values() { return [...this.m.values()]; }
}
export const demoSecrets = () => { const s = new SecretStore(); s.set("crm-api-key", "crm_live_7Q2xDemoOnlyNotARealKey"); return s; };
