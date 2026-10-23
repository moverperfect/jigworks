// The scripted model, for trying the Conversation under `wrangler dev`: the
// Anthropic Messages API on 127.0.0.1:8788, answering from the tests' scripts.
// A Conversation's first message picks one as `[script:<name>]` (see
// test/fixtures/agent-scripts.ts). Point the platform at it in .dev.vars:
//
//   AGENT_BASE_URL=http://127.0.0.1:8788/v1
//   ANTHROPIC_API_KEY=local-fake-key
//
// Node strips the fixtures' TypeScript types itself.
import { createServer } from "node:http";
import { agentScripts } from "../test/fixtures/agent-scripts.ts";
import { fakeAnthropic } from "../test/fixtures/fake-anthropic.ts";

const origin = "http://127.0.0.1:8788";
const answer = fakeAnthropic(agentScripts, { api: origin, apiKey: "local-fake-key" });

const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const request = new Request(new URL(incoming.url ?? "/", origin), { method: incoming.method, headers, body });

    const response = (await answer(request)) ?? new Response("Not found", { status: 404 });
    console.log(`${incoming.method} ${incoming.url} ${response.status}`);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    // Passed on as it comes, since a script can pause mid-reply.
    if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { "content-type": "text/plain" });
    outgoing.end(String(error));
  }
});

server.listen(8788, "127.0.0.1", () => console.log(`The scripted model is at ${origin}/v1`));
