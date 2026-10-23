import { describe, expect, it } from "vitest";
import { gate } from "../src/gate";
import { accessToken, testAccess } from "./helpers/access";

// The platform's tests run with one Developer list (vitest.config.ts), so an
// empty list can only be tested on the gate itself.
describe("the Developer list", () => {
  it.each(["", " , "])("refuses everyone while it's empty (%j)", async (developerList) => {
    const request = new Request(`${testAccess.origin}/api/me`, {
      headers: { "Cf-Access-Jwt-Assertion": await accessToken(), Origin: testAccess.origin },
    });
    const { teamDomain, audience, origin } = testAccess;
    const decision = await gate(request, { teamDomain, audience, origin, developerList });
    if (decision.ok) throw new Error("The gate let someone in.");
    expect(decision.response.status).toBe(403);
    expect(await decision.response.json()).toEqual({ error: `${testAccess.developer} isn't a Developer on this platform.` });
  });
});
