import { Hono } from "hono";
import { verifyAccess } from "../access";
import { isAppLabel, labelOf, previewHost, sessionCookieOf, slotOf } from "../apphost";
import { gate, type GateConfig } from "../gate";
import { api, type Platform } from "./api";

export { AppData, AppHost, AppTail } from "../apphost";
export { Developer } from "../developer";
export { Workspace } from "../workspace";

const app = new Hono<Platform>();

const gateConfig = (env: Env): GateConfig => ({
  teamDomain: env.ACCESS_TEAM_DOMAIN,
  audience: env.ACCESS_AUD,
  developerList: env.DEVELOPER_LIST,
  origin: env.PLATFORM_ORIGIN,
  devSignedInAs: env.DEV_SIGNED_IN_AS,
});

app.use("/api/*", async (c, next) => {
  const decision = await gate(c.req.raw, gateConfig(c.env));
  if (!decision.ok) return decision.response;
  c.set("email", decision.email);
  await next();
});

app.route("/api", api);

export default {
  /**
   * Apps answer on their own domain (ADR 0012), through their app hosts. On
   * the platform's own hostname, /api/* is the API and everything else is
   * the single-page app.
   */
  async fetch(request, env, ctx) {
    const { hostname, pathname } = new URL(request.url);
    if (env.APPS_DOMAIN && hostname.endsWith(`.${env.APPS_DOMAIN}`)) return serveApp(request, env, hostname);
    if (pathname === "/preview-sign-in") return previewSignIn(request, env);
    if (pathname === "/api" || pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// The period of both Preview rate limits, in wrangler.jsonc.
const rateLimitSeconds = 60;

/**
 * Access lets Preview hostnames through, and the app host signs its
 * Developer in itself (ADR 0013). A Deployment needs a token from the apps'
 * own Access application, never the platform's.
 *
 * A Preview request counts against PREVIEW_RATE_LIMIT, or against the looser
 * PREVIEW_SESSION_RATE_LIMIT when it carries a session cookie, which only the
 * app host can check (#113).
 */
async function serveApp(request: Request, env: Env, hostname: string): Promise<Response> {
  const label = labelOf(hostname);
  if (!isAppLabel(label)) return new Response("There's no app here.", { status: 404 });
  const host = env.APP_HOSTS.getByName(label);
  if (slotOf(hostname) === "preview") {
    // Requests without CF-Connecting-IP, which only tests and wrangler dev send, share one count.
    const key = `${addressBlock(request.headers.get("CF-Connecting-IP") ?? "")} ${label}`;
    const limit = sessionCookieOf(request) ? env.PREVIEW_SESSION_RATE_LIMIT : env.PREVIEW_RATE_LIMIT;
    if (!(await limit.limit({ key })).success) {
      return new Response("Too many requests to this app. Wait a minute, then try again.", {
        status: 429,
        headers: { "Retry-After": String(rateLimitSeconds), "Cache-Control": "no-store" },
      });
    }
    return host.fetch(request);
  }
  const identity = await verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.APPS_ACCESS_AUD });
  if (identity?.kind !== "person") return new Response("Sign in through Cloudflare Access.", { status: 401 });
  return host.fetch(request);
}

/**
 * Where a Preview opened in a tab without a session comes: the platform's
 * Access signs the Developer in, and this sends them back with a sign-in
 * link, if the Preview is theirs (ADR 0013).
 */
async function previewSignIn(request: Request, env: Env): Promise<Response> {
  const decision = await gate(request, { ...gateConfig(env), navigation: true });
  if (!decision.ok) return decision.response;
  const url = new URL(request.url);
  const host = url.searchParams.get("host") ?? "";
  const label = labelOf(host);
  const notYours = new Response("There's no Preview of yours at that address.", { status: 404 });
  if (host !== previewHost(label, env.APPS_DOMAIN) || !isAppLabel(label)) return notYours;
  const workspaceId = await env.APP_HOSTS.getByName(label).workspaceId();
  if (!workspaceId || !(await env.DEVELOPERS.getByName(decision.email).get(workspaceId))) return notYours;
  const link = await env.WORKSPACES.getByName(workspaceId).previewSignIn("document", url.searchParams.get("to") ?? "/");
  return new Response(null, { status: 303, headers: { Location: link, "Cache-Control": "no-store" } });
}

/** What the rate limit counts by: an IPv4 address, or an IPv6 address's /64, the block one subscriber is usually given. */
function addressBlock(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}
