import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestReport } from "../src/shared/test-report";
import type { Addon } from "../src/templates";
import { describeAddons } from "../src/agent";
import type { Workspace } from "../src/workspace";
import { summaryReply } from "./fixtures/fake-anthropic";
import { resendAccountAddress, resendKey } from "./fixtures/fake-resend";
import { call, create } from "./helpers/api";
import { connect, history, runTurn, toolResults, turnLines } from "./helpers/conversation";

// The Agent adds an add-on with add_addon (ADR 0019). The model is the
// scripted one in test/fixtures/agent-scripts.ts.

const fileList = async (id: string) => (await (await call(`/api/workspaces/${id}/files`)).json<{ files: string[] }>()).files;
const fileText = async (id: string, path: string) => (await call(`/api/workspaces/${id}/files/${path}`)).text();
const storageFiles = ["src/server/fake-store.ts", "src/server/store.test.ts", "src/server/store.ts"];
const storageHeading = "## Storage (add-on `storage`)";

describe("add_addon", () => {
  it("adds storage to a Worker Template app: its files, its notes in AGENTS.md, and the edits, Secrets and tests that follow", async () => {
    const workspace = await create("Webhook");
    const agentsMd = await fileText(workspace.id, "AGENTS.md");
    const conversation = await connect(workspace.id);
    const [line] = await turnLines(() => runTurn(workspace.id, conversation, "[script:add-storage] Remember the messages"));
    // An add-on arrives working, before the Agent joins it to the app.
    expect(line).toMatchObject({ addons: ["storage"], checkErrors: 0, buildErrors: 0, testFailures: 0 });

    expect(await fileList(workspace.id)).toEqual(expect.arrayContaining(storageFiles));
    const notes = (await fileText(workspace.id, "AGENTS.md")).slice(agentsMd.trimEnd().length);
    expect(notes).toMatch(/^\n\n## Storage \(add-on `storage`\)\n\nThe app keeps its records in `STORE`/);

    const [added] = await toolResults(workspace.id);
    expect(added!.tool).toBe("add_addon");
    const result = added!.result as string;
    expect(result).toContain("Added the storage add-on. Wrote /src/server/fake-store.ts, /src/server/store.test.ts and /src/server/store.ts.");
    // The Turn's instructions predate the notes, so the tool gives them.
    expect(result).toContain(`<notes>\n${notes.trim()}\n</notes>`);
    expect(result).toContain("make these edits in the files as they stand:\n- In wrangler.jsonc, add the binding");
    expect(result).toContain("run its tests with the test tool: /src/server/store.test.ts.");
    // Storage needs no Secrets.
    expect(result).not.toContain("ask_for_secret");
  });

  it("joined to the app with its edits, has a clean Check, Builds, passes its tests and keeps records in the Preview", async () => {
    const workspace = await create("Messages");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:add-storage-and-join] Remember the messages");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 0, buildErrors: 0, testFailures: 0, retries: 0, restored: false });

    const tests = await (await call(`/api/workspaces/${workspace.id}/tests`)).json<TestReport>();
    expect(tests.files.map(({ file, tests, errors }) => [file, [...new Set(tests.map(({ state }) => state))], errors])).toEqual([
      ["src/index.test.ts", ["passed"], []],
      ["src/server/store.test.ts", ["passed"], []],
    ]);

    const preview = env.WORKSPACES.getByName(workspace.id);
    expect((await preview.requestPreview({ method: "POST", path: "/api/messages/Hello" })).status).toBe(200);
    const listed = await preview.requestPreview({ method: "GET", path: "/api/messages" });
    expect(JSON.parse(listed.body)).toEqual([{ id: expect.any(String), text: "Hello" }]);
  });

  it("adds an add-on in a later Turn, and logs which each Turn added", async () => {
    const workspace = await create("Later");
    const conversation = await connect(workspace.id);
    const [first] = await turnLines(() => runTurn(workspace.id, conversation, "[script:add-storage-later] Hi"));
    expect(first).toMatchObject({ addons: [] });
    expect(await fileList(workspace.id)).not.toContain("src/server/store.ts");

    const [second] = await turnLines(() => runTurn(workspace.id, conversation, "Remember the messages"));
    expect(second).toMatchObject({ addons: ["storage"], checkErrors: 0 });
    expect(await fileList(workspace.id)).toEqual(expect.arrayContaining(storageFiles));
  });

  it("refuses an add-on the app already has, going by AGENTS.md's headings", async () => {
    // The default Template is built from storage.
    const workspace = await create("Sign-ups", undefined, "worker-react");
    const agentsMd = await fileText(workspace.id, "AGENTS.md");
    const conversation = await connect(workspace.id);
    const [line] = await turnLines(() => runTurn(workspace.id, conversation, "[script:add-storage] Remember the names"));
    expect(line).toMatchObject({ addons: [] });
    expect(await toolResults(workspace.id)).toEqual([
      { tool: "add_addon", result: `Couldn't add the storage add-on. The app already has it: AGENTS.md has its heading, ${storageHeading}.` },
    ]);
    expect(await fileText(workspace.id, "AGENTS.md")).toBe(agentsMd);
  });

  it("refuses an add-on there's no such thing as", async () => {
    const workspace = await create("Unknown");
    const added = await env.WORKSPACES.getByName(workspace.id).addAddonForAgent("teleporter");
    expect(added).toEqual({ ok: false, error: "There's no add-on called teleporter." });
  });

  it("refuses a file that would be overwritten with different contents, naming it, and writes nothing", async () => {
    const workspace = await create("Mine");
    const agentsMd = await fileText(workspace.id, "AGENTS.md");
    const save = await call(`/api/workspaces/${workspace.id}/files/src/server/store.ts`, { method: "PUT", text: "export const mine = 1;\n" });
    expect(save.status).toBe(204);

    await runTurn(workspace.id, await connect(workspace.id), "[script:add-storage] Remember the messages");
    expect(await toolResults(workspace.id)).toEqual([
      {
        tool: "add_addon",
        result: "Couldn't add the storage add-on. It would overwrite /src/server/store.ts, which has different contents. Nothing was added.",
      },
    ]);
    expect(await fileText(workspace.id, "src/server/store.ts")).toBe("export const mine = 1;\n");
    expect(await fileList(workspace.id)).not.toContain("src/server/fake-store.ts");
    expect(await fileText(workspace.id, "AGENTS.md")).toBe(agentsMd);
  });
});

