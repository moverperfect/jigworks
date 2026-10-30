// PROTOTYPE, throwaway: "Sunday Runs", the app the scripted Agent builds. It stands in for the Preview.
import { useState, type ReactNode } from "react";
import type { AppFeatures } from "./simulation";

const capacity = 8;
const seeded = ["Priya", "Tom", "Aisha", "Gareth", "Mei", "Callum"];

export interface Pointed {
  id: string;
  label: string;
}

/**
 * The app, live: names can be added. With `pointing`, hovering outlines each part
 * and clicking one calls `onPoint` instead of using the app.
 */
export function FakeApp({
  features,
  pointing = false,
  onPoint,
}: {
  features: AppFeatures;
  pointing?: boolean;
  onPoint?: (pointed: Pointed) => void;
}) {
  const [names, setNames] = useState(seeded);
  const [typed, setTyped] = useState("");
  const [emailed, setEmailed] = useState<string | null>(null);
  const going = features.waitingList ? names.slice(0, capacity) : names;
  const waiting = features.waitingList ? names.slice(capacity) : [];
  const placesLeft = capacity - going.length;

  function add() {
    const name = typed.trim();
    if (!name) return;
    setNames((list) => [...list, name]);
    setTyped("");
    if (features.emailOrganiser) setEmailed(name);
  }

  const part = (id: string, label: string, children: ReactNode, className = "") => (
    <div
      className={`fa-part ${className}${pointing ? " fa-pointable" : ""}${features.emphasised.includes(id) ? " fa-emphasised" : ""}`}
      data-label={label}
      onClickCapture={(event) => {
        if (!pointing) return;
        event.preventDefault();
        event.stopPropagation();
        onPoint?.({ id, label });
      }}
    >
      {children}
    </div>
  );

  return (
    <div className={`fa${features.sporty ? " fa-sporty" : ""}`}>
      {part(
        "heading",
        "the heading",
        <header className="fa-header">
          <p className="fa-kicker">Riverside Running Club</p>
          <h1 className="fa-title">Sunday Runs</h1>
        </header>,
      )}
      {part(
        "details",
        "the run details",
        <section className="fa-card fa-details">
          <p className="fa-when">Sunday 2 November · 8:00</p>
          <p>5 km easy loop from the Parkside gate. All paces welcome; nobody gets left behind.</p>
        </section>,
      )}
      {part(
        "form",
        "the sign-up form",
        <form
          className="fa-card fa-form"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <label className="fa-label" htmlFor="fa-name">
            Your name
          </label>
          <div className="fa-row">
            <input id="fa-name" className="fa-input" value={typed} onChange={(event) => setTyped(event.target.value)} />
            <button type="submit" className="fa-button">
              {features.waitingList && placesLeft <= 0 ? "Join the waiting list" : "I'm coming"}
            </button>
          </div>
          {features.waitingList && (
            <p className="fa-note">{placesLeft > 0 ? `${placesLeft} of ${capacity} places left` : "The run's full"}</p>
          )}
        </form>,
      )}
      {part(
        "list",
        "the list of who's coming",
        <section className="fa-card">
          <h2 className="fa-subtitle">Who's coming ({going.length})</h2>
          <ul className="fa-names">
            {going.map((name, index) => (
              <li key={index}>{name}</li>
            ))}
          </ul>
          {waiting.length > 0 && (
            <>
              <h2 className="fa-subtitle">Waiting list ({waiting.length})</h2>
              <ul className="fa-names fa-waiting">
                {waiting.map((name, index) => (
                  <li key={index}>{name}</li>
                ))}
              </ul>
            </>
          )}
        </section>,
      )}
      {features.emailOrganiser && <p className="fa-footer">The organiser gets an email for each sign-up.</p>}
      {emailed && (
        <div className="fa-email" role="status">
          <strong>Email sent to you:</strong> “{emailed} is coming on Sunday. That's {going.length} so far.”
          <button type="button" className="fa-close" onClick={() => setEmailed(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
