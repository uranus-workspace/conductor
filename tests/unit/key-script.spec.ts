// scripts/openrouter-key.sh on both stores: the macOS Keychain and the Linux Secret Service, each
// replaced by a fake that records its arguments, so the key is shown never to reach a command line.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/openrouter-key.sh')
const KEY = 'sk-or-v1-0123456789abcdef'

const FAKES: Record<string, string> = {
  'secret-tool': `#!/bin/sh
echo "secret-tool $*" >> "$FAKE_LOG"
case "$1" in
  store) cat > "$FAKE_STORE" ;;
  lookup) [ -f "$FAKE_STORE" ] && cat "$FAKE_STORE" || exit 1 ;;
  clear) rm -f "$FAKE_STORE" ;;
esac
`,
  security: `#!/bin/sh
echo "security $*" >> "$FAKE_LOG"
case "$1" in
  -i) cat | sed -n 's/.* -w "\\([^"]*\\)".*/\\1/p' | tr -d '\\n' > "$FAKE_STORE" ;;
  find-generic-password) [ -f "$FAKE_STORE" ] || exit 44; case "$*" in *-w*) cat "$FAKE_STORE"; echo ;; esac ;;
  delete-generic-password) [ -f "$FAKE_STORE" ] || exit 44; rm -f "$FAKE_STORE" ;;
esac
`,
  zenity: `#!/bin/sh
echo "zenity $*" >> "$FAKE_LOG"
[ -n "\${FAKE_DIALOG:-}" ] || exit 1
printf '%s\\n' "$FAKE_DIALOG"
`,
}

interface Sandbox {
  env: NodeJS.ProcessEnv
  store: string
  log: () => string
}

function sandbox(store: 'keychain' | 'secret-service', extra: NodeJS.ProcessEnv = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-key-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const logFile = join(dir, 'calls.log')
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: dir,
    USER: 'tester',
    CONDUCTOR_KEY_STORE: store,
    CONDUCTOR_KEYCHAIN_SERVICE: 'conductor.test',
    FAKE_STORE: join(dir, 'secret'),
    FAKE_LOG: logFile,
    ...extra,
  }
  return { env, store: join(dir, 'secret'), log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '') }
}

/** Runs the script in a session of its own (no controlling terminal), as the mod does. */
function run(env: NodeJS.ProcessEnv, args: string[], input = ''): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, fail) => {
    // No stdin pipe unless there is input: a command that never reads it may exit before the write (EPIPE).
    const child = spawn('/bin/sh', [script, ...args], { env, detached: true, stdio: [input === '' ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', d => (out += d))
    child.stderr?.on('data', d => (err += d))
    child.on('error', fail)
    child.on('close', code => done({ code: code ?? -1, out: out.trim(), err: err.trim() }))
    if (child.stdin) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
    }
  })
}

describe('the OpenRouter key script', () => {
  for (const store of ['secret-service', 'keychain'] as const) {
    it(`${store}: saves, reads, reports and deletes the key, which never reaches a command line`, async () => {
      const box = sandbox(store, { CONDUCTOR_KEY_FROM_STDIN: '1' })
      assert.equal((await run(box.env, ['status'])).out, 'unset')
      const saved = await run(box.env, ['set'], `  ${KEY}\n`)
      assert.equal(saved.code, 0, saved.err)
      assert.equal(saved.out, 'saved')
      assert.equal(readFileSync(box.store, 'utf8'), KEY, 'stored trimmed')
      assert.equal((await run(box.env, ['get'])).out, KEY)
      assert.equal((await run(box.env, ['status'])).out, 'set')
      assert.equal((await run(box.env, ['where'])).out, store === 'keychain' ? 'the macOS Keychain' : 'the system keyring (Secret Service)')
      assert.equal((await run(box.env, ['delete'])).out, 'deleted')
      assert.equal((await run(box.env, ['status'])).out, 'unset')
      assert.equal((await run(box.env, ['delete'])).out, 'unset')
      assert.ok(box.log().length > 0)
      assert.ok(!box.log().includes(KEY), 'the key was on a command line')
    })
  }

  it('secret-service: a Linux desktop asks in a zenity dialog', async () => {
    const box = sandbox('secret-service', { DISPLAY: ':0', FAKE_DIALOG: KEY })
    const saved = await run(box.env, ['set'])
    assert.equal(saved.code, 0, saved.err)
    assert.match(box.log(), /zenity --password/)
    assert.equal(readFileSync(box.store, 'utf8'), KEY)
  })

  it('a cancelled dialog saves nothing', async () => {
    const box = sandbox('secret-service', { DISPLAY: ':0' })
    const res = await run(box.env, ['set'])
    assert.equal(res.code, 1)
    assert.equal(res.err, 'cancelled')
    assert.equal(existsSync(box.store), false)
  })

  it('with no dialog and no terminal, it says which command to run instead', async () => {
    const box = sandbox('secret-service')
    const res = await run(box.env, ['set'])
    assert.equal(res.code, 5)
    assert.match(res.err, /run "sh .*openrouter-key\.sh set" in a terminal, or set OPENROUTER_API_KEY/)
    assert.equal(existsSync(box.store), false)
  })

  it('refuses what is not an OpenRouter key', async () => {
    const box = sandbox('secret-service', { CONDUCTOR_KEY_FROM_STDIN: '1' })
    const res = await run(box.env, ['set'], 'sk-ant-not-openrouter\n')
    assert.equal(res.code, 2)
    assert.match(res.err, /starts with sk-or-/)
    assert.equal(existsSync(box.store), false)
  })

  it('without secret-tool, it points to the package and to OPENROUTER_API_KEY', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'conductor-key-empty-'))
    const res = await run({ PATH: empty, CONDUCTOR_KEY_STORE: 'secret-service' }, ['get'])
    assert.equal(res.code, 4)
    assert.match(res.err, /libsecret-tools/)
    assert.match(res.err, /OPENROUTER_API_KEY/)
  })
})
