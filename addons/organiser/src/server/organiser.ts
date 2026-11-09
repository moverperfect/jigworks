import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { html } from "hono/html";
import { collection, type Store } from "./store";

/** How long signing in lasts. */
const sessionDays = 30;
/** Wrong passcodes, from anyone, that pause signing in for the rest of `pauseMinutes`. */
const wrongAllowed = 20;
const pauseMinutes = 15;

const day = 86_400_000;

/** Sent as `__Host-organiser`: the platform passes on only cookies whose names start with `__Host-`. */
const cookieName = "organiser";
const signInPath = "/organiser/sign-in";

// The app's env, with the passcode, a Secret, which isn't set until the Developer gives it.
type Bindings = Env & { STORE: DurableObjectNamespace<Store>; ORGANISER_PASSCODE?: string };

/** Each with a digest of the passcode it was made with. */
const sessions = (env: Bindings) => collection<{ expires: number; passcode: string }>(env.STORE, "organiser-sessions");
const wrongPasscodes = (env: Bindings) => collection<{ at: number }>(env.STORE, "organiser-wrong-passcodes");
/** One record: a digest of the passcode last seen. */
const passcodeInUse = (env: Bindings) => collection<{ digest: string }>(env.STORE, "organiser-passcode");

/**
 * The organiser's area: the sign-in page, signing out, and the routes added
 * to it, which only a signed-in organiser reaches. Add the area's routes,
 * then mount it with `app.route("/organiser", organiser)`.
 */
export const organiser = new Hono<{ Bindings: Bindings }>();

organiser.get("/sign-in", (c) => c.html(signInPage(safeNext(c.req.query("next")))));

organiser.post("/sign-in", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const passcode = c.env.ORGANISER_PASSCODE;
  if (!passcode) return c.html(signInPage(next, "The organiser's passcode hasn't been set yet."), 503);

  const now = Date.now();
  const wrong = wrongPasscodes(c.env);
  // Counted as wrong until it's found right, so guesses sent together can't all get in under the limit.
  const attempt = await wrong.add({ at: now });
  let recent = 0;
  for (const { id, at } of await wrong.list()) {
    if (at > now - pauseMinutes * 60_000) recent += 1;
    else await wrong.remove(id);
  }
  if (recent > wrongAllowed) {
    await wrong.remove(attempt.id);
    return c.html(signInPage(next, `Too many wrong passcodes. Try again in ${pauseMinutes} minutes.`), 429);
  }
  if (typeof form.passcode !== "string" || !(await passcodesMatch(form.passcode, passcode))) {
    return c.html(signInPage(next, "That passcode isn't right."), 401);
  }
  await wrong.remove(attempt.id);
  const current = await passcodeDigest(passcode);
  await forgetOldSessions(c.env, current);

  const stored = sessions(c.env);
  for (const { id, expires } of await stored.list()) if (expires <= now) await stored.remove(id);
  const session = await stored.add({ expires: now + sessionDays * day, passcode: current });
  // Signed with the passcode, so changing it signs everyone out.
  await setSignedCookie(c, cookieName, session.id, passcode, {
    prefix: "host",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: sessionDays * 86_400,
  });
  return c.redirect(next, 303);
});

organiser.post("/sign-out", async (c) => {
  const id = await sessionId(c);
  if (id) await sessions(c.env).remove(id);
  deleteCookie(c, cookieName, { prefix: "host" });
  return c.redirect(signInPath, 303);
});

/**
 * Lets a signed-in organiser through to every route added to the area after
 * it. Anyone else opening a page is sent to the sign-in page, and comes back
 * after; any other request gets a 401.
 */
const organiserOnly: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const id = await sessionId(c);
  const session = id ? await sessions(c.env).get(id) : null;
  if (session && session.expires > Date.now()) return next();
  if (c.req.method === "GET" && c.req.header("Accept")?.includes("text/html")) {
    const { pathname, search } = new URL(c.req.url);
    return c.redirect(`${signInPath}?next=${encodeURIComponent(pathname + search)}`, 303);
  }
  return c.json({ error: "Only the organiser can do that. Sign in first." }, 401);
};

organiser.use("*", organiserOnly);

/** The session the cookie names, if its signature holds with the passcode as it is now. */
async function sessionId(c: Context<{ Bindings: Bindings }>): Promise<string | null> {
  const passcode = c.env.ORGANISER_PASSCODE;
  if (!passcode) return null;
  await forgetOldSessions(c.env, await passcodeDigest(passcode));
  return (await getSignedCookie(c, passcode, cookieName, "host")) || null;
}

/**
 * Removes the sessions made with another passcode the first time a request
 * sees a new one, so putting the old passcode back afterwards doesn't sign
 * them in again. `current` is the passcode's digest. Sessions made with it
 * stay, so two sign-ins at once don't remove each other's.
 */
async function forgetOldSessions(env: Bindings, current: string): Promise<void> {
  const inUse = passcodeInUse(env);
  const [last] = await inUse.list();
  if (last?.digest === current) return;
  const stored = sessions(env);
  for (const { id, passcode } of await stored.list()) if (passcode !== current) await stored.remove(id);
  if (last) await inUse.update(last.id, { digest: current });
  else await inUse.add({ digest: current });
}

const passcodeDigest = async (passcode: string) =>
  [...new Uint8Array(await digest(passcode))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

/** Whether two passcodes are the same, taking as long whatever the difference, so nothing about the right one leaks. */
async function passcodesMatch(given: string, passcode: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(passcode)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Where to go after signing in: a path on this site, never another site. */
function safeNext(next: unknown): string {
  const base = "https://app.invalid";
  const url = typeof next === "string" && next.startsWith("/") ? URL.parse(next, base) : null;
  const path = url ? url.pathname + url.search + url.hash : "";
  // Checked once resolved too: `/a/..//elsewhere` resolves to `//elsewhere`, another site's address.
  return url?.origin === base && !path.startsWith("//") ? path : "/organiser";
}

function signInPage(next: string, problem?: string) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in to the organiser's area</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; font: 16px/1.5 system-ui, sans-serif; }
      form { display: grid; gap: 0.75rem; width: min(20rem, calc(100vw - 2rem)); }
      h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
      input, button { font: inherit; padding: 0.5rem 0.75rem; border-radius: 0.5rem; }
      input { border: 1px solid #94a3b8; }
      button { border: 0; background: #0284c7; color: #fff; font-weight: 600; cursor: pointer; }
      [role="alert"] { margin: 0; color: #b91c1c; }
    </style>
  </head>
  <body>
    <form method="post" action="${signInPath}">
      <h1>Organisers only</h1>
      <label for="passcode">Passcode</label>
      <input id="passcode" name="passcode" type="password" autocomplete="current-password" required autofocus
        ${problem ? html`aria-describedby="problem"` : ""} />
      ${problem ? html`<p id="problem" role="alert">${problem}</p>` : ""}
      <input type="hidden" name="next" value="${next}" />
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>
`;
}
