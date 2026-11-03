import type { Host } from './host.types.ts'
import type { JobSpec, JobState } from './jobs.types.ts'
import { iso } from './time.ts'
import type { Job } from './domain.types.ts'

const script = (host: Host) => `${host.pluginRoot}/scripts/job.sh`

export async function startJob(host: Host, spec: JobSpec): Promise<Job> {
  const argv = ['/bin/sh', script(host), 'start', spec.dir, spec.cwd]
  for (const name of spec.unset ?? []) argv.push('--unset', name)
  if (spec.pre) argv.push('--pre', spec.pre)
  argv.push('--', ...spec.argv)
  const out = await host.run(argv, { env: spec.env, timeoutMs: 30_000 })
  const pid = Number.parseInt(out.stdout.trim(), 10)
  if (out.exitCode !== 0 || !Number.isFinite(pid)) {
    throw new Error(`job.sh start failed (${out.exitCode}): ${out.stderr.trim() || out.stdout.trim()}`)
  }
  return { kind: spec.kind, dir: spec.dir, pid, startedAt: iso(await host.now()), timeoutMs: spec.timeoutMs }
}

export async function pollJob(host: Host, job: Job): Promise<JobState> {
  const exit = await host.read(`${job.dir}/exit`)
  if (exit !== undefined && exit.trim() !== '') {
    return { state: 'exited', exitCode: Number.parseInt(exit.trim(), 10) }
  }
  const alive = await host.run(['/bin/sh', script(host), 'alive', String(job.pid)])
  if (alive.exitCode !== 0) {
    // The exit file is written right before the process ends: read it once more.
    const late = await host.read(`${job.dir}/exit`)
    if (late !== undefined && late.trim() !== '') return { state: 'exited', exitCode: Number.parseInt(late.trim(), 10) }
    return { state: 'lost' }
  }
  const elapsed = (await host.now()) - Date.parse(job.startedAt)
  return elapsed > job.timeoutMs ? { state: 'timeout' } : { state: 'running' }
}

export async function killJob(host: Host, job: Job): Promise<void> {
  await host.run(['/bin/sh', script(host), 'kill', String(job.pid)])
}

/** The last `max` characters of a job file, for notes and the maestro. */
export async function tail(host: Host, path: string, max = 1500): Promise<string> {
  const text = (await host.read(path)) ?? ''
  return text.length > max ? `…${text.slice(-max)}` : text
}
