import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStore } from "./fake-store";
import { organiser } from "./organiser";

// A route of the organiser's own, added before the area is mounted, as the app's would be.
organiser.get("/api/rota", (c) => c.json({ rota: ["Ada", "Grace"] }));
const app = new Hono().route("/organiser", organiser);

const passcode = "correct horse battery staple";
const appEnv = (overrides: { ORGANISER_PASSCODE?: string } = {}) => ({ STORE: fakeStore(), ORGANISER_PASSCODE: passcode, ...overrides });
type AppEnv = ReturnType<typeof appEnv>;

const signIn = (env: AppEnv, entered: string, next?: string) =>
  app.request(
    "/organiser/sign-in",
    { method: "POST", body: new URLSearchParams({ passcode: entered, ...(next ? { next } : {}) }) },
    env,
  );

/** The cookie a response sets, as the browser would send it back. */
const cookieFrom = (response: Response) => response.headers.get("Set-Cookie")!.split(";", 1)[0]!;

const rota = (env: AppEnv, cookie?: string, accept = "*/*") =>
  app.request("/organiser/api/rota", { headers: { Accept: accept, ...(cookie ? { Cookie: cookie } : {}) } }, env);

describe("the organiser's area", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a sign-in page that asks for the passcode", async () => {
    const response = await app.request("/organiser/sign-in", {}, appEnv());
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<form method="post" action="/organiser/sign-in">');
    expect(page).toContain('<input id="passcode" name="passcode" type="password"');
  });

  it("signs in with the passcode, with a __Host- session cookie, and lets the organiser in", async () => {
    const env = appEnv();
    const response = await signIn(env, passcode);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/organiser");
    const setCookie = response.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/^__Host-organiser=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);

    const allowed = await rota(env, cookieFrom(response));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ rota: ["Ada", "Grace"] });
  });

  it("goes back to the page that asked, but never to another site", async () => {
    const env = appEnv();
    expect((await signIn(env, passcode, "/organiser/rota?week=2")).headers.get("Location")).toBe("/organiser/rota?week=2");
    for (const elsewhere of ["//evil.example/", "/\\evil.example/", "/a/..//evil.example/", "https://evil.example/", "rota"]) {
      expect((await signIn(env, passcode, elsewhere)).headers.get("Location")).toBe("/organiser");
    }
  });

  it("refuses a wrong passcode the same way, however close it was, and sets no cookie", async () => {
    const env = appEnv();
    const answers = [];
    for (const wrong of ["correct horse battery stapler", "c", "something else entirely"]) {
      const response = await signIn(env, wrong);
      expect(response.status).toBe(401);
      expect(response.headers.get("Set-Cookie")).toBe(null);
      answers.push(await response.text());
    }
    // The page escapes its apostrophes.
    expect(answers[0]).toContain("That passcode isn&#39;t right.");
    expect(new Set(answers).size).toBe(1);
  });

  it("keeps everyone out of its routes without a session: a page goes to the sign-in page, anything else gets a 401", async () => {
    const env = appEnv();
    const fetched = await rota(env);
    expect(fetched.status).toBe(401);
    expect(await fetched.json()).toEqual({ error: "Only the organiser can do that. Sign in first." });

    const opened = await rota(env, undefined, "text/html,application/xhtml+xml");
    expect(opened.status).toBe(303);
    expect(opened.headers.get("Location")).toBe("/organiser/sign-in?next=%2Forganiser%2Fapi%2Frota");

    // A made-up or tampered cookie is no session.
    expect((await rota(env, "__Host-organiser=made-up")).status).toBe(401);
    const cookie = cookieFrom(await signIn(env, passcode));
    expect((await rota(env, cookie.replace("=", "=0"))).status).toBe(401);
  });

  it("signs out, so the session's cookie no longer lets anyone in, even a copy of it", async () => {
    const env = appEnv();
    const cookie = cookieFrom(await signIn(env, passcode));
    const response = await app.request("/organiser/sign-out", { method: "POST", headers: { Cookie: cookie } }, env);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/organiser/sign-in");
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-organiser=; Max-Age=0; Path=\/; Secure/);
    expect((await rota(env, cookie)).status).toBe(401);
  });

  it("signs everyone out when the passcode changes, even once the old one is put back", async () => {
    const env = appEnv();
    const cookie = cookieFrom(await signIn(env, passcode));
    expect((await rota(env, cookie)).status).toBe(200);
    expect((await rota({ ...env, ORGANISER_PASSCODE: "a new passcode" }, cookie)).status).toBe(401);
    expect((await rota(env, cookie)).status).toBe(401);
  });

  it("ends a session after 30 days", async () => {
    vi.useFakeTimers();
    const env = appEnv();
    const cookie = cookieFrom(await signIn(env, passcode));
    vi.advanceTimersByTime(29 * 86_400_000);
    expect((await rota(env, cookie)).status).toBe(200);
    vi.advanceTimersByTime(2 * 86_400_000);
    expect((await rota(env, cookie)).status).toBe(401);
  });

  it("pauses signing in for 15 minutes after 20 wrong passcodes", async () => {
    vi.useFakeTimers();
    const env = appEnv();
    for (let i = 0; i < 20; i++) expect((await signIn(env, "a guess")).status).toBe(401);
    const paused = await signIn(env, passcode);
    expect(paused.status).toBe(429);
    expect(await paused.text()).toContain("Too many wrong passcodes. Try again in 15 minutes.");
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect((await signIn(env, passcode)).status).toBe(303);
  });

  it("counts wrong passcodes sent together, so none of them get past the pause", async () => {
    const env = appEnv();
    const statuses = await Promise.all(Array.from({ length: 30 }, () => signIn(env, "a guess")).map(async (sent) => (await sent).status));
    // Compared, and found wrong: never more than the pause allows.
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(20);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
  });

  it("lets nobody in before the passcode is set", async () => {
    const env = appEnv({ ORGANISER_PASSCODE: "" });
    const response = await signIn(env, "");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("The organiser&#39;s passcode hasn&#39;t been set yet.");
    expect((await rota(env, "__Host-organiser=anything")).status).toBe(401);
  });
});
