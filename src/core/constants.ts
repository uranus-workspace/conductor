import type { TaskStatus, Tier, WorkerId } from './domain.types.ts'

export const WORKERS: readonly WorkerId[] = ['claude', 'codex', 'opencode', 'cursor', 'antigravity', 'openrouter']

/** Workers whose CLI can send its model calls through OpenRouter. */
export const OPENROUTER_CAPABLE: readonly WorkerId[] = ['claude', 'codex', 'opencode', 'openrouter']

export const TIERS: readonly Tier[] = ['cheap', 'standard', 'strong']

export const TERMINAL: readonly TaskStatus[] = ['merged', 'cancelled']