describe("the organiser's area", () => {
  it("joined to the default Template's app with its edits, passes its tests, asks for its passcode, and lets only the organiser in", async () => {
    const workspace = await create("Rota", undefined, "worker-react");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:add-organiser-and-join] Only I should change the rota");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 0, buildErrors: 0, testFailures: 0, retries: 0, restored: false });

    const [added] = await toolResults(workspace.id);
    const result = added!.result as string;
    // Storage came with the Template.
    expect(result).toMatch(/^Added the organiser add-on\. Wrote \/src\/server\/organiser\.test\.ts and \/src\/server\/organiser\.ts\.\nIt needs storage too, which the app already had\./);
    expect(result).toContain("- ORGANISER_PASSCODE: The passcode that opens your app's organiser's area.");
    const tests = await (await call(`/api/workspaces/${workspace.id}/tests`)).json<TestReport>();
    expect(tests.files.map(({ file, tests, errors }) => [file, [...new Set(tests.map(({ state }) => state))], errors])).toContainEqual([
      "src/server/organiser.test.ts",
      ["passed"],
      [],
    ]);

    // The Developer gives the passcode when the Agent asks.
    const passcode = "a rota passcode";
    expect((await call(`/api/workspaces/${workspace.id}/secrets/ORGANISER_PASSCODE`, { method: "PUT", body: { value: passcode } })).status).toBe(204);
    const preview = env.WORKSPACES.getByName(workspace.id);
    // The Worker answers the sign-in page, not the front end.
    const page = await preview.requestPreview({ method: "GET", path: "/organiser/sign-in", headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" } });
    expect(page.body).toContain('<form method="post" action="/organiser/sign-in">');
    const signIn = (entered: string) =>
      preview.requestPreview({
        method: "POST",
        path: "/organiser/sign-in",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ passcode: entered }).toString(),
      });
    expect((await signIn("a wrong passcode")).status).toBe(401);
    const signedIn = await signIn(passcode);
    // Not followed, so the Agent sees the cookie too.
    expect(signedIn).toMatchObject({ status: 303, headers: { location: "/organiser" } });
    const cookie = signedIn.headers["set-cookie"]!.split(";", 1)[0]!;
    expect(cookie).toMatch(/^__Host-organiser=/);

    const signups = (headers: Record<string, string> = {}) => preview.requestPreview({ method: "GET", path: "/organiser/api/signups", headers });
    expect((await signups()).status).toBe(401);
    const allowed = await signups({ Cookie: cookie });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body)).toEqual(["Ada", "Grace"]);
  });

  it("joined to a Worker Template app with storage's edits and its own, passes every test, and sends a stranger to sign in", async () => {
    const workspace = await create("Rota webhook");
    const ended = await runTurn(workspace.id, await connect(workspace.id), "[script:add-organiser-to-worker-and-join] Only I should see this");
    expect(ended).toMatchObject({ status: "completed", checkErrors: 0, buildErrors: 0, testFailures: 0, retries: 0 });
    const [added] = await toolResults(workspace.id);
    expect((added!.result as string).split("\n", 1)[0]).toBe(
      "Added the organiser add-on, after storage, which it needs. Wrote /src/server/fake-store.ts, /src/server/store.test.ts, /src/server/store.ts, /src/server/organiser.test.ts and /src/server/organiser.ts.",
    );
    const tests = await (await call(`/api/workspaces/${workspace.id}/tests`)).json<TestReport>();
    expect(tests.files.map(({ file, tests }) => [file, [...new Set(tests.map(({ state }) => state))]])).toEqual([
      ["src/index.test.ts", ["passed"]],
      ["src/server/organiser.test.ts", ["passed"]],
      ["src/server/store.test.ts", ["passed"]],
    ]);

    const opened = await env.WORKSPACES.getByName(workspace.id).requestPreview({ method: "GET", path: "/organiser", headers: { Accept: "text/html" } });
    expect(opened).toMatchObject({ status: 303, headers: { location: "/organiser/sign-in?next=%2Forganiser" } });
  });
});

