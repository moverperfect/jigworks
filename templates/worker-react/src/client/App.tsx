import { useEffect, useState } from "react";
import type { Hello } from "../shared/api";

export function App() {
  const [hello, setHello] = useState<Hello | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetch("/api/hello/React")
      .then((response) => response.json() as Promise<Hello>)
      .then(setHello);
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight text-slate-900">Your app</h1>
      <p className="text-lg text-slate-600">{hello ? hello.message : "Asking the Worker…"}</p>
      <button
        type="button"
        className="self-start rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-700"
        onClick={() => setCount((clicks) => clicks + 1)}
      >
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>
    </main>
  );
}
