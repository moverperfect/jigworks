# Jigworks

A browser-based development environment where a Developer and an AI Agent build Cloudflare Workers and web front ends together, from writing the code to hosting it, with no local machine involved.

## Language

**Installation**:
One copy of Jigworks running on an organisation's Cloudflare account.
_Avoid_: Instance, deployment, tenant

**Operator**:
The person who sets up and runs an Installation: its Access applications, domains, Developer list and Anthropic key.
_Avoid_: Admin, owner

**Developer**:
A signed-in person on the Installation's Developer list, who works in Workspaces by talking with the Agent in the Conversation and editing files.
_Avoid_: User, engineer

**Agent**:
The AI that reads and changes a Workspace's files on a Developer's behalf.
_Avoid_: Assistant, bot, AI

**Workspace**:
A set of files owned by one Developer, together with the one Conversation about them.
_Avoid_: Project, repo, filesystem, sandbox

**Conversation**:
The chat between a Developer and the Agent about a Workspace's files. Each Workspace has exactly one.
_Avoid_: Chat, thread, session

**Turn**:
One run of the Agent in response to a Developer's message. While a Turn is running, only the Agent may change the Workspace's files, and a Workspace has at most one Turn running at a time.
_Avoid_: Run, job, step

**Check**:
A type-check of a Workspace's files that produces the list of errors the Agent and the Developer see. The Agent can ask for one at any time, and one always runs before a Turn ends.
_Avoid_: Typecheck, lint, compile

**Build**:
The runnable form of a Workspace's code, made from its files as they were at one moment. A Build can be made while the Check still shows errors.
_Avoid_: Bundle, artifact, compile

**Test**:
Code in a Workspace file named like `src/index.test.ts` that runs the app's code and says whether it behaves, written with vitest's API. The platform runs a Workspace's tests with its own vitest (ADR 0017), when the Agent or the Developer asks and at the end of every Turn. Failing tests show in the problems list, but don't make the Agent retry.
_Avoid_: Spec, test suite

**Front end**:
The part of a Workspace's app that runs in the browser: `index.html` and the scripts and stylesheets it links (ADR 0014). A Workspace without `index.html` has none.
_Avoid_: Client, SPA, frontend

**Preview**:
The Workspace's latest Build, running at a URL that only its Developer can open. Its data is kept separate from the Deployment's.
_Avoid_: Dev server, staging, sandbox

**Deployment**:
A Build that the Developer has published at the Workspace's hosted URL, for anyone the apps' Access application lets in. It stays the same until the Developer publishes another.
_Avoid_: Release, production, live site

**Apps domain**:
The registered domain an Installation's Previews and Deployments live on, apart from the platform's own hostname.
_Avoid_: App domain, user-content domain

**Package**:
Published code from npm that a Workspace uses, listed in its `package.json` with an exact version. Packages aren't Workspace files: nobody edits them, and they don't appear in the file tree or the zip. A Workspace has only one version of each Package, even when two Packages ask for different ones.
_Avoid_: Dependency, library, module

**Secret**:
A named value, such as an API key, that the Developer gives a Workspace and its app reads from `env`, in the Preview and the Deployment. The Agent sees only its name (ADR 0016).
_Avoid_: Environment variable, var, credential

**Template**:
A starting set of files for a new Workspace.
_Avoid_: Starter, scaffold, boilerplate
