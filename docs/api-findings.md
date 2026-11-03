# Mod API findings (§15 of the context doc)

Checked against the types Claude Code 2.1.309 generated (`claude-code.d.ts`) and
`claude plugin validate`. Where the context doc and the types disagree, the types win.

| Question | Answer | Consequence in the code |
|---|---|---|
| Shape of `on(...)` and matchers | `on(event, matcher?, ($, e, next) => …)`; matchers are objects (`{ tool }`, `{ command }`, `{ component }`). Guards add `.catch(($, e, next) => …)`. | `hooks/register.tsx` |
| `$.process`: long / detached / stream / kill / timeout | `run(argv, { cwd, env, stdin, timeoutMs })` is one-shot, **10 min max**. `spawn({ argv })` streams and lives as long as its loop — **a hot reload of the mod kills the child**. No kill by PID. | Workers run **detached** through `scripts/job.sh` (pid, `exit` file, logs on disk). The heartbeat polls the files and kills by PID tree. Workers survive mod reloads, `/clear` and even a session restart. |
| `$.clock.every` minimum | at least 1 ms; the callback gets no `$` (capture it). A reload cancels timers; `session.start` re-arms them. | heartbeat 20 s by default |
| `$.session.send` / background sessions | `$.agent.spawn({ subagentType, prompt })` runs a subagent of this session; its answer is its `turn.complete`. | Day 1 uses `claude -p` (detached, survives reloads). A subagent executor is a later option. |
| `$.tool.register` schema | `{ name, description, inputSchema (JSON schema), isDeferred }`; served by `on('tool.call', { tool: 'mcp__conductor__<name>' })` returning `{ result }` or `{ deny }`. | six tools, `isDeferred: false` |
| MCP from the mod | **Yes: `$.mcp.call(server, tool, args)`** with the engine's own connection and credentials, no permission prompt. | The Uranus OS adapter can call the Uranus MCP directly — no REST token (doc option A) and no Claude turn (option B). |
| TypeScript directly? | Yes: `.ts`/`.tsx` loaded as ES modules; files of the plugin imported with `import` (`.ts` extensions fine). No `import()`. | `src/` is plain TS, also runnable by `node --test` (type stripping), so the core is tested outside the engine. |
| `$.store` / `$.state` size | `$.store` ≤ 4 MiB JSON in all; `$.state` is per-session, survives reloads; render hooks may not write. | The task source holds the truth; `$.state` only holds the band's summary. |
| Passing `$` to helpers | Allowed (`validate` follows calls through helpers: "via hostOf"). | `hostOf($, cwd)` implements the core's `Host` port. |
| Env vars | `$.env.get(name)` with a **literal** name. | `OPENROUTER_API_KEY` read in one place. |

## CLI facts that differ from the doc

- `claude -p` no longer has `--max-turns`; budget is `--max-budget-usd` + our timeout.
- `opencode` v2: no `--dangerously-skip-permissions`; `--auto` approves tools, `--standalone` runs a private server (rooted in the worktree).
- `codex exec` has `--json` (token usage events), `-o`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`, `-C`.
- Cursor's headless CLI (`agent` / `cursor-agent`) is not installed here (only Cursor.app); the adapter's binary is configurable (`bin`, `binArgs`) and it is untested against the real CLI.
- Antigravity's CLI is `agy`: `-p`, `--output-format json` prints `{ status: "SUCCESS", response, usage, denied_actions? }` (no US$ cost), `--mode accept-edits|plan`, `--print-timeout`, `--settings` (per session). `agy models` checks login in ~7 s.

## Switches

Plugin `userConfig` booleans (`enabled`, `worker_<id>`) are rows in `/config`; a change reloads the module with the new `options`, so `session.start` rebuilds the Conductor. `$.config.set({ key: 'conductor.<field>' })` is how `/conduct on|off|worker` writes them.

## OpenRouter, the gateway

- `gateway: "openrouter"` (default) routes Jev, `ask_openrouter`, the `openrouter` worker, and Claude, Codex and OpenCode through OpenRouter; Cursor and Antigravity have no route and use their own logins.
- Claude: Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`), models `anthropic/claude-*-5.5`. **Found live:** outside `--bare`, Claude Code's own login (claude.ai OAuth, the Keychain) takes precedence and the request reaches OpenRouter with no credentials (`401 Missing Authentication header`, retried 11 times), whatever `ANTHROPIC_AUTH_TOKEN` says. The endpoint itself accepts both `Authorization: Bearer` and `x-api-key`. The worker therefore runs `claude --bare` with the key in `ANTHROPIC_API_KEY` (environment only); `--bare` skips CLAUDE.md discovery, so the worktree's CLAUDE.md is passed with `--append-system-prompt-file`.
- Codex: `-c model_provider=openrouter` with the Responses wire API, models `openai/gpt-5.x-codex*`.
- OpenCode: `openrouter/<model>`; with no key in the environment it uses its own stored OpenRouter login (`opencode auth`), so the adapter never blanks the variable.
- Model ids were taken from OpenRouter's public model list on 2026-11-03.
- The key is read from `OPENROUTER_API_KEY` and passed to workers by environment, never argv. Without it, Claude and Codex report `no OPENROUTER_API_KEY in the environment` and leave routing.
- Verified live (2026-11-03, key from the Keychain): Claude, Codex and OpenCode workers merged tasks through OpenRouter; Jev answered (`typesafe/jev-1.14-20261014`); `ask_openrouter` answered.
- The key: `/conduct key` stores it in the macOS Keychain (`scripts/openrouter-key.sh`, a native dialog with hidden input; the key reaches `security` through stdin, never argv). `OPENROUTER_API_KEY` in the environment wins.

