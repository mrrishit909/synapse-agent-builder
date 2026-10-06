import { describe, expect, it } from "vitest";
import { Orchestrator, durationFor, ease, replay, shortestAngle, transition, prefersReducedMotion, type MachineDef } from "../src/index.ts";

type S = "idle" | "flying" | "arrived";
type E = { type: "FLY"; to: string } | { type: "DONE" } | { type: "CANCEL" };
const def: MachineDef<S, E> = {
  initial: "idle",
  states: {
    idle: { on: { FLY: (e) => (e.to ? "flying" : null) } },
    flying: { on: { DONE: "arrived", CANCEL: "idle" } },
    arrived: { on: { FLY: "flying" } },
  },
};

describe("state machine", () => {
  it("ignores events a state does not handle and replays deterministically", () => {
    expect(transition(def, "idle", { type: "DONE" })).toBe("idle");
    expect(transition(def, "idle", { type: "FLY", to: "" })).toBe("idle");
    const evs: E[] = [{ type: "FLY", to: "a" }, { type: "DONE" }, { type: "FLY", to: "b" }, { type: "CANCEL" }];
    expect(replay(def, evs)).toEqual(["flying", "arrived", "flying", "idle"]);
    expect(replay(def, evs)).toEqual(replay(def, evs));
  });
});

describe("orchestrator", () => {
  it("tweens on its own clock and lands exactly on the target", () => {
    const o = new Orchestrator();
    o.set("cam", [0, 0]);
    expect(o.to("cam", [10, 20], 1000)).toBe(1000);
    o.tick(500);
    expect(o.get("cam")![0]).toBeCloseTo(5, 6);
    expect(o.busy("cam")).toBe(true);
    o.tick(600);
    expect(o.get("cam")).toEqual([10, 20]);
    expect(o.busy()).toBe(false);
  });
  it("reduced motion makes transitions instant; pause holds them; settle finishes them", () => {
    const o = new Orchestrator();
    o.policy.reduced = true;
    o.set("x", [0]);
    expect(o.to("x", [1], 800)).toBe(0);
    expect(o.get("x")).toEqual([1]);
    o.policy.reduced = false;
    o.to("x", [3], 1000, "linear");
    o.policy.paused = true; o.tick(400);
    expect(o.get("x")).toEqual([1]);
    o.policy.paused = false; o.tick(500);
    expect(o.get("x")![0]).toBeCloseTo(2, 6);
    o.settle();
    expect(o.get("x")).toEqual([3]);
    expect(o.to("new", [7], 500)).toBe(0);
    expect(o.get("new")).toEqual([7]);
  });
  it("easing and angle helpers", () => {
    for (const f of Object.values(ease)) { expect(f(0)).toBeCloseTo(0, 9); expect(f(1)).toBeCloseTo(1, 9); }
    expect(ease.inOutCubic(0.25)).toBeLessThan(0.25);
    expect(shortestAngle(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(-0.1, 9);
    expect(shortestAngle(3, -3)).toBeCloseTo(3 + (2 * Math.PI - 6), 9);
    expect(durationFor(500, { reduced: false, paused: false, scale: 2 })).toBe(1000);
    expect(prefersReducedMotion()).toBe(false);
  });
});
