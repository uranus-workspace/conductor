import type { DecisionRouter } from '../adapters/decision/router.ts'
import type { Board } from '../adapters/task-source/board.types.ts'
import type { ConductorConfig } from '../core/config.types.ts'
import type { Conductor } from '../core/conductor.ts'
import type { Host } from '../core/host.types.ts'

/** What the mod builds for a session (on start, and again when the OpenRouter key changes). */
export interface SessionSetup {
  host: Host
  /** The project's own config, before the settings menu's switches. */
  projectConfig: ConductorConfig
  /** The config in force: the switches applied, the Uranus OS server resolved. */
  config: ConductorConfig
  conductor: Conductor
  router: DecisionRouter
  /** The board the task source writes through; undefined for the local file. */
  board: Board | undefined
  /** The session's tool names when it was set up (servers were resolved from them). */
  toolNames: readonly string[]
}
