# Conductor — an agentic software factory

> The design document the Conductor was built from, as a **Claude Code mod**.
> Where this document and the generated types in `.claude-plugin/types/` disagree,
> **the types win**. What the types answered is in [`api-findings.md`](./api-findings.md).

## 1. Vision

- **Claude is the maestro.** It plans, breaks the work down, delegates, reviews, integrates, and sees long runs through to the end.
- **Jev is the classifier.** For each task it decides *who* executes it, *how hard* it is, *how risky* it is and *whether it is verified*. It never writes text or code.
- **Workers are the hands.** Codex, Cursor, OpenCode, Antigravity, headless Claude and OpenRouter models execute tasks in parallel, each isolated in its own worktree.
- **A task source is the truth.** State lives outside the conversation (Uranus OS, or a local file), so it survives `/clear`, compaction, crashes and a change of machine.

Core principle: **the LLM writes, Jev decides, the code acts.**

## 2. Architecture: a generic core with adapters

| Interface | What it abstracts | Implementations |
|---|---|---|
| `TaskSource` | Where tasks come from and go back to | `LocalFileTaskSource`, `UranusOSTaskSource` |
| `Executor` | Who executes a task | `ClaudeExecutor`, `CodexExecutor`, `OpenCodeExecutor`, `CursorExecutor`, `AntigravityExecutor`, `OpenRouterExecutor` |
| `DecisionModel` | Who takes the enumerable decisions | `RuleDecisionModel`, `JevDecisionModel`, combined by `DecisionRouter` |

Every LLM call goes through **OpenRouter** by default (`gateway: "openrouter"`): Jev, `ask_openrouter`, and the workers whose CLI can route through it (Claude, Codex, OpenCode). Cursor and Antigravity use their own logins.

## 3. Roles

### Claude (maestro)
Produces the plan (a run → tasks with acceptance criteria, likely files and dependencies), records it in the `TaskSource`, reviews what the gate flags, resolves merge conflicts, is woken by the Conductor (`$.prompt.submit`) only when something needs judgment, and keeps the highest-tier tasks for itself.

### Jev (classifier)
TypeSafe's "System One" model: it takes a state and typed questions and returns a choice, a score or a probability with calibrated confidence. Three question types: **Choice** (up to 255 options), **Score** (a rubric of 2 to 10 levels), **Noul** (yes/no → probability 0..1). Cheap (≈ US$ 0.042 per million input tokens, output free), 70–500 ms, text only, best in English. Reached through OpenRouter's System One API (`POST https://openrouter.ai/api/v1/systemone`, model `typesafe/jev-1.14`); pin the version and log the version that answered.

### Workers
| Worker | Role | Why |
|---|---|---|
| Claude (`claude -p`) | Hard, ambiguous tasks | Best reasoning |
| Codex (`codex exec`) | Adversarial reviewer, and implementer of well-specified tasks | Another lab = uncorrelated mistakes |
| Cursor (`agent -p`) | Bulk, mechanical edits | Fast editing models |
| OpenCode (`opencode run`) | Cheap work with any model through OpenRouter | Provider-agnostic |
| Antigravity (`agy -p`) | Well-specified feature work | Another lab |
| OpenRouter directly | One-off questions, summaries, fixtures | No agent overhead |

## 5A. Life of a task

> With section 5B the status is no longer edited by hand: it is **derived** from the node the task stands on in its graph (node `review` → status `verifying`).

```
draft ──▶ planned ──▶ classified ──▶ ready ──▶ dispatched ──▶ running
                                       ▲                         │
                                       │                         ▼
                                    retry ◀── failed ◀──── verifying ──▶ needs_review ──▶ (Claude)
                                                              │                              │
                                                              ▼                              ▼
                                                            done ◀──────────────────── approved
                                                              │
                                                              ▼
                                                           merged
```

