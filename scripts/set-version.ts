// Writes the release version into the plugin manifest. semantic-release runs it in its prepare
// step; its npm step writes package.json and package-lock.json.
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.ts <version>')
  process.exit(1)
}

const path = new URL('../.claude-plugin/plugin.json', import.meta.url)
const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
  throw new Error('.claude-plugin/plugin.json is not a JSON object')
}
writeFileSync(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
