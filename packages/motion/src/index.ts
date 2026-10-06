// Motion orchestration. Business state lives in the app; this layer only (1) runs small deterministic state machines for the
// sequences that matter (intro chapters, camera flights, encounter playback) and (2) tweens rendered values toward targets
// derived from state, on an explicit clock. Nothing here decides anything about the product; animations can be removed
// (reduced motion) and the app still reaches the same states.

// ---------- state machines ----------
export type MachineDef<S extends string, E extends { type: string }> = {
  initial: S;
  states: { [K in S]: { on?: Partial<{ [T in E["type"]]: S | ((e: Extract<E, { type: T }>) => S | null) }> } };
};

export function transition<S extends string, E extends { type: string }>(def: MachineDef<S, E>, state: S, event: E): S {
  const handler = (def.states[state].on as Record<string, unknown> | undefined)?.[event.type];
  if (handler === undefined) return state;
  const next = typeof handler === "function" ? (handler as (e: E) => S | null)(event) : (handler as S);
  return next ?? state;
}

/** Replays a list of events from the initial state: same events, same states, every time. */
export function replay<S extends string, E extends { type: string }>(def: MachineDef<S, E>, events: E[]): S[] {
  const out: S[] = [];
  let s = def.initial;
  for (const e of events) { s = transition(def, s, e); out.push(s); }
  return out;
}

// ---------- easing ----------
export const ease = {
  linear: (t: number) => t,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
};
export type Ease = keyof typeof ease;

// ---------- tweens on an explicit clock ----------
export interface Tween { from: number[]; to: number[]; start: number; duration: number; ease: Ease }

export interface MotionPolicy { reduced: boolean; paused: boolean; scale: number }
export const defaultPolicy: MotionPolicy = { reduced: false, paused: false, scale: 1 };

/** Duration a transition should take under a policy: reduced motion makes every transition instant. */
export const durationFor = (ms: number, p: MotionPolicy) => (p.reduced ? 0 : ms * p.scale);

export class Orchestrator {
  private tweens = new Map<string, Tween>();
  private values = new Map<string, number[]>();
  policy: MotionPolicy = { ...defaultPolicy };
  /** wall-clock-independent time in ms; the caller advances it (frame time, or a fixed step in tests) */
  now = 0;

  set(key: string, v: number[]) { this.values.set(key, [...v]); this.tweens.delete(key); }
  get(key: string): number[] | undefined { return this.values.get(key); }
  /** Animate key toward `to`. Unknown keys jump straight to the target. Returns the duration actually used. */
  to(key: string, to: number[], ms: number, e: Ease = "inOutCubic"): number {
    const from = this.values.get(key);
    const d = durationFor(ms, this.policy);
    if (!from || d <= 0) { this.set(key, to); return 0; }
    this.tweens.set(key, { from: [...from], to: [...to], start: this.now, duration: d, ease: e });
    return d;
  }
  busy(key?: string) { return key ? this.tweens.has(key) : this.tweens.size > 0; }
  /** Advance the clock. Paused motion holds every tween where it is. */
  tick(dtMs: number) {
    if (this.policy.paused) { for (const t of this.tweens.values()) t.start += dtMs; this.now += dtMs; return; }
    this.now += dtMs;
    for (const [k, t] of this.tweens) {
      const f = Math.min(1, (this.now - t.start) / t.duration);
      const w = ease[t.ease](f);
      this.values.set(k, t.from.map((a, i) => a + (t.to[i] - a) * w));
      if (f >= 1) this.tweens.delete(k);
    }
  }
  /** Finish everything now (used when reduced motion is switched on mid-flight). */
  settle() { for (const [k, t] of this.tweens) this.values.set(k, [...t.to]); this.tweens.clear(); }
}

/** Shortest signed angular difference, so a camera flight never takes the long way round. */
export function shortestAngle(from: number, to: number) {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return from + d;
}

/** Reads the user's reduced-motion preference (browser only; false elsewhere). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
