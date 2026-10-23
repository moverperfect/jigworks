# ts-rust is the type-checker, with no fallback

The experiment tests [ts-rust](https://github.com/pingdotgg/ts-rust), compiled to WASM, as the type-checker inside a Worker. It doesn't test in-Worker type-checking in general. If ts-rust doesn't fit in a Worker because of memory, stack depth or speed, that is the result, and we don't swap in TypeScript 6's JS compiler. TS 6 is known to work in Workers (`@cloudflare/worker-bundler/typescript`) and has a full language service, but it would answer a different question.

## Consequences

- ts-rust's WASM build has no language service, so the editor shows only the errors each Check finds. It has no type information on hover, no type-aware completions and no go-to-definition. CodeMirror still completes keywords and the names in the open file.
- ts-rust follows TypeScript 7 rules, so Templates must use a tsconfig that TS 7 accepts. For example, `baseUrl` is no longer supported.
- We build the WASM module ourselves, because ts-rust doesn't publish one. See `docs/research/ts-rust.md`.
