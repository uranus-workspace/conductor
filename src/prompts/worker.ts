import type { Task } from '../core/domain.types.ts'

const list = (items: readonly string[]) => items.map(i => `- ${i}`).join('\n')

/** The single worker template (doc §8.6): every executor gets the same brief. */
export function workerPrompt(task: Task, checks: readonly string[]): string {
  const files = task.files?.length ? list(task.files) : '- (not specified: keep the change as small as the task allows)'
  const tests = checks.length ? list(checks) : '- the project\'s own tests, if any'
  return `You are a worker in an automated software factory. Implement exactly one task in this git worktree.

## Task
${task.title}

${task.description}

## Acceptance criteria
${list(task.acceptance)}

## Files in scope
${files}
${task.notes ? `
## Notes from research (reproduction, context, design references)
${task.notes}
` : ''}
## Rules
- Do not modify files outside the scope above unless the task cannot be done otherwise; if you must, say which and why.
- Do not commit, push, create branches or deploy. Leave your changes in the working tree.
- Do not read or create .env files or any secret.
- Read and write files with your file tools, not the shell. The only shell commands to run are the checks below, exactly as written: some workers may run nothing else.
- Before finishing, run:
${tests}

## Final answer
End with a short plain-text report: what you changed (files), how you verified it (commands and results), and anything left undone.`
}

/** The adversarial reviewer brief (codex exec, read-only sandbox). */
export function reviewPrompt(task: Task, base: string, checksOutput: string): string {
  return `You are an adversarial code reviewer. The current git worktree holds a change that claims to complete the task below.
Inspect it with \`git diff ${base}...HEAD\` and by reading the files. Do not modify anything.

## Task
${task.title}

${task.description}

## Acceptance criteria
${list(task.acceptance)}

## Declared scope
${task.files?.length ? list(task.files) : '- (not specified)'}

## Deterministic checks output (tail)
${checksOutput.trim() || '(no checks configured)'}

Answer with the JSON schema you were given:
- verdict "pass": every acceptance criterion is met and nothing is broken.
- verdict "fail": a criterion is not met or the change breaks something.
- verdict "review": you cannot tell, or a human decision is needed.
List concrete issues (file:line and why).`
}

/**
 * The research node's brief: a cheap worker reads, and writes notes the implement
 * node gets. For a bugfix it reproduces the symptom; for a spike it is the work itself.
 */
export function researchPrompt(task: Task, purpose: 'reproduce' | 'investigate' | 'context'): string {
  const goal = purpose === 'reproduce'
    ? 'Reproduce the bug: find the code path, the smallest input that triggers it, and the likely cause. Do not fix it.'
    : purpose === 'investigate'
      ? 'Investigate the question below and answer it: options, trade-offs, a recommendation. Do not change any file.'
      : 'Gather the context a developer needs to implement the task below: the relevant files, functions, conventions and pitfalls. Do not change any file.'
  return `You are a researcher in an automated software factory. ${goal}

## Task
${task.title}

${task.description}

## Acceptance criteria
${list(task.acceptance)}

## Files likely involved
${task.files?.length ? list(task.files) : '- (not specified)'}

## Rules
- Read only. Do not modify, create or delete files, and do not commit.
- Do not read .env files or any secret.

## Final answer
Plain Markdown notes, under 400 words, that the next worker can act on: what you found, where (file:line), and what to do.`
}
