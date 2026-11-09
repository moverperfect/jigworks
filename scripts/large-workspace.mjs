// Makes a large test Workspace through the platform's API and runs ten
// Builds in it, interleaved with saves and Checks as the page causes them
// (#87). The large app is the Worker + React Template with 120 components, 30
// pages and 10 server routes, using a charting library, a date library and a
// UI kit. The moderate one has 60 components, 15 pages and 5 routes, with the
// date library alone. Three more sit between them (#99): see `shapes`.
// Nothing here calls the Agent, so no Turns on the real model run.
//
// It has no imports, so a browser can run it too. Locally, against
// `pnpm platform:dev` (`.dev.vars` as in docs/development.md):
//
//   node scripts/large-workspace.mjs http://127.0.0.1:8787 make [large|half|ui|small|moderate]
//   node scripts/large-workspace.mjs http://127.0.0.1:8787 builds <workspace id> [large|half|ui|small|moderate]
//   node scripts/large-workspace.mjs http://127.0.0.1:8787 turn <workspace id>
//   node scripts/large-workspace.mjs http://127.0.0.1:8787 delete <workspace id>
//
// Deployed, Access lets only a signed-in person through, so run it from the
// Developer's signed-in tab on the platform, at a pushed commit:
//
//   const m = await import(URL.createObjectURL(new Blob(
//     [await (await fetch("https://raw.githubusercontent.com/<owner>/<repo>/<sha>/scripts/large-workspace.mjs")).text()],
//     { type: "text/javascript" })));
//   m.progress; // each step as it finishes
//   await m.make(location.origin, "large"); await m.builds(location.origin, id, "large"); await m.remove(location.origin, id);
//
// Times here are the round trips the caller sees. CPU and wall time, esbuild's
// memory and the isolate come from the tail (docs/development.md, Live checks).

/** The Packages the app adds to the Template's, at exact versions published more than a day before #87's run. */
const addedPackages = {
  "@emotion/react": "11.14.0",
  "@emotion/styled": "11.14.1",
  "@mui/material": "9.5.0",
  "date-fns": "4.4.0",
  recharts: "3.10.1",
};

/** The added Packages but the charting library: the UI kit and the date library. */
const { recharts: _, ...withoutCharts } = addedPackages;

const kinds = ["Chart", "Dates", "Form", "Table", "Stats", "Notice"];

/** The apps: their size, the Packages they add, their components' kinds, and whether they use the UI kit. */
const shapes = {
  large: { components: 120, pages: 30, routes: 10, packages: addedPackages, kinds, ui: true },
  moderate: { components: 60, pages: 15, routes: 5, packages: { "date-fns": addedPackages["date-fns"] }, kinds: ["Stats"], ui: false },
  // Between the two, to find where Builds stop fitting (#99): the large app halved, the moderate one with the UI kit
  // instead of the charts, and a small app with the UI kit.
  half: { components: 60, pages: 15, routes: 5, packages: addedPackages, kinds, ui: true },
  ui: { components: 60, pages: 15, routes: 5, packages: withoutCharts, kinds: kinds.filter((kind) => kind !== "Chart"), ui: true },
  small: { components: 6, pages: 2, routes: 1, packages: withoutCharts, kinds: ["Form"], ui: true },
};
let counts = shapes.large;
/** Every step below makes the app of this shape. */
const use = (shape) => {
  if (!shapes[shape]) throw new Error(`No app shape "${shape}": use ${Object.keys(shapes).join(", ")}.`);
  counts = shapes[shape];
};

const pad = (n) => String(n).padStart(3, "0");
const componentName = (i) => `${counts.kinds[i % counts.kinds.length]}${pad(i)}`;
const pageName = (i) => `Page${pad(i)}`;

/** The files the app adds or replaces, path to text. */
function largeAppFiles() {
  const files = {};
  for (let i = 0; i < counts.components; i++) {
    files[`src/client/components/${componentName(i)}.tsx`] = component(i);
  }
  for (let i = 0; i < counts.pages; i++) files[`src/client/pages/${pageName(i)}.tsx`] = page(i);
  for (let i = 0; i < counts.routes; i++) files[`src/server/routes/route${pad(i)}.ts`] = route(i);
  files["src/shared/records.ts"] = shared();
  files["src/client/App.tsx"] = app();
  files["src/server/index.ts"] = server();
  return files;
}