- `ready` once every dependency is merged (the dependent's worktree starts from the integration branch).
- `classified` needs an answer from Jev **or** the `RuleDecisionModel`.
- `verifying` runs the deterministic checks first; if they fail → `failed`, no model asked.
- Checks green → "is this verified?"; below the threshold → `needs_review`, above → `done`.
- `retry` is limited (2 by default) and climbs one tier each attempt.
- Every transition is written to the `TaskSource` before it counts as made.

## 5B. Graph engineering — the Conductor is a graph of loops

- **Loops inside the nodes, a graph between them.** Each worker stays a free loop *inside* a node. The Conductor declares in code which nodes exist, which transitions are allowed and what travels in the state. No model invents the run's path.
- **A loop is the default; a node must justify itself** with real specialisation, perceptible parallelism, or independent verification. Every node is described in one sentence without "and".
- **Two levels:** the run is a DAG of tasks (`dependsOn`; independent tasks fan out, the merge queue fans in); each task walks a **template**.
- **Nodes:** `plan`, `route`, `research`, `implement`, `check`, `security`, `review`, `judge`, `human`, `merge` (and `report` for spikes). Each state field has **one owner node**; writes are validated at each node's boundary; a node returns only the fields it changed.
- **Edges** are straight, conditional, fan-out or fan-in. **Every stopping rule lives on an edge** (retries, quality gates, tier escalation, budget, time). A retry goes back only to the node that failed and reuses the research notes. Every edge records from, to and why.
- **Templates** (`src/graph/templates/`, versioned): `solo` (implement → check → merge, the default), `feature` (… → review → judge → merge), `bugfix` (research → implement → check → review → merge), `refactor` (fan-out implement per module → fan-in → check → review → merge), `secure` (implement → check → security → review → human → merge), `spike` (research → report, no merge). Risk ≥ 4 forces `secure`; in doubt, `solo`.
- **Independent verification (a hard rule):** the reviewer is never the author's worker, preferably another lab, read-only, seeing only the task, criteria, diff and test output.
- **Checkpoints:** after each node the `NodeRun` and the cursor are written to the task source; resuming goes back to the saved cursor, never the transcript.
- **Observability:** `/conduct graph <taskId>` draws the template and the path taken in Mermaid; a finished task gets it as a comment on its board; cost and duration per node.
- **Our own engine, not LangGraph:** a mod has no Node APIs; the engine is small (`src/graph/engine.ts`) and tested per template, including forcing the retry edge.

## 7. Jev's questions

Rules: questions in English, literal, no double negatives; every option with a distinct description, plus `other`; **shuffle the options** on every call; send evidence, not summaries; one call per state (batch); never ask Jev to count, do arithmetic or compare dates; redact secrets; judgments fail open, hard checks fail closed; final risk = `max(deterministicFloor, jev)`.

### 7.1 Classification
| Key | Type | Question | Options |
|---|---|---|---|
| `executor` | Choice | Which worker should implement this task? | `claude` (ambiguous, cross-cutting, needs judgment) · `codex` (well-specified, self-contained logic) · `cursor` (mechanical, repetitive edits across many files) · `opencode` (simple, low-risk, boilerplate) · `antigravity` · `openrouter` · `other` |
| `complexity` | Score 1–5 | How complex is this task to implement correctly? | 1 trivial … 5 requires design decisions |
| `risk` | Score 1–5 | How much damage could a wrong implementation cause? | 1 cosmetic … 5 auth, payments, data loss, tax rules |
| `parallelizable` | Noul | Can this task be done without touching files other open tasks touch? | — |
| `needsHuman` | Noul | Does this task require a decision only a human can make? | — |
| `template` | Choice | Which workflow fits this task? | `solo` · `feature` · `bugfix` · `refactor` · `secure` · `spike` · `other` |

Tier, in code: `complexity >= 4 || risk >= 4` → `strong`; `complexity <= 2 && risk <= 2` → `cheap`; otherwise `standard`. Risk floor: `auth/`, `billing/`, `migrations/`, `*tax*`, `.env*`, `config/` → `risk >= 4`.

### 7.2 Verification
| Key | Type | Question |
|---|---|---|
| `verified` | Noul | Given the acceptance criteria, the diff summary and the test output, is the task fully done? |
| `scopeCreep` | Noul | Did the change modify files unrelated to the task? |

`verified < 0.8` or `scopeCreep > 0.3` → `needs_review`.

### 7.3 Rollout
1. Shadow (the rules decide, Jev is only logged) → 2. Label (compare with the real outcome) → 3. Thresholds per decision → 4. Enforce with fallback → 5. Monitor (ask again with the options reshuffled).

## 8. Executors — common rules
- Always a timeout (15 min implement / 5 min review): kill, `failed`, reason `timeout`.
- One worktree per attempt, outside the project (`~/.conductor/worktrees/<project>-<hash>/<runId>/<taskId>-<attempt>`), on branch `conductor/<runId>/<taskId>-<attempt>`, at a real path (no symlinks).
- One worker brief: goal, criteria, scope, "do not touch anything outside the scope", "run the checks", the final answer's format; file tools for files, the shell only for the checks.
- Full output in `.conductor/logs/<runId>/<taskId>/<attempt>/`; only the summary goes back to Claude.
- Codex: stdin closed, read the `-o` file, require exit 0 and a non-empty file, a fresh file per call, pin the model.
- Cursor: no locked mode (the project's hooks/MCP stay active) → the least trusted worker.
- Antigravity: headless cannot prompt; writes are allowed inside the worktree only, and commands only as the checks spell them.
- Claude: do not leave `ANTHROPIC_API_KEY` in the environment when the plan should be billed.

## 10. Long runs
1. The TaskSource is the truth; `$.store`/`$.state` are caches.
2. Heartbeat (`$.clock.every`, 15–30 s).
3. Reconciliation on `classic.SessionStart`, on a `/clear` (`session.end`) and on `/conduct run`.
4. Wake the maestro only when needed (`needs_review`, conflict, `needsHuman`, run finished).
5. A cheap handoff with `$.model.fork`.
6. Budgets per task/run/day; an attempt limit; concurrency per executor.
7. Merge queue: one integration at a time; Claude resolves conflicts.
8. Periodic updates (`publishUpdate`).

## 11. Security
- Mods have no sandbox; processes from `$.process` go through neither Claude's sandbox nor its deny rules. Each CLI's sandbox is the real boundary.
- Worktrees hold no real `.env`. Never send secrets to Jev or OpenRouter.
- Regex is not security; for destructive operations, allow-lists.
- No worker pushes or deploys. Only the maestro, with the user's confirmation.
- Distribution: a marketplace in a Git repository, or `--plugin-dir`; managed settings for teams.

## 12. Ledger
Per attempt: executor, model, tokens, US$, duration. Aggregated per task, run, project and **client**. Source: the CLIs' JSON; otherwise marked unknown.

## 13. Uranus OS adapter

| Conductor | Uranus OS |
|---|---|
| Run | Epic |
| Task | Task of the epic |
| `dependsOn` | `tasks_relate` (blocks) |
| Transition | `tasks_batch` (status + labels) |
| Note / verdict | `tasks_comment` |
| Executor / tier / risk | Labels |
| Periodic update | `project_updates_publish` |
| Creation | `epics_create` + `tasks_create` |
| A task's path | A Mermaid comment (whiteboards cannot carry a drawing over MCP) |

The same shape serves **Jira** (run = epic, task = issue under it, over the Atlassian Rovo MCP server) and **Linear** (run = project, task = issue in it): the `Board` interface, for scopes beyond Uranus. Tasks may carry **Figma** links; the Figma MCP server's design context goes into the worker's brief.

Board: `Backlog → Ready → Running → Verifying → Review → Done → Merged`, plus `Failed`. Access: **`$.mcp.call`** straight to the Uranus OS MCP server (see api-findings).

## 14. Roadmap
- **Day 1** — done.
- **Phase 2** — done: Cursor, Antigravity and OpenRouter workers, per-worker switches, the verifier (deterministic + Jev), the board pane, the ledger with a day budget, orphan reconciliation, the edit guard, handoff.
- **Phase 3** — done: JevDecisionModel through OpenRouter, shadow by default, labels, threshold suggestions, enforce with fallback, consistency monitoring.
- **Phase 4** — done: UranusOSTaskSource over `$.mcp.call`, periodic updates, a private marketplace, LGPD redaction (optional).
- **Graph engineering (new phase 2)** — done: the graph engine, the six templates, write ownership, edges with limits, checkpoints per node, `/conduct graph`, reviewer from another lab.
- **Boards and design (new phase 3)** — done: Jira and Linear as task sources over their MCP servers (with Uranus OS on the same `Board` interface), Figma design references.
- **Dashboard** — done: a progress band above the prompt (bar, running tasks, tokens, cost against the budget) and a dashboard pane that opens with the run (stat tiles, cost by worker, every task with its node trail), drawn as text in the terminal and with SVG charts in the desktop app.

## 16. References
- Mods API: https://code.claude.com/docs/en/plugins/mods/api
- Cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- Jev on OpenRouter: https://openrouter.ai/docs/guides/community/jev
- TypeSafe docs: https://docs.typesafe.ai
- Cursor headless: https://cursor.com/docs/cli/headless
- OpenCode CLI: https://opencode.ai/docs/cli
