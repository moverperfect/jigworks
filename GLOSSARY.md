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
A signed-in person on the Installation's Developer list, who builds apps by talking with the Agent in the Conversation, whether or not they write code. Any Developer can also edit a Workspace's files.
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

**Package cache**:
The one R2 bucket of npm's tarballs that every Workspace on an Installation shares, behind each Workspace's own copy of its Packages (ADR 0020). It saves a download, and never decides which version a Workspace gets.
_Avoid_: Registry mirror, package store, CDN

**Secret**:
A named value, such as an API key, that the Developer gives a Workspace and its app reads from `env`, in the Preview and the Deployment. The Agent sees only its name (ADR 0016).
_Avoid_: Environment variable, var, credential

**Template**:
A starting set of files for a new Workspace, which the Agent chooses to suit what the Developer asked for (ADR 0018).
_Avoid_: Starter, scaffold, boilerplate

**Add-on**:
A tested set of files and notes that gives an app one ability, such as storage, which the Agent adds to a Workspace when the Developer's request needs it (ADR 0019). The page never names one: a step says what it adds, such as "Adding an organiser's area".
_Avoid_: Plugin, module, recipe, kit, extension

## Words on the page

The page shows these words in place of the glossary's own, for Developers who don't write code (ADR 0018).

**app**:
A Workspace, and its Preview where the page shows it running. In code and docs, an app is still what a Workspace's Build runs, as in app host and apps domain.

**chat**:
The Conversation, where the page needs a short name for it, as on a phone's tabs.

**making sure it works**:
The Check, Build and tests that end a Turn.

**live**:
Said of a Workspace with a Deployment. It's "live, with changes not yet published" while its latest Build differs from its Deployment, and "not published" before it has one.

**ready-made part**:
A Package, where the page needs to name one, as in the Agent's step "Adding a ready-made part".

**starting point**:
A Template, as in the Agent's step "Choosing a starting point", whose detail says which, such as "A web page that remembers things".

**this Jigworks's list**:
The people who can use a Deployment when the Installation's Deployments aren't open to everyone: those the apps' Access application lets in, which is the Developer list unless the Operator chose otherwise. When they are open to everyone, the page says "anyone with the link" instead.