## Jira, Linear and Figma (researched, not yet live)

Sources: Atlassian's supported-tools page and `atlassian/atlassian-mcp-server`; Figma's developer docs and `figma/mcp-server-guide`; for Linear, whose docs list no tools, community captures of the hosted server. Their connectors need signing in, so the adapters are tested against simulated servers built from these shapes.

- **Atlassian Rovo MCP v2**: every tool needs `cloudId` (from `getAccessibleAtlassianResources`). A few tools are listed directly (`createJiraIssue`, `editJiraIssue`, `getJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `searchJiraIssuesUsingJql`); the rest go through the `execute` meta-tool as `execute({ name, cloudId, inputs })` — the adapter calls a tool directly when the session lists it, through `execute` otherwise. `createJiraIssue` takes `projectKey`, `issueType` (name), `summary`, `description` (Markdown), `parent` and answers `{ key, id, self }`. The server drops parameters it does not know, so labels (`editJiraIssue` `fields.labels`), links (`createJiraIssueLink`) and transitions (`listJiraIssueTransitions` → `transitionJiraIssue`) are best effort: workflows differ, transitions are matched by name, and labels carry the status when no transition fits.
- **Linear**: the hosted server's tools upsert (`save_issue`, `save_comment`, `save_project`: no `id` creates); older servers have `create_issue` / `update_issue`. Issues take `title`, `team`, `description`, `state` (name), `labels` (names; ones that do not exist are refused, so the adapter writes without them), `project`, `blockedBy`. Replies carry `identifier` (`ENG-123`) and `id`.
- **Figma**: `get_design_context({ fileKey, nodeId, clientFrameworks? })` returns code, assets and variables for a node; a link `figma.com/design/:fileKey/…?node-id=1-2` maps to `fileKey` and `nodeId` `1:2` (a branch link uses the branch key). Whiteboards in Uranus OS cannot carry a drawing over MCP (they are created empty), so the graph of a finished task is posted as a Mermaid comment instead.

## The graph engine (design doc §5B)

- Templates are code (`src/graph/templates/`), versioned; the engine is pure functions (`src/graph/engine.ts`): edges, limits (retries, cost, minutes) on the edges, write ownership checked at each node's boundary, status derived from the cursor, Mermaid of the path.
- The engine is the Conductor's own, not LangGraph: a mod has no Node APIs, and the engine is a few hundred lines.
- Retries are counted on the edges taken back (`rule: 'retry'`), so a node that fails before any attempt cannot loop.

## Jev (through OpenRouter)

OpenRouter serves Jev through the System One API: `POST https://openrouter.ai/api/v1/systemone`, `Authorization: Bearer $OPENROUTER_API_KEY`, body `{ model, state, questions }`, model `typesafe/jev-1.14` (or the `~typesafe/jev-latest` alias); billed to the OpenRouter account, and the reply adds `usage.cost`. Each named question is `{ type: "noul", instructions }`, `{ type: "choice", instructions, criteria: { name: description } }` or `{ type: "score", instructions, criteria: [levels…] }`. Answers come back under the same names: `noul` (0..1), `choice` + `confidence` + `probabilities`, `score` (0-based mean over the levels) + `confidence`; the reply names the `model` that answered. Sources: openrouter.ai/docs/guides/community/jev and …/typesafe-sdk, docs.typesafe.ai/api/system-one. OpenRouter also has a Decisions API (`POST /api/alpha/decisions`) shared by other decision models; the Conductor uses the System One path.

## Antigravity, found live

- `--mode accept-edits` refuses *creating* files headless (`denied_actions: [write_file]`); `--mode auto` is not available on every account; `--sandbox` does **not** stop writes outside the workspace.
- `--settings '{"permissions":{"allow":[…]}}'` applies rules for one session, never saved. `write_file(<dir>/**)` and `edit_file(<dir>/**)` scoped to the worktree work; `command(<cmd>)` matches the command **exactly** (`command(ls *)` does not match `ls *.txt`).
- Any denied action aborts the turn with an empty response; the worker brief therefore asks for file tools, and shell commands only as the checks spell them.
- A working directory spelled through a symlink (`/var/…` instead of `/private/var/…`) makes every write rule miss: worktrees are created at real paths, and the mod resolves `cwd` and `HOME` with `$.fs.stat(…, { resolve: true })`.
- A worktree nested in the project's git-ignored `.conductor/` was also refused; worktrees now live under `~/.conductor/worktrees/`.

## Uranus OS MCP

**Verified live (2026-11-03, sandbox project `CSBX`, archived afterwards):** every call the adapter makes was accepted — `epics_create` (the slug nested as `data.epic.slug`), `tasks_create` (`data.key`), `tasks_relate`, `tasks_batch` transitions through every status (`blocked` with its reason), `tasks_comment`, `tasks_search` returning a board cancellation, `project_updates_publish`, `epics_update` to done. **Found live:** labels must already exist in the workspace (`Every slug in labels must name an open label`); the adapter tries once, then goes on without labels — the status and comments carry the state. `tests/unit/uranus-replay.spec.ts` replays those replies.

Replies are an envelope `{ tool, trust: "data", origin, data: { … } }`; lists are `data.rows` with `next_cursor`. Tasks are keyed `PRJ-n`, epics by `slug` within a `project_key`. Statuses: backlog, todo, in_progress, blocked (needs `blocked_reason`), review, done, cancelled. `tasks_batch` applies up to 50 transitions/updates in one call (used for status + labels). Rate limit: 120 calls/min per token. 