describe("sending email", () => {
  it("joined to the default Template's app with its edits, passes its tests, asks for Resend's key, and sends from the Preview", async () => {
    const workspace = await create("Sign-ups", undefined, "worker-react");
    const conversation = await connect(workspace.id);
    const [line] = await turnLines(() => runTurn(workspace.id, conversation, "[script:add-email-and-join] Email me when someone signs up"));
    expect(line).toMatchObject({ addons: ["email"], status: "completed", checkErrors: 0, buildErrors: 0, testFailures: 0, retries: 0, restored: false });

    const [added] = await toolResults(workspace.id);
    const result = added!.result as string;
    expect(result.split("\n", 1)[0]).toBe("Added the email add-on. Wrote /src/server/email.test.ts and /src/server/email.ts.");
    expect(result).toContain("<notes>\n## Sending email (add-on `email`)\n\nThe app sends email through Resend");
    expect(result).toContain("- RESEND_API_KEY: To send emails, your app uses Resend, an email service, and needs a key from it.");
    const tests = await (await call(`/api/workspaces/${workspace.id}/tests`)).json<TestReport>();
    expect(tests.files.map(({ file, tests, errors }) => [file, [...new Set(tests.map(({ state }) => state))], errors])).toContainEqual([
      "src/server/email.test.ts",
      ["passed"],
      [],
    ]);

    const preview = env.WORKSPACES.getByName(workspace.id);
    const signUp = async (query = "") => JSON.parse((await preview.requestPreview({ method: "POST", path: `/api/signups/Ada${query}` })).body);
    // Before the Developer gives the key, nothing is sent, and the app says why.
    expect(await signUp()).toEqual({ ok: false, error: "The email wasn't sent: the Secret RESEND_API_KEY hasn't been set yet." });

    expect((await call(`/api/workspaces/${workspace.id}/secrets/RESEND_API_KEY`, { method: "PUT", body: { value: resendKey } })).status).toBe(204);
    expect(await signUp()).toEqual({ ok: true, id: `email-to-${resendAccountAddress}` });
    // Resend's test sender reaches only the account's own address, and the app hears why.
    expect(await signUp("?to=ada%40example.com")).toEqual({
      ok: false,
      error: expect.stringMatching(/^Resend refused the email: You can only send testing emails to your own email address/),
    });
  });
});

