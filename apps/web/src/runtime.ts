// Per-frame runtime outside React: the motion orchestrator and telemetry.
import { Orchestrator } from "@synapse/motion";
import { Telemetry } from "@synapse/telemetry";

export const orchestrator = new Orchestrator();
export const telemetry = new Telemetry((s) => {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (api && typeof navigator !== "undefined") navigator.sendBeacon?.(`${api}/v1/telemetry`, new Blob([JSON.stringify(s)], { type: "application/json" }));
});
