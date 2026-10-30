import { Hono } from "hono";
import type { Hello } from "../shared/api";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/hello/:name", (c) => {
  const hello: Hello = { message: `${c.env.GREETING}, ${c.req.param("name")}` };
  return c.json(hello);
});

export default app;
