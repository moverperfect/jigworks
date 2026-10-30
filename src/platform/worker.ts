import { Hono } from "hono";
import { verifyAccess } from "../access";
import { isAppLabel, labelOf, previewHost, slotOf } from "../apphost";
import { gate, type GateConfig } from "../gate";
import { api, type Platform } from "./api";

export { AppHost, AppTail } from "../apphost";
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

/**
 * Access lets Preview hostnames through, and the app host signs its
 * Developer in itself (ADR 0013). A Deployment needs a token from the apps'
 * own Access application, never the platform's.
 */
async function serveApp(request: Request, env: Env, hostname: string): Promise<Response> {
  const label = labelOf(hostname);
  if (!isAppLabel(label)) return new Response("There's no app here.", { status: 404 });
  const host = env.APP_HOSTS.getByName(label);
  if (slotOf(hostname) === "preview") return host.fetch(request);
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
