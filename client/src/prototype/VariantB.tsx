// PROTOTYPE, throwaway: placeholder until written.
import type { Sim } from "./simulation";

export function VariantB({ sim }: { sim: Sim }) {
  return <p>Variant B: {sim.state.phase}</p>;
}
