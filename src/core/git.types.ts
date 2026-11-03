/** A merge into the integration branch: done, or aborted on a conflict (the files in conflict). */
export type MergeOutcome = { ok: true } | { ok: false; conflict: string }
