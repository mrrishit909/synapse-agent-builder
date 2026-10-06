// Deep links: version, sample e-mail, inspected node, view, playback time and failure lab switches live in the query string.
export interface LinkState { v?: number; email?: string; node?: string; view?: "compare" | "publish"; t?: number; rm?: boolean; enter?: boolean; tpl?: boolean; swap?: string; list?: boolean }

export function readLink(search: string): LinkState {
  const q = new URLSearchParams(search), s: LinkState = {};
  const v = Number(q.get("v")); if (Number.isInteger(v) && v > 0 && v < 100) s.v = v;
  const email = q.get("email"); if (email && /^(sample|em-\d{3})$/.test(email)) s.email = email;
  const node = q.get("node"); if (node && /^[a-z0-9-]{1,40}$/.test(node)) s.node = node;
  const view = q.get("view"); if (view === "compare" || view === "publish") s.view = view;
  const t = Number(q.get("t")); if (Number.isFinite(t) && t > 0) s.t = t;
  const swap = q.get("swap"); if (swap && /^[a-z-]{3,20}$/.test(swap)) s.swap = swap;
  if (q.get("rm") === "1") s.rm = true;
  if (q.get("enter") === "1") s.enter = true;
  if (q.get("tpl") === "1") s.tpl = true;
  if (q.get("list") === "1") s.list = true;
  return s;
}

export function writeLink(s: LinkState): string {
  const q = new URLSearchParams();
  if (s.tpl) q.set("tpl", "1");
  if (s.swap) q.set("swap", s.swap);
  if (s.v) q.set("v", String(s.v));
  if (s.email && s.email !== "sample") q.set("email", s.email);
  if (s.node) q.set("node", s.node);
  if (s.view) q.set("view", s.view);
  if (s.t) q.set("t", String(Math.round(s.t)));
  if (s.list) q.set("list", "1");
  if (s.rm) q.set("rm", "1");
  const str = q.toString();
  return str ? `?${str}` : "?enter=1";
}
