# Conductor — code rules

These rules hold for every change to this repository, by a person or an agent. The code is meant to be open-sourced.

## Language

- Everything is written in English: code, comments, user-facing strings (toasts, command output, the band, the pane), settings titles, prompts, docs, tests and commit messages.

## Types

- **Strong types, always.** No `any`. No `as unknown as`. A cast (`as T`) only where the compiler cannot follow a fact the code just checked, and never to silence an error.
- **Types live in their own files.** Every type and interface goes in a `*.types.ts` file beside the module that owns it (`config.ts` → `config.types.ts`, `jev.ts` → `jev.types.ts`). A module file declares no types, local helper types included; it imports them with `import type`.
- Shared domain types are in `src/core/domain.types.ts`; a JSON object not checked yet is `JsonObject` (`src/core/json.types.ts`).
- Constants are values, not types: they go in `src/core/constants.ts` or the module that uses them, never in a `*.types.ts` file.
- **Closed sets are literal unions** (`'native' | 'openrouter'`), **outcomes are discriminated unions** (`{ ok: true } | { ok: false; reason: string }`), and inputs a function does not change are `readonly`.
- **External input is parsed at the boundary, never cast.** JSON from disk, a CLI's output, an HTTP or MCP reply, and a tool's model-written input each go through a parser or type guard that returns the typed value or throws (see `src/mod/tool-inputs.ts`, `parseJevResponse`, `parseConfig`). Unknown fields are ignored, missing ones are errors or explicit defaults.
- A config read from disk is resolved once (`resolveConfig`) into a type with no optional decisions left (`ExecutorConfig.provider` is always set); code downstream never re-derives defaults.

## Exports

- Named exports only; no default exports.
- The public surface is `src/index.ts`: every `*.types.ts` file is re-exported there with `export type *`, and every class or function an embedder needs is exported by name. A new public module is added there in the same change.
- Export only what another module or an embedder uses.

## LLM calls: OpenRouter is the gateway

- Every LLM call goes through OpenRouter unless the config says otherwise: Jev (`<jev.baseUrl>/v1/systemone`), `ask_openrouter`, the `openrouter` worker, and every worker whose CLI can route through it (Claude, Codex, OpenCode — `OPENROUTER_CAPABLE`).
- The global `gateway` decides; a worker's own `provider` overrides it. Models are configured per provider (`models.openrouter`, `models.native`), as OpenRouter ids (`vendor/model`) under `openrouter`.
- Do not call a model vendor's API directly. A new model call goes through `openrouterComplete` or the Jev client.
- The key is `OPENROUTER_API_KEY`, read in one place (`src/mod/host.ts`), passed to workers by environment, never on argv, never logged. A worker routed through OpenRouter without a key reports why it cannot run (`Availability`), it does not fail later.
- Text that leaves the machine is redacted first (`redact`, `redactDeep`): secrets, CPF and CNPJ.

## The mod

- `src/` runs inside the mod engine: no Node APIs, no `fetch`, no `setTimeout`, no dynamic `import()`. Everything outside goes through the `Host` port (`src/core/host.types.ts`); only `hooks/` and `src/mod/` touch `$`.
- Imports carry the `.ts` extension, and TypeScript stays erasable (no `enum`, `namespace` or constructor parameter properties): tests run the same files under Node's type stripping.
- Paths handed to workers are real paths (symlinks resolved), and worktrees live outside the project (`~/.conductor/worktrees/…`).
- Hooks that guard fail closed (`.catch` → deny); judgments (Jev) fail open (fall back to the rules).

## Checks before a change is done

```bash
npm test                  # Node: core, adapters, end to end with real git and job.sh
claude plugin test .      # the mod's hooks in the engine
claude plugin validate .
tsc -p .                  # once the engine has laid .claude-plugin/types (a --plugin-dir session)
npm run smoke             # live, real CLIs and tokens: after changing an executor or the worker brief
```

A test that asserts on user-facing text asserts the English text.