describe("calling an AI model", () => {
  it("joined to the default Template's app with its edits, passes its tests, asks for Anthropic's key, and asks Claude from the Preview", async () => {
    const workspace = await create("Feedback", undefined, "worker-react");
    const conversation = await connect(workspace.id);
    const [line] = await turnLines(() => runTurn(workspace.id, conversation, "[script:add-ai-and-join] Sort the messages people send"));
    expect(line).toMatchObject({ addons: ["ai"], status: "completed", checkErrors: 0, buildErrors: 0, testFailures: 0, retries: 0, restored: false });

    const [added] = await toolResults(workspace.id);
    const result = added!.result as string;
    expect(result.split("\n", 1)[0]).toBe("Added the ai add-on. Wrote /src/server/ai.test.ts and /src/server/ai.ts.");
    expect(result).toContain("<notes>\n## Calling an AI model (add-on `ai`)\n\nThe app asks Claude");
    expect(result).toContain("- ANTHROPIC_API_KEY: Your app asks Claude, an AI model from Anthropic, with a key from your own Anthropic account, so what it uses is charged to you");
    const tests = await (await call(`/api/workspaces/${workspace.id}/tests`)).json<TestReport>();
    expect(tests.files.map(({ file, tests, errors }) => [file, [...new Set(tests.map(({ state }) => state))], errors])).toContainEqual([
      "src/server/ai.test.ts",
      ["passed"],
      [],
    ]);

    const preview = env.WORKSPACES.getByName(workspace.id);
    const sort = async () => JSON.parse((await preview.requestPreview({ method: "POST", path: "/api/messages/The%20coffee%20was%20cold" })).body);
    // Before the Developer gives the key, Claude isn't asked, and the app says why.
    expect(await sort()).toEqual({ ok: false, error: "Claude wasn't asked: the Secret ANTHROPIC_API_KEY hasn't been set yet." });

    const giveKey = (value: string) => call(`/api/workspaces/${workspace.id}/secrets/ANTHROPIC_API_KEY`, { method: "PUT", body: { value } });
    expect((await giveKey("a key Anthropic doesn't know")).status).toBe(204);
    expect(await sort()).toEqual({ ok: false, error: "Claude wasn't asked: Anthropic answered 401 (authentication_error): invalid x-api-key" });
    // The fake Anthropic knows the platform's own key, and answers a request without tools with its summary.
    expect((await giveKey(env.ANTHROPIC_API_KEY)).status).toBe(204);
    expect(await sort()).toEqual({ ok: true, text: summaryReply });
  });
});

/** An add-on for the tests below, which no real add-on yet is: with needs, Packages and Secrets. */
function addon(id: string, fields: Partial<Addon> = {}): Addon {
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  return {
    id,
    name,
    description: `A ${id}.`,
    fits: `Add it for ${id}s.`,
    needs: [],
    packages: {},
    secrets: [],
    edits: [],
    notes: `## ${name} (add-on \`${id}\`)\n\nUse the ${id}.\n`,
    files: { [`src/server/${id}.ts`]: `export const ${id} = 1;\n` },
    ...fields,
  };
}

/** The Workspace's own step for add_addon: the add-on and those it needs, needs first, as `addonWithNeeds` gives them. */
type AddingAddons = { addAddons(chain: Addon[]): ReturnType<Workspace["addAddonForAgent"]> };

