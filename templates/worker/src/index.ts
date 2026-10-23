import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text(`${c.env.GREETING} from your Worker`));

app.get("/api/hello/:name", (c) => c.json({ message: `${c.env.GREETING}, ${c.req.param("name")}` }));

export default app;
