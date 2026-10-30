// PROTOTYPE, throwaway. Four chat-first variants of the whole journey, for people who aren't developers:
// describe an app, the Agent picks the Template and builds it, change it by asking, then publish it.
// Switchable via `?variant=A|B|C|D` on `/prototype/chat-first`, served only by the dev server (`pnpm prototype`).
// One scripted Agent (simulation.ts) drives every variant, so they're compared on the same moments and data.
import { useState } from "react";
import { PrototypeSwitcher, type VariantInfo } from "./PrototypeSwitcher";
import { useSimulation } from "./simulation";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";
import { VariantD } from "./VariantD";
import "./prototype.css";

const variants: VariantInfo[] = [
  { key: "A", name: "Just a conversation" },
  { key: "B", name: "Chat beside the app" },
  { key: "C", name: "The app is the canvas" },
  { key: "D", name: "Agree a plan, then build" },
];

function readVariant(): string {
  const key = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  return variants.some((v) => v.key === key) ? key! : "A";
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
      </div>
      <PrototypeSwitcher variants={variants} current={variant} onChange={change} sim={sim} />
    </div>
  );
}
