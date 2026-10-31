// PROTOTYPE, throwaway. Verdict (2026-10-31): E, "On the bench": A's start page for a new app, then B's split,
// in Direction 1 of DESIGN-DIRECTIONS.md. The rest stay here as the primary source.
// Chat-first variants of the whole journey, for people who aren't developers:
// describe an app, the Agent picks the Template and builds it, change it by asking, then publish it.
// Switchable via `?variant=A` to `G` on `/prototype/chat-first`, served only by the dev server (`pnpm prototype`).
// One scripted Agent (simulation.ts) drives every variant, so they're compared on the same moments and data.
import { useState } from "react";
import { PrototypeSwitcher, type VariantInfo } from "./PrototypeSwitcher";
import { useSimulation } from "./simulation";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";
import { VariantD } from "./VariantD";
import { VariantE } from "./VariantE";
import { VariantF } from "./VariantF";
import { VariantG } from "./VariantG";
import "./prototype.css";

// Round 2: Jack leans to B, with A's start page for brand new apps. E, F and G are Fable 5.1's
// visual directions for that structure (DESIGN-DIRECTIONS.md); A and B stay for comparison.
// C and D are out of the bar but still open with `?variant=C` or `?variant=D`.
const variants: VariantInfo[] = [
  { key: "A", name: "Just a conversation" },
  { key: "B", name: "Chat beside the app" },
  { key: "E", name: "On the bench" },
  { key: "F", name: "Fridge door" },
  { key: "G", name: "Stage directions" },
];
const retired: VariantInfo[] = [
  { key: "C", name: "The app is the canvas" },
  { key: "D", name: "Agree a plan, then build" },
];

function readVariant(): string {
  const key = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  return [...variants, ...retired].some((v) => v.key === key) ? key! : "E";
}

export function ChatFirstPrototypePage() {
  const [variant, setVariant] = useState(readVariant);
  // One simulation for all the variants, so switching keeps the moment.
  const sim = useSimulation();

  function change(key: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", key);
    window.history.replaceState(null, "", url);
    setVariant(key);
  }

  return (
    <div className="proto-page">
      <div className="proto-stage">
        {variant === "A" && <VariantA sim={sim} />}
        {variant === "B" && <VariantB sim={sim} />}
        {variant === "C" && <VariantC sim={sim} />}
        {variant === "D" && <VariantD sim={sim} />}
        {variant === "E" && <VariantE sim={sim} />}
        {variant === "F" && <VariantF sim={sim} />}
        {variant === "G" && <VariantG sim={sim} />}
      </div>
      <PrototypeSwitcher variants={variants.some((v) => v.key === variant) ? variants : [...variants, ...retired]} current={variant} onChange={change} sim={sim} />
    </div>
  );
}
