// PROTOTYPE, throwaway: placeholder until written.
import type { Sim } from "./simulation";

export function VariantC({ sim }: { sim: Sim }) {
  return <p>Variant C: {sim.state.phase}</p>;
}
