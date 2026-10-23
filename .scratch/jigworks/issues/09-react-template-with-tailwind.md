# 09: Worker + React Template with Tailwind

**Parent:** [spec](../spec.md), user stories 9, 13 and 45 (stage 4)

**What to build:** The Developer creates a Workspace from the Worker + React Template. Its Build includes CSS that Tailwind compiles from the class names used in the source, and the Preview shows a styled React page.

**Blocked by:** 08 (Preview the latest Build).

**Status:** ready-for-agent

- [ ] The Template has:
  - a Hono server entry;
  - a React client entry using `jsx: "automatic"`;
  - `index.html`;
  - `public/`;
  - a Tailwind stylesheet.

  `tailwindcss` isn't listed in `package.json`.
- [ ] The Template's `AGENTS.md` tells the Agent:
  - not to import CSS from code;
  - not to use CSS modules;
  - not to use `@/` aliases;
  - not to import images;
  - not to use `import.meta.env`;
  - to start cookie names with `__Host-`.
- [ ] Each Build runs a Tailwind step, using the platform's fixed Tailwind version, our own class-name scanner and no plugins (ADR 0007). Classes used in the source appear in the CSS.
- [ ] `@plugin` or `@config` in a stylesheet fails the Build with a clear error, rather than being ignored.
- [ ] The plain-CSS fallback works: a Workspace whose stylesheet is plain CSS builds with its `@import`s included.
- [ ] A fresh Workspace made from this Template has a clean Check, builds, and shows a styled page in the Preview.
- [ ] The findings document gets the stage 4 verdict for both Templates, with Build timings, memory and the gaps found.

## Tasks

1. Tailwind step: fixed version, class-name scanner, no plugins.
2. Worker + React Template, with its `AGENTS.md` rules.
3. Plain-CSS fallback.
4. Write the stage 4 verdict.

Drafted by an AI agent on Jack's behalf.
