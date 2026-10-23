import { Hono } from "hono";
import { gate } from "../gate";
import { api, type Platform } from "./api";

export { Developer } from "../developer";
export { Workspace } from "../workspace";

// Only /api/* reaches the Worker (`run_worker_first`). Static assets, and the
// single-page app's own routes, are served before it runs.
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

export default app;
