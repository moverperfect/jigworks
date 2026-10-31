import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

// Components render to HTML here. There's no DOM to click in.
describe("App", () => {
  it("renders its heading, and asks the Worker for a greeting", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Your app");
    expect(html).toContain("Asking the Worker…");
  });
});
