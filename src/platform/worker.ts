import { Hono } from "hono";
import { labelOf } from "../apphost";
import { gate } from "../gate";
import { api, type Platform } from "./api";

export { AppHost, AppTail } from "../apphost";
export { Developer } from "../developer";
export { Workspace } from "../workspace";

const app = new Hono<Platform>();

app.use("/api/*", async (c, next) => {
  const decision = await gate(c.req.raw, {
    teamDomain: c.env.ACCESS_TEAM_DOMAIN,
    audience: c.env.ACCESS_AUD,
    developerList: c.env.DEVELOPER_LIST,
    origin: c.env.PLATFORM_ORIGIN,
    devSignedInAs: c.env.DEV_SIGNED_IN_AS,
  });
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
    if (env.APPS_DOMAIN && hostname.endsWith(`.${env.APPS_DOMAIN}`)) {
      return serveApp(request, env, labelOf(hostname));
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function serveApp(request: Request, env: Env, label: string): Promise<Response> {
  // The apps' gate comes next in ticket 08. Until then, no app is served.
  void request;
  void env;
  void label;
  return new Response("Apps aren't served yet.", { status: 403 });
}
