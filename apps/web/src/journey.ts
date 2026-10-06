// View states as a deterministic machine (packages/motion). The store asks it which view follows an event; the canvas and panels
// animate toward that view. Reduced motion changes how fast, never where.
import { transition, type MachineDef } from "@synapse/motion";

export type View = "intro0" | "intro1" | "intro2" | "intro3" | "build" | "inspect" | "compare" | "publish";
export type JourneyEvent = { type: "CHAPTER"; n: number } | { type: "ENTER" } | { type: "INSPECT" } | { type: "COMPARE" } | { type: "PUBLISH" } | { type: "BACK" };

const intro = (n: number): View => (["intro0", "intro1", "intro2", "intro3"] as const)[Math.max(0, Math.min(3, n))];
const introState = { on: { CHAPTER: (e: { n: number }) => intro(e.n), ENTER: "build" as View, INSPECT: "inspect" as View, COMPARE: "compare" as View } };

export const journey: MachineDef<View, JourneyEvent> = {
  initial: "intro0",
  states: {
    intro0: introState, intro1: introState, intro2: introState, intro3: introState,
    build: { on: { INSPECT: "inspect", COMPARE: "compare", PUBLISH: "publish", CHAPTER: (e) => intro(e.n) } },
    inspect: { on: { INSPECT: "inspect", BACK: "build", COMPARE: "compare", PUBLISH: "publish" } },
    compare: { on: { BACK: "build", INSPECT: "inspect", PUBLISH: "publish" } },
    publish: { on: { BACK: "build", COMPARE: "compare", INSPECT: "inspect" } },
  },
};
export const next = (v: View, e: JourneyEvent) => transition(journey, v, e);
export const isIntro = (v: View) => v.startsWith("intro");
