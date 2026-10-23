# The platform runs each Turn, and the Conversation socket only watches

Think expects a page to start a Turn by sending a chat request over its socket, and to watch the reply on the same socket. A Turn here is more than Think's turn. It locks the Developer's edits, runs a Check and then a Build when the model stops, and gives the Agent up to 3 more tries while either has errors. Think can't run that loop from its own end-of-turn hook: in 0.20.2 `onChatResponse` still runs inside the turn, and starting another turn from it throws or deadlocks.

So the Workspace runs each Turn itself. The page starts one with `POST /api/workspaces/:id/turns`. The Workspace sets the lock in its state and schedules the Turn in an alarm of its own, which drives Think with `saveMessages`: the Developer's message, a Check and a Build, and any retries, each retry a Think turn of its own. The Build goes ahead whatever the Check found, and errors from either use up the same retries. Every model step across the Turn counts towards one limit of 40. The Conversation socket only follows the Turn. The Workspace drops every frame a socket sends except the handshake for joining a reply that's already streaming, so a socket can't start a Turn, clear the Conversation or change the lock.

## Consequences

- The Turn lock, the Check, the Build and the retries all live in one method, `runDeveloperTurn`, rather than being spread across Think's hooks.
- The Turn's Builds, and the Agent's, go through the Workspace's own stub, so each is a call of its own with its own CPU and wall time in Cloudflare's trace. The work after such a call runs inside it and is counted in its trace too, which matters for the Agent's Builds, though not for the one that ends a Turn.
- A Turn runs in an alarm because its logs are reported only when the invocation running it ends. Run in the background of the call that started it, a Turn's logs never reached Workers Logs. An alarm handler can run for at most 15 minutes, which caps a Turn's length.
- The page can't use `useAgentChat`'s `sendMessage` or `clearHistory`. It renders the Turns the server streams, which `useAgentChat` supports.
- A Turn can't outlive the isolate running it. If the Workspace's object restarts mid-Turn, Think keeps what the reply had streamed but doesn't carry it on (`onChatRecovery` returns `continue: false`), and the new isolate records the Turn as stopped. Carrying a Turn on would mean persisting the loop's progress and resuming the Check and retries, which a deploy mid-Turn doesn't justify yet.
- Start fresh also goes through the JSON API, and is refused while a Turn runs.
- Filtering the socket's frames means overriding the Durable Object's `webSocketMessage` and passing allowed frames to the Agents SDK's lifecycle. That depends on SDK internals: the SDK installs its own handler only when the class has none. `test/conversation.test.ts` checks that the socket stays watch-only.
