# Logs and metrics

The Conductor keeps two records, both on your machine and never sent anywhere.

| What | Where | For |
|---|---|---|
| The project's log | `.conductor/logs/conductor-<YYYY-MM-DD>.log` in the project | Reading what happened: board calls skipped, errors, heartbeat failures |
| The metrics ledger | `~/.conductor/metrics/<YYYY-MM>/<YYYY-MM-DD>-<session>.jsonl` | Measuring: sessions, worktrees, cost, tokens, models, errors, across every project |

Each worker's own output stays where it was: `.conductor/logs/<run>/<task>/<attempt>/` in the project (prompt, `out.log`, `err.log`, exit code), next to `reports/`, `graphs/` and `jev/`.

Free text (goals, reasons, error messages) is redacted before it is written: API keys, CPF and CNPJ numbers are masked, and long text is cut short. Writes are buffered and land on every heartbeat and when the session ends.

## `/conduct stats`

```
/conduct stats          the last 30 days
/conduct stats 7        the last 7 days
```

It reports:

- sessions, projects, runs and the share of tasks merged;
- total cost and tokens;
- the most jobs and worktrees running at once;
- by worker and by model: jobs, success rate, average duration, tokens and cost;
- by template: merged and failed, attempts per task, retries and cost;
- by session: runs, jobs and cost, most expensive first;
- the most frequent errors. Errors that differ only in paths, ids or numbers count as one.

## The ledger

One JSON object per line. Every record has:

| Field | |
|---|---|
| `v` | schema version, `1` |
| `at` | ISO time |
| `session` | the Claude Code session id |
| `project` | the project's real path |
| `kind` | one of the kinds below |

| `kind` | Recorded when | Fields |
|---|---|---|
| `session.start` | a session loads the Conductor, once its workers are detected | `version`, `platform`, `gateway`, `enabled`, `workers` (ready to run) |
| `session.end` | the session ends | `reason` (`clear`, `prompt_input_exit`, `other`, …) |
| `run.created` | `/conduct plan` opens a run | `runId`, `goal` |
| `run.planned` | the maestro records the plan | `runId`, `tasks` |
| `run.finished` | a run completes or is stopped | `runId`, `status`, `tasks`, `merged`, `failed`, `costUsd`, `tokensIn`, `tokensOut`, `minutes` |
| `job.started` | a process starts: research, implement (one per fan-out part), check, security, review | `runId`, `taskId`, `job`, `executor`, `tier`, `model`, `provider`, `template`, `attempt` |
| `job.finished` | it exits, times out or vanishes | `runId`, `taskId`, `job`, `outcome`, `exitCode`, `durationMs`, `executor`, and for the author's jobs `tier` and `model` |
| `node.finished` | a node of the task's graph finishes | `runId`, `taskId`, `template`, `node`, `status`, `to` (the edge taken), `rule` (`retry`, a limit), `reason`, `costUsd`; the worker (`executor`, `tier`, `model`) for research, implement and review; `tokensIn`/`tokensOut` for implement |
| `task.finished` | a task is merged or fails for good | `runId`, `taskId`, `template`, `status`, `attempts`, `retries`, `executors`, `models`, `costUsd`, `tokens`, `minutes`, `reason` |
| `snapshot` | what is running changes | `runId`, `runningJobs`, `byExecutor`, `worktrees` |
| `error` | something failed inside the Conductor: a task's node, the heartbeat, a command | `where`, `message`, and `runId`/`taskId` when known |

Cost is counted once, on `node.finished`: implement, research and review each report their own. `task.finished` and `run.finished` carry totals.

The types are in [src/core/metrics.types.ts](../src/core/metrics.types.ts), and `readMetrics` in [src/core/metrics.ts](../src/core/metrics.ts) reads a period back. A new field is added without a version change; a field that changes meaning bumps `v`.

## Settings

In `.conductor/config.json`:

```json
{ "metrics": { "enabled": true, "dir": "" } }
```

- `enabled: false` stops this project from writing to the ledger. The project's log is always written.
- `dir` moves the ledger, for example to a shared disk. Empty means `~/.conductor/metrics`.

## What it is for

The ledger is the Conductor's memory of its own work, kept so it can improve itself later:

- **Routing.** For each kind of task, compare how often each worker and model succeeds, and at what cost and speed. That is the evidence to change the routing rules or Jev's thresholds.
- **Retries.** Templates and nodes that keep retrying, and the edges that cause it.
- **Budgets.** Cost per task and per run, by template, to set `budgets` from real numbers.
- **Errors.** The top error shapes are the first bugs to fix.
- **Capacity.** Peak jobs and worktrees, to set `concurrency`.