describe("an add-on that needs others", () => {
  const thing = addon("thing");
  const organiser = addon("organiser", {
    needs: ["thing"],
    packages: { "@fake/a": "1.0.0" },
    secrets: [{ name: "ORGANISER_PASSCODE", reason: "To keep people out of the organiser's area." }],
    edits: ["Route /organiser to the organiser's area."],
    files: { "src/server/organiser.ts": "export const organiser = 1;\n", "src/server/organiser.test.ts": "// tests\n" },
  });

  it("adds those the app hasn't got first, installs its Packages, and returns every edit and Secret", async () => {
    const workspace = await create("Organiser");
    const agentsMd = await fileText(workspace.id, "AGENTS.md");
    // A file that's already the same isn't written again, but its tests still need running.
    const same = await call(`/api/workspaces/${workspace.id}/files/src/server/organiser.test.ts`, { method: "PUT", text: "// tests\n" });
    expect(same.status).toBe(204);
    const added = await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (instance) =>
      (instance as unknown as AddingAddons).addAddons([thing, organiser]),
    );
    expect(added).toMatchObject({
      ok: true,
      added: [thing, organiser],
      had: [],
      written: ["src/server/thing.ts", "src/server/organiser.ts"],
      tests: ["src/server/organiser.test.ts"],
      status: { state: "installed" },
    });
    expect(await fileText(workspace.id, "AGENTS.md")).toBe(`${agentsMd.trimEnd()}\n\n${thing.notes}\n${organiser.notes}`);
    expect(JSON.parse(await fileText(workspace.id, "package.json")).dependencies).toMatchObject({ "@fake/a": "1.0.0" });
    const status = await (await call(`/api/workspaces/${workspace.id}/packages`)).json<{ packages: { name: string; version: string }[] }>();
    expect(status.packages).toContainEqual({ name: "@fake/a", version: "1.0.0" });
  });

  it("skips a needed add-on the app already has", async () => {
    const workspace = await create("Has the thing");
    const stub = env.WORKSPACES.getByName(workspace.id);
    await runInDurableObject(stub, (instance) => (instance as unknown as AddingAddons).addAddons([thing]));
    const added = await runInDurableObject(stub, (instance) => (instance as unknown as AddingAddons).addAddons([thing, organiser]));
    expect(added).toMatchObject({ ok: true, added: [organiser], had: [thing] });
    expect((await fileText(workspace.id, "AGENTS.md")).split(thing.notes.split("\n")[0]!)).toHaveLength(2);
  });

  it("writes nothing when one of its Packages can't be added", async () => {
    const workspace = await create("Missing Package");
    const before = { files: await fileList(workspace.id), packageJson: await fileText(workspace.id, "package.json") };
    const broken = addon("broken", { needs: ["thing"], packages: { "@fake/missing": "1.0.0" } });
    const added = await runInDurableObject(env.WORKSPACES.getByName(workspace.id), (instance) =>
      (instance as unknown as AddingAddons).addAddons([thing, broken]),
    );
    expect(added).toMatchObject({ ok: false, error: expect.stringMatching(/^Couldn't add the Package @fake\/missing: .+ Nothing was added\.$/) });
    expect({ files: await fileList(workspace.id), packageJson: await fileText(workspace.id, "package.json") }).toEqual(before);
  });
});

describe("what add_addon tells the Agent", () => {
  it("names the add-ons it needed and the Packages it added, then the edits, the tests, and only the Secrets not yet given", () => {
    const thing = addon("thing");
    const organiser = addon("organiser", {
      needs: ["thing"],
      packages: { "@fake/a": "1.0.0" },
      secrets: [
        { name: "ORGANISER_PASSCODE", reason: "To keep people out of the organiser's area." },
        { name: "GIVEN_ALREADY", reason: "Not asked for again." },
      ],
      edits: ["Route /organiser to the organiser's area."],
    });
    const status = { state: "installed" as const, packages: [], warnings: [], error: null };
    const told = describeAddons(
      { ok: true, added: [organiser], had: [thing], written: ["src/server/organiser.ts", "src/server/organiser.test.ts"], tests: ["src/server/organiser.test.ts"], status },
      new Set(["GIVEN_ALREADY"]),
    );
    expect(told).toBe(
      [
        "Added the organiser add-on. Wrote /src/server/organiser.ts and /src/server/organiser.test.ts.",
        "It needs thing too, which the app already had.",
        "Added the Packages @fake/a 1.0.0.",
        "",
        "Its notes, now in /AGENTS.md:",
        "",
        "<notes>",
        "## Organiser (add-on `organiser`)\n\nUse the organiser.",
        "</notes>",
        "",
        "To join it to the app, make these edits in the files as they stand:",
        "- Route /organiser to the organiser's area.",
        "",
        "Then run its tests with the test tool: /src/server/organiser.test.ts.",
        "",
        "It needs secrets the Developer hasn't given. Once the app works, ask for each with ask_for_secret, giving this reason:",
        "- ORGANISER_PASSCODE: To keep people out of the organiser's area.",
      ].join("\n"),
    );

    // With the add-on it needs added first.
    const both = describeAddons({ ok: true, added: [thing, organiser], had: [], written: [], tests: [], status: null }, new Set());
    expect(both.split("\n", 1)[0]).toBe("Added the organiser add-on, after thing, which it needs.");
  });
});
