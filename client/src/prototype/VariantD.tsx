// PROTOTYPE, throwaway: placeholder until written.
import type { Sim } from "./simulation";

export function VariantD({ sim }: { sim: Sim }) {
  return <p>Variant D: {sim.state.phase}</p>;
}
