import { describe, expect, it } from "vitest";
import app from "./index";

// The Worker's routes, end to end: app.request sends the app a request, with the env it would get.
const env = { GREETING: "Hello" } as Env;

describe("the Worker", () => {
  it("greets by name", async () => {
    const response = await app.request("/api/hello/Ada", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Hello, Ada" });
  });
});
