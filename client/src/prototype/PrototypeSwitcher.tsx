// PROTOTYPE, throwaway: the floating bar that switches variants and drives the scripted Agent.
import { useEffect } from "react";
import { moments, type Moment, type Sim } from "./simulation";

export interface VariantInfo {
  key: string;
  name: string;
}

const momentLabels: Record<Moment, string> = {
  start: "Start",
  working: "Working",
  ready: "Ready",
  question: "Question",
  problem: "Problem",
  published: "Published",
};

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
  sim,
}: {
  variants: VariantInfo[];
  current: string;
  onChange(key: string): void;
  sim: Sim;
}) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const step = (by: number) => onChange(variants[(index + by + variants.length) % variants.length]!.key);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!import.meta.env.DEV) return null;
  const variant = variants[index]!;
  const { state } = sim;

  return (
    <div className="proto-bar" role="toolbar" aria-label="Prototype controls">
      <div className="proto-bar-group">
        <button type="button" className="proto-bar-arrow" onClick={() => step(-1)} aria-label="Previous variant">
          ←
        </button>
        <span className="proto-bar-label">
          <strong>{variant.key}</strong> {variant.name}
        </span>
        <button type="button" className="proto-bar-arrow" onClick={() => step(1)} aria-label="Next variant">
          →
        </button>
      </div>
      <div className="proto-bar-group">
        <span className="proto-bar-dim">Jump to</span>
        {moments.map((moment) => (
          <button key={moment} type="button" className="proto-bar-chip" onClick={() => sim.jump(moment)}>
            {momentLabels[moment]}
          </button>
        ))}
      </div>
      <div className="proto-bar-group">
        <button type="button" className="proto-bar-chip" onClick={() => sim.setPaused(!sim.paused)}>
          {sim.paused ? "▶ Resume the Agent" : "⏸ Pause the Agent"}
        </button>
        <label className="proto-bar-check">
          <input type="checkbox" checked={sim.nextTurnFails} onChange={(event) => sim.setNextTurnFails(event.target.checked)} />
          Next Turn fails
        </label>
        <button type="button" className="proto-bar-chip" onClick={sim.reset}>
          Reset
        </button>
      </div>
      <code className="proto-bar-state">
        {state.phase}
        {state.activity ? ` · ${state.activity}` : ""} · v{state.version}
        {state.published ? ` · published v${state.published.version}` : " · not published"}
        {state.pendingQuestion ? " · question waiting" : ""}
        {sim.paused ? " · paused" : ""}
      </code>
    </div>
  );
}
