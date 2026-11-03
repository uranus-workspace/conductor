/** What `/conduct plan` asks the maestro to do. */
export function planningPrompt(runId: string, goal: string): string {
  return `[conductor] Plan run ${runId}.

Goal: ${goal}

Break the goal into tasks for parallel workers, following the conductor skill. Read the code you need first. Then call the tool \`conductor_plan\` once with runId "${runId}" and the tasks:
- each task small enough for one worker in one worktree (under ~15 minutes of work),
- a stable \`key\` per task, \`dependsOn\` naming other tasks' keys,
- concrete, verifiable \`acceptance\` criteria,
- the \`files\` each task will most likely touch (tasks that run in parallel should not share files),
- \`labels\` such as "executor:claude" only when you are sure who must do it.
Keep for yourself (label "executor:claude") anything that needs architecture or product judgment.
Do not implement the tasks yourself.`
}
