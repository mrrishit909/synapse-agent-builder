"use client";
// Text-and-table alternative to the canvas: every node, edge and trace step without WebGL or motion.
import { inspect, useApp } from "../store.ts";
import { ms, usd } from "./fmt.ts";

export default function ListView() {
  const wf = useApp((s) => s.wf);
  const run = useApp((s) => s.run);
  const issues = useApp((s) => s.issues);
  return (
    <main className="listview" aria-label="List view">
      <h2>Nodes</h2>
      <div className="table-wrap"><table>
        <caption>{wf.name}, version {wf.version}: {wf.nodes.length} nodes, {wf.edges.length} edges{issues.length ? `, ${issues.length} compile issue(s)` : ", compiles"}</caption>
        <thead><tr><th scope="col">Id</th><th scope="col">Type</th><th scope="col">Model</th><th scope="col">Inputs from</th><th scope="col" /></tr></thead>
        <tbody>{wf.nodes.map((n) => <tr key={n.id}><td>{n.id}</td><td>{n.type}</td><td>{String(n.config.model ?? "–")}</td><td>{wf.edges.filter((e) => e.to === n.id).map((e) => e.from).join(", ") || "–"}</td><td><button onClick={() => inspect(n.id)}>Inspect</button></td></tr>)}</tbody>
      </table></div>
      {issues.length ? <ul className="errors">{issues.map((i) => <li key={i.code + (i.nodeId ?? "")}>{i.message}</li>)}</ul> : null}
      {run ? (
        <>
          <h2>Last run</h2>
          <div className="table-wrap"><table>
            <caption>{run.status}, {ms(run.totalLatencyMs)}, {usd(run.totalCostUsd)}</caption>
            <thead><tr><th scope="col">Step</th><th scope="col">Start</th><th scope="col">Took</th><th scope="col">Attempts</th><th scope="col">Status</th><th scope="col">Cost</th></tr></thead>
            <tbody>{run.steps.map((s) => <tr key={s.nodeId}><td>{s.label}</td><td>{ms(s.startMs)}</td><td>{ms(s.latencyMs)}</td><td>{s.attempts.map((a) => `${a.kind} ${a.error ?? a.status}`).join("; ") || "–"}</td><td>{s.status}</td><td>{usd(s.costUsd)}</td></tr>)}</tbody>
          </table></div>
          <h3>Reply</h3><pre>{run.output.reply}</pre>
        </>
      ) : null}
    </main>
  );
}