/** The Template's `package.json` with the added Packages. */
function packageJson(template) {
  const manifest = JSON.parse(template);
  manifest.dependencies = { ...manifest.dependencies, ...counts.packages };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Component `i`, its heading marked with `edit` and `stamp` when a round edits it. */
function component(i, edit = 0, stamp = "") {
  const name = componentName(i);
  const title = `${name} ${["overview", "this week", "by team", "history", "summary"][i % 5]}${edit ? ` (edit ${edit}${stamp ? `, ${stamp}` : ""})` : ""}`;
  const seed = (i * 7919) % 97;
  switch (kinds.indexOf(counts.kinds[i % counts.kinds.length])) {
    case 0: {
      const chart = [
        ["LineChart", "Line", `<Line type="monotone" dataKey="value" stroke="#0284c7" strokeWidth={2} dot={false} />`],
        ["BarChart", "Bar", `<Bar dataKey="value" fill="#0ea5e9" radius={[4, 4, 0, 0]} />`],
        ["AreaChart", "Area", `<Area type="monotone" dataKey="value" stroke="#0369a1" fill="#bae6fd" />`],
      ][i % 3];
      return `import { useMemo, useState } from "react";
import { ${chart[0]}, ${chart[1]}, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { addDays, format, startOfWeek } from "date-fns";
import { Card, CardContent, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import type { Point } from "../../shared/records";

/** ${title}: a chart of the last few weeks. */
export function ${name}({ points }: { points?: Point[] }) {
  const [range, setRange] = useState<"week" | "month">("week");
  const data = useMemo(() => {
    const start = startOfWeek(new Date(2026, 0, ${(seed % 28) + 1}));
    const days = range === "week" ? 7 : 30;
    return (points ?? Array.from({ length: days }, (_, day) => ({
      at: addDays(start, day).toISOString(),
      value: Math.round(50 + 40 * Math.sin((day + ${seed}) / 3)),
    }))).map((point) => ({ ...point, label: format(new Date(point.at), "d MMM") }));
  }, [points, range]);
  const total = data.reduce((sum, point) => sum + point.value, 0);
  return (
    <Card variant="outlined" className="rounded-xl">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Typography variant="h6">${title}</Typography>
          <ToggleButtonGroup size="small" exclusive value={range} onChange={(_, next) => next && setRange(next)}>
            <ToggleButton value="week">Week</ToggleButton>
            <ToggleButton value="month">Month</ToggleButton>
          </ToggleButtonGroup>
        </div>
        <p className="text-sm text-slate-500">Total {total.toLocaleString("en-GB")}</p>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <${chart[0]} data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis />
              <Tooltip />
              <Legend />
              ${chart[2]}
            </${chart[0]}>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
`;
    }
    case 1:
      return `import { useState } from "react";
import { addDays, differenceInCalendarDays, eachDayOfInterval, format, isWeekend, subMonths } from "date-fns";
import { enGB } from "date-fns/locale";
import { Chip, List, ListItem, ListItemText, Switch, Typography } from "@mui/material";

/** ${title}: the days in a range, with weekends marked. */
export function ${name}({ from = new Date(2026, ${seed % 12}, 1) }: { from?: Date }) {
  const [skipWeekends, setSkipWeekends] = useState(false);
  const start = subMonths(from, ${(seed % 3) + 1});
  const days = eachDayOfInterval({ start, end: addDays(start, ${10 + (seed % 20)}) }).filter((day) => !skipWeekends || !isWeekend(day));
  return (
    <section className="rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <Typography variant="h6">${title}</Typography>
        <label className="flex items-center gap-1 text-sm">
          <Switch checked={skipWeekends} onChange={(event) => setSkipWeekends(event.target.checked)} /> Weekdays only
        </label>
      </div>
      <List dense>
        {days.map((day) => (
          <ListItem key={day.toISOString()} secondaryAction={isWeekend(day) ? <Chip size="small" label="Weekend" /> : null}>
            <ListItemText
              primary={format(day, "EEEE d MMMM yyyy", { locale: enGB })}
              secondary={\`\${differenceInCalendarDays(day, from)} days from the start\`}
            />
          </ListItem>
        ))}
      </List>
    </section>
  );
}
`;
    case 2:
      return `import { useState, type FormEvent } from "react";
import { format } from "date-fns";
import { Alert, Button, MenuItem, Slider, Stack, TextField } from "@mui/material";
import type { Booking } from "../../shared/records";

const rooms = ["Hall", "Studio", "Garden room", "Kitchen"] as const;

/** ${title}: a booking form, checked before it's sent. */
export function ${name}({ onSubmit }: { onSubmit?: (booking: Booking) => void }) {
  const [name, setName] = useState("");
  const [room, setRoom] = useState<(typeof rooms)[number]>("Hall");
  const [people, setPeople] = useState(${(seed % 20) + 2});
  const [sent, setSent] = useState<string | null>(null);
  const problem = name.trim().length < 2 ? "Give a name of at least two letters." : people > ${30 + seed} ? "That's too many people for one room." : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    const booking: Booking = { name: name.trim(), room, people, at: new Date().toISOString() };
    onSubmit?.(booking);
    setSent(format(new Date(booking.at), "HH:mm"));
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-800">${title}</h2>
      <Stack spacing={2}>
        <TextField label="Your name" value={name} onChange={(event) => setName(event.target.value)} error={Boolean(name) && Boolean(problem)} />
        <TextField select label="Room" value={room} onChange={(event) => setRoom(event.target.value as (typeof rooms)[number])}>
          {rooms.map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </TextField>
        <div>
          <span className="text-sm text-slate-600">People: {people}</span>
          <Slider min={1} max={${60 + seed}} value={people} onChange={(_, value) => setPeople(value as number)} />
        </div>
        {problem && name ? <Alert severity="warning">{problem}</Alert> : null}
        {sent ? <Alert severity="success">Booked at {sent}.</Alert> : null}
        <Button type="submit" variant="contained" disabled={Boolean(problem)}>
          Book
        </Button>
      </Stack>
    </form>
  );
}
`;
    case 3:
      return `import { useMemo, useState } from "react";
import { compareAsc, format, parseISO } from "date-fns";
import { Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, TextField } from "@mui/material";
import type { Booking } from "../../shared/records";

type Column = "name" | "room" | "people" | "at";

/** ${title}: bookings, sorted and filtered. */
export function ${name}({ bookings = [] }: { bookings?: Booking[] }) {
  const [sortBy, setSortBy] = useState<Column>("${["name", "room", "people", "at"][seed % 4]}");
  const [ascending, setAscending] = useState(true);
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const shown = bookings.filter((booking) => booking.name.toLowerCase().includes(filter.toLowerCase()));
    const order = (a: Booking, b: Booking) =>
      sortBy === "at" ? compareAsc(parseISO(a.at), parseISO(b.at)) : sortBy === "people" ? a.people - b.people : a[sortBy].localeCompare(b[sortBy]);
    return shown.sort((a, b) => (ascending ? order(a, b) : order(b, a)));
  }, [bookings, sortBy, ascending, filter]);
  const sort = (column: Column) => {
    setAscending(column === sortBy ? !ascending : true);
    setSortBy(column);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold">${title}</h2>
        <TextField size="small" label="Filter by name" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <TableContainer className="rounded-lg border border-slate-200">
        <Table size="small">
          <TableHead>
            <TableRow>
              {(["name", "room", "people", "at"] as const).map((column) => (
                <TableCell key={column}>
                  <TableSortLabel active={sortBy === column} direction={ascending ? "asc" : "desc"} onClick={() => sort(column)}>
                    {column}
                  </TableSortLabel>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((booking) => (
              <TableRow key={booking.name + booking.at}>
                <TableCell>{booking.name}</TableCell>
                <TableCell>{booking.room}</TableCell>
                <TableCell>{booking.people}</TableCell>
                <TableCell>{format(parseISO(booking.at), "d MMM yyyy, HH:mm")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}
`;
    case 4:
      return `import { useEffect, useState } from "react";
import { formatDistanceStrict } from "date-fns";
import type { Summary } from "../../shared/records";

/** ${title}: the server's summary, as four tiles. */
export function ${name}() {
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    fetch("/api/summary/${i % counts.routes}")
      .then((response) => response.json() as Promise<Summary>)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);
  const tiles = summary
    ? [
        ["Bookings", summary.bookings.toLocaleString("en-GB")],
        ["People", summary.people.toLocaleString("en-GB")],
        ["Busiest room", summary.busiestRoom],
        ["Updated", formatDistanceStrict(new Date(summary.updatedAt), new Date(), { addSuffix: true })],
      ]
    : [];
  return (
    <section className="grid grid-cols-2 gap-${(seed % 4) + 2} md:grid-cols-4">
      <h2 className="col-span-full text-lg font-semibold text-slate-800">${title}</h2>
      {tiles.map(([label, value]) => (
        <div key={label} className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
        </div>
      ))}
      {summary ? null : <p className="col-span-full text-sm text-slate-400">Loading…</p>}
    </section>
  );
}
`;
    default:
      return `import { useState } from "react";
import { addMinutes, format } from "date-fns";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Snackbar } from "@mui/material";

/** ${title}: asks before doing something that can't be undone. */
export function ${name}({ action = "Cancel the booking", onConfirm }: { action?: string; onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<Date | null>(null);
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="mb-2 font-medium text-amber-900">${title}</p>
      <Button color="warning" variant="outlined" onClick={() => setOpen(true)}>
        {action}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>{action}?</DialogTitle>
        <DialogContent>This can't be undone. You can book again until {format(addMinutes(new Date(), ${15 + seed}), "HH:mm")}.</DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Keep it</Button>
          <Button
            color="warning"
            onClick={() => {
              setOpen(false);
              setDone(new Date());
              onConfirm?.();
            }}
          >
            {action}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar open={done !== null} autoHideDuration={4000} onClose={() => setDone(null)}>
        <Alert severity="info">Done at {done ? format(done, "HH:mm:ss") : ""}.</Alert>
      </Snackbar>
    </div>
  );
}
`;
  }
}

function page(i) {
  const used = [0, 1, 2, 3].map((n) => componentName((i * 4 + n) % counts.components));
  const tabs = counts.ui
    ? `      <Tabs value={tab} onChange={(_, next: number) => setTab(next)} variant="scrollable">
${used.map((name) => `        <Tab label="${name}" />`).join("\n")}
      </Tabs>`
    : `      <div className="flex gap-2">
${used.map((name, n) => `        <button type="button" className="rounded px-2 py-1 text-sm" onClick={() => setTab(${n})}>${name}</button>`).join("\n")}
      </div>`;
  return `import { useState } from "react";
${counts.ui ? 'import { Tab, Tabs } from "@mui/material";\n' : ""}${used.map((name) => `import { ${name} } from "../components/${name}";`).join("\n")}

/** Page ${i}, with a tab for each of its parts. */
export function ${pageName(i)}() {
  const [tab, setTab] = useState(0);
  return (
    <div className="flex flex-col gap-6">
${tabs}
${used.map((name, n) => `      {tab === ${n} ? <${name} /> : null}`).join("\n")}
    </div>
  );
}
`;
}

function route(i) {
  return `import { Hono } from "hono";
import { collection } from "../store";
import type { Booking, Summary } from "../../shared/records";

const rooms = ["Hall", "Studio", "Garden room", "Kitchen"];

/** Bookings for area ${i}, kept in the app's store. */
export const route${pad(i)} = new Hono<{ Bindings: Env }>()
  .get("/api/summary/${i}", async (c) => {
    const bookings = await collection<Booking>(c.env.STORE, "area-${i}").list();
    const byRoom = new Map<string, number>();
    for (const booking of bookings) byRoom.set(booking.room, (byRoom.get(booking.room) ?? 0) + 1);
    const busiestRoom = [...byRoom].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rooms[${i % 4}]!;
    const summary: Summary = {
      bookings: bookings.length,
      people: bookings.reduce((sum, booking) => sum + booking.people, 0),
      busiestRoom,
      updatedAt: new Date().toISOString(),
    };
    return c.json(summary);
  })
  .post("/api/bookings/${i}", async (c) => {
    const body = await c.req.json<Partial<Booking>>().catch(() => ({}) as Partial<Booking>);
    if (typeof body.name !== "string" || body.name.trim().length < 2) return c.json({ error: "Give a name." }, 400);
    if (typeof body.people !== "number" || body.people < 1) return c.json({ error: "Say how many people." }, 400);
    const booking: Booking = { name: body.name.trim(), room: body.room ?? rooms[0]!, people: body.people, at: new Date().toISOString() };
    return c.json(await collection<Booking>(c.env.STORE, "area-${i}").add(booking), 201);
  });
`;
}

function shared() {
  return `/** A point on a chart. */
export interface Point {
  at: string;
  value: number;
}

/** A booking of a room. */
export interface Booking {
  name: string;
  room: string;
  people: number;
  at: string;
}

/** What \`GET /api/summary/:area\` returns. */
export interface Summary {
  bookings: number;
  people: number;
  busiestRoom: string;
  updatedAt: string;
}
`;
}

function app() {
  const pages = Array.from({ length: counts.pages }, (_, i) => pageName(i));
  const [open, close] = counts.ui ? ["<ThemeProvider theme={theme}>\n      <CssBaseline />", "</ThemeProvider>"] : ["<>", "</>"];
  return `import { useState } from "react";
${counts.ui ? 'import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";\n' : ""}${pages.map((name) => `import { ${name} } from "./pages/${name}";`).join("\n")}

${counts.ui ? 'const theme = createTheme({ palette: { primary: { main: "#0284c7" } } });\n' : ""}const pages = { ${pages.join(", ")} };

export function App() {
  const [shown, setShown] = useState<keyof typeof pages>("${pages[0]}");
  const Shown = pages[shown];
  return (
    ${open}
      <div className="flex min-h-screen">
        <nav className="flex w-48 flex-col gap-1 border-r border-slate-200 p-3">
          {Object.keys(pages).map((name) => (
            <button
              key={name}
              type="button"
              className={name === shown ? "rounded px-2 py-1 text-left font-semibold text-sky-700" : "rounded px-2 py-1 text-left text-slate-600"}
              onClick={() => setShown(name as keyof typeof pages)}
            >
              {name}
            </button>
          ))}
        </nav>
        <main className="flex-1 p-6">
          <Shown />
        </main>
      </div>
    ${close}
  );
}
`;
}

function server() {
  const routes = Array.from({ length: counts.routes }, (_, i) => `route${pad(i)}`);
  return `import { Hono } from "hono";
import type { Hello } from "../shared/api";
${routes.map((name) => `import { ${name} } from "./routes/${name}";`).join("\n")}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/hello/:name", (c) => {
  const hello: Hello = { message: \`\${c.env.GREETING}, \${c.req.param("name")}\` };
  return c.json(hello);
});
${routes.map((name) => `app.route("/", ${name});`).join("\n")}

export default app;

// The app's storage (see "Storage" in AGENTS.md).
export { Store } from "./store";
`;
}

// The API, from the page or from Node.

/** Each step as it finishes, for a caller polling from outside the page. */
export const progress = [];

function api(origin) {
  const call = async (method, path, body, type = "application/json") => {
    const started = performance.now();
    const response = await fetch(`${origin}/api${path}`, {
      method,
      // Node doesn't send Origin itself; a browser ignores this and sends its own.
      headers: { origin, ...(body === undefined ? {} : { "content-type": type }) },
      body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
    });
    const ms = Math.round(performance.now() - started);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return { ms, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
  // A save that lands while the Workspace's isolate is being reset fails with
  // a 500, so a save is tried three times.
  const put = async (id, path, text, tries = 3) => {
    try {
      return await call("PUT", `/workspaces/${id}/files/${path}`, text, "text/plain; charset=utf-8");
    } catch (error) {
      if (tries <= 1 || !/: 5\d\d /.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return put(id, path, text, tries - 1);
    }
  };
  return { call, put };
}

const note = (step) => {
  progress.push(step);
  console.log(JSON.stringify(step));
  return step;
};

/** Makes the Workspace from the Worker + React Template, adds the Packages, and writes the app's files. */
export async function make(origin, shape = "large", name = `Load test (#87, ${shape})`) {
  use(shape);
  const { call, put } = api(origin);
  const { body: created } = await call("POST", "/workspaces", { name, template: "worker-react" });
  const id = created.workspace.id;
  note({ step: "created", id });
  const { body: template } = await call("GET", `/workspaces/${id}/files/package.json`);
  const installed = await put(id, "package.json", packageJson(template));
  const { body: status } = await call("GET", `/workspaces/${id}/packages`);
  note({ step: "packages", ms: installed.ms, state: status.state, count: status.packages.length, warnings: status.warnings, error: status.error });
  return write(origin, id, shape);
}

/** Writes the app's files into the Workspace, a few at a time, as an editor's saves would come. Each save also schedules a Build. */
export async function write(origin, id, shape = "large") {
  use(shape);
  const { put } = api(origin);
  const files = largeAppFiles();
  const paths = Object.keys(files);
  for (let i = 0; i < paths.length; i += 6) {
    await Promise.all(paths.slice(i, i + 6).map((path) => put(id, path, files[path])));
  }
  note({ step: "files", written: paths.length });
  return note({ step: "made", id, ...(await stats(origin, id)) });
}

/** The Workspace's file count and size, and its Packages. */
export async function stats(origin, id) {
  const { call } = api(origin);
  const { body } = await call("GET", `/workspaces/${id}/files`);
  const paths = body.files;
  let bytes = 0;
  for (const path of paths) {
    const { body: text } = await call("GET", `/workspaces/${id}/files/${path}`).catch(() => ({ body: "" }));
    bytes += new TextEncoder().encode(typeof text === "string" ? text : JSON.stringify(text)).byteLength;
  }
  const { body: packages } = await call("GET", `/workspaces/${id}/packages`);
  return { files: paths.length, bytes, packages: packages.packages.length, packagesState: packages.state };
}

/**
 * Ten rounds of what a Developer's edit causes on the page: a save, then a
 * Check and a Build (client/src/useChecks.ts). The Workspace also builds a
 * second after the save, for the Preview; whichever Build comes second is
 * cached. Each round edits a different component, so each makes a new Build.
 */
export async function builds(origin, id, shape = "large", rounds = 10) {
  use(shape);
  const { call, put } = api(origin);
  const results = [];
  // Each run's edits differ from the last's, so every round's save changes the files.
  const stamp = new Date().toISOString();
  for (let round = 1; round <= rounds; round++) {
    const i = round % counts.components;
    const path = `src/client/components/${componentName(i)}.tsx`;
    const saved = await put(id, path, component(i, round, stamp)).catch((error) => ({ ms: null, error: String(error) }));
    const check = await call("POST", `/workspaces/${id}/check`).catch((error) => ({ ms: null, body: { error: String(error) } }));
    const build = await call("POST", `/workspaces/${id}/build`).catch((error) => ({ ms: null, body: { error: String(error) } }));
    // Lets the Build after the save run, if it hasn't, before the next round.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const { body: latest } = await call("GET", `/workspaces/${id}/build`).catch(() => ({ body: null }));
    results.push(
      note({
        step: "round",
        round,
        path,
        saveMs: saved.ms,
        saveError: saved.error,
        checkMs: check.ms,
        checkErrors: check.body.counts?.error ?? check.body.error,
        buildMs: build.ms,
        buildOk: build.body.ok ?? build.body.error,
        buildCached: build.body.cached,
        buildErrors: build.body.errors?.slice(0, 3),
        hash: build.body.hash,
        latestHash: latest?.hash,
        latestCached: latest?.cached,
      }),
    );
  }
  return results;
}

/**
 * A Turn with the scripted model (`pnpm agent:fake`, docs/development.md), so
 * its end-of-Turn Check and Build run after the Agent's own. Only locally: the
 * deployed platform has the real model. `break-then-fix` writes a file, so the
 * Turn's Build is a new one.
 */
export async function turn(origin, id, script = "break-then-fix") {
  const { call } = api(origin);
  const startedAt = new Date().toISOString();
  const started = await call("POST", `/workspaces/${id}/turns`, { message: `[script:${script}] A load test's Turn (#87).` });
  // A Turn ends with every test file, run after its last Check and Build.
  for (let tries = 0; tries < 120; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if ((await call("GET", `/workspaces/${id}/tests`)).body?.ranAt > startedAt) break;
  }
  const { body: latest } = await call("GET", `/workspaces/${id}/build`);
  return note({ step: "turn", script, startMs: started.ms, buildOk: latest?.ok, buildCached: latest?.cached, hash: latest?.hash });
}

export async function remove(origin, id) {
  const { call } = api(origin);
  const { body } = await call("GET", "/workspaces");
  const confirmName = body.workspaces.find((workspace) => workspace.id === id)?.name;
  await call("DELETE", `/workspaces/${id}`, { confirmName });
  return note({ step: "deleted", id });
}

// Run from Node: node scripts/large-workspace.mjs <origin> make|write|builds|turn|stats|delete [id]
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
  const [origin, command, ...rest] = process.argv.slice(2);
  const [id, shape = "large"] = command === "make" ? [undefined, ...rest] : rest;
  const run = {
    make: () => make(origin, shape),
    write: () => write(origin, id, shape),
    turn: () => turn(origin, id),
    builds: () => builds(origin, id, shape),
    delete: () => remove(origin, id),
    stats: () => stats(origin, id),
  }[command];
  if (!origin || !run) {
    console.error("usage: node scripts/large-workspace.mjs <origin> make [shape]|write|builds|turn|stats|delete [workspace id] [shape]");
    process.exit(2);
  }
  await run();
}
