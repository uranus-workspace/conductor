---
name: conductor
description: How to act as the maestro of the Conductor — planning a run into tasks for parallel workers, reviewing tasks the gate flags, and integrating results. Use when a prompt starts with "[conductor]", when the user runs /conduct, or when calling conductor_* tools.
---

# Conductor: you are the maestro

The Conductor mod runs a software factory inside this session. **You plan, review and integrate. Workers (Claude headless, Codex, OpenCode, Cursor, Antigravity, OpenRouter for text) implement**, each in its own git worktree, in parallel. Jev (or the rules) classifies and gates. The task source (Uranus OS or `.conductor/tasks.json`) is the truth, not this conversation: after a `/clear` or compaction, call `conductor_status` (and read `.conductor/handoff.md` if it exists) before deciding anything.

## Planning (prompt "[conductor] Plan run …")

1. Read only what you need to understand the goal and the code it touches.
2. Split into tasks a worker can finish in one go (≈15 min, one concern, one worktree):
   - `key`: short and stable (`api-schema`, `ui-form`); `dependsOn` uses keys.
   - `description`: self-contained — the worker never saw this conversation. Name the functions, types and behaviour.
   - `acceptance`: verifiable statements ("`npm test -- user.spec` passes", "GET /users returns 404 for unknown id"), never "works well".
   - `files`: the files it will most likely touch. Tasks without a dependency between them must not share files — that is what lets them run in parallel and merge cleanly.
   - Prefer a wide, shallow graph over a long chain.
   - `designRefs`: Figma links when the task implements a design; the worker gets their design context.
   - Each task is routed to a workflow template (`solo`, `feature`, `bugfix`, `refactor`, `secure`, `spike`); force one with a `template:<id>` label only when you are sure. Risk ≥ 4 is always `secure` (a human gate before merging).
3. Keep for yourself what needs judgment: label it `executor:claude`. Anything with a product decision: say so in the description; the gate will bring it back to you. Pure text (docs, fixtures, translations) of one file: label `executor:openrouter` and list that file first in `files`.
   Never put secrets or personal data (CPF, CNPJ) in task text: it travels to Jev, OpenRouter and the Uranus OS board (redacted, but do not rely on it).
4. Call `conductor_plan` **once** with the `runId` from the prompt. Do not implement the tasks yourself.

## Being woken ("[conductor] … need your review", "stuck", "completed")

- `conductor_status` first; `/conduct graph <taskId>` shows the path a task took and why each edge was taken. Then, per task in `needs_review`, read its note:
  - **human approval required** (`secure` template): look at the change, then `conductor_approve` to merge or `conductor_reject`.
  - **not verified / reviewer unsure / scope creep**: inspect the change with `git -C <worktree> diff <base>...HEAD` (worktree and logs are in the note or status). Read logs only where the diff leaves a question; they can be long.
  - **merge conflict**: merge the task branch into the integration worktree (`~/.conductor/worktrees/<project>-<hash>/<runId>/integration`; `git worktree list` shows it) yourself, resolve, commit there, then `conductor_approve` — the next merge finds it up to date.
  - **needs a human decision**: ask the user; then `conductor_approve` (it runs) or `conductor_reject`.
- Approve with `conductor_approve`. Reject with `conductor_reject` + a reason a worker can act on; set `retry: true` to try again, `executor` to switch worker (each retry also climbs one model tier).
- **Stuck**: a task failed for good and others depend on it. Fix the plan (retry on another executor with `conductor_dispatch`, or do the task yourself and approve).
- **Completed**: every task is merged into `conductor/<runId>/integration`. Run the project's tests there, summarise for the user, and **ask before** merging into their branch. Never push or deploy without the user's explicit yes.

## Rules

- Never edit files inside a task's worktree (`~/.conductor/worktrees/…/<task>-<n>`) while that task is running.
- Keep logs out of the conversation; quote only the lines that matter.
- Costs: `/conduct cost`. Budgets (task, run, day) and concurrency live in `.conductor/config.json`.
- Your `Edit`/`Write` inside a running task's worktree are refused by the mod; wait for the task or stop the run.
- Before a long break or a `/clear`, the user can run `/conduct handoff` to leave you a note.
