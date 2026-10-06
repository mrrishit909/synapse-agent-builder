"use client";
// Command palette and keyboard help. Native <dialog> for focus trapping and Escape.
import { useEffect, useMemo, useRef, useState } from "react";
import { compare, get, inspect, loadTemplate, runNow, set, useApp } from "../store.ts";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    const c = () => onClose();
    d.addEventListener("close", c);
    return () => d.removeEventListener("close", c);
  }, [open, onClose]);
  return ref;
}

export function Palette() {
  const open = useApp((s) => s.palette);
  const close = useMemo(() => () => set({ palette: false }), []);
  const ref = useDialog(open, close);
  const [q, setQ] = useState("");
  const [k, setK] = useState(0);
  const wf = useApp((s) => s.wf);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const acts = [
      { label: "Run on the selected e-mail", run: () => runNow() },
      { label: "Load the six-node template", run: () => loadTemplate() },
      { label: "Compare versions", run: () => compare() },
      { label: "Toggle list view", run: () => set((s) => ({ listView: !s.listView })) },
      { label: "Toggle reduced motion", run: () => set((s) => ({ reduced: !s.reduced })) },
    ];
    const nodes = wf.nodes.map((n) => ({ label: `Node: ${n.label} (${n.id})`, run: () => inspect(n.id) }));
    return [...nodes, ...acts].filter((a) => !t || a.label.toLowerCase().includes(t));
  }, [q, wf]);
  const run = (i: number) => { items[i]?.run(); set({ palette: false }); setQ(""); };
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Command palette">
      <input autoFocus placeholder="Search nodes and actions…" value={q} role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={`pi-${k}`}
        onChange={(e) => { setQ(e.target.value); setK(0); }}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setK(Math.min(items.length - 1, k + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setK(Math.max(0, k - 1)); } if (e.key === "Enter") { e.preventDefault(); run(k); } }} />
      <ul id="palette-list" role="listbox">
        {items.map((it, i) => <li key={i} id={`pi-${i}`} role="option" aria-selected={i === k}><button onClick={() => run(i)}>{it.label}</button></li>)}
      </ul>
    </dialog>
  );
}

export function Help() {
  const open = useApp((s) => s.help);
  const close = useMemo(() => () => set({ help: false }), []);
  const ref = useDialog(open, close);
  const keys = [["⌘K / Ctrl K / /", "search nodes and actions"], ["R", "run on the selected e-mail"], ["Space", "play / pause the trace"], ["← →", "step the trace 100 ms (Shift: 1 s)"], ["L", "list view"], ["M", "reduced motion"], ["P", "pause all motion"], ["Delete", "delete selected nodes"], ["F", "fit the graph"], ["Esc", "back"]];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="help-title">
      <h2 id="help-title">Keyboard</h2>
      <table><tbody>{keys.map(([a, b]) => <tr key={a}><th scope="row"><kbd>{a}</kbd></th><td>{b}</td></tr>)}</tbody></table>
      <p className="small muted">On the canvas: drag to pan, wheel to zoom, drag a node to move it (its neighbours lean with it), drag from a node&apos;s right edge to connect, Shift-click to multi-select.</p>
      <button onClick={close}>Close</button>
    </dialog>
  );
}
export { get };
