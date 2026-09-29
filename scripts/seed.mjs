#!/usr/bin/env node
/**
 * Seed $DSH_HOME/settings-persist/<key>/auto.json from the CURRENT live
 * profile document. Run this once, before the first dsh launch that has
 * dsh-settings-persist deployed — at that point dsh-sync-profiles will have
 * already reverted the document, and the plugin could only adopt the empty
 * snapshot.
 *
 * Usage:
 *   node scripts/seed.mjs <profileDir> [--force] [--dry-run]
 *
 *   <profileDir>   e.g. ~/.dsh/profiles/nix-web-qq
 *   --force        overwrite an existing auto snapshot
 *   --dry-run      print what would be written, write nothing
 *
 * YAML parsing needs the `yaml` package: either `npm install` inside the
 * repo, or set DSH_KERNEL_NM=<dsh>/lib/deepseek-harness/node_modules so the
 * seed script borrows the kernel's copy.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const SCHEMA = 1

function die(message) {
  console.error(`seed: ${message}`)
  process.exit(1)
}

async function loadYaml() {
  const anchors = [path.join(process.cwd(), 'seed-anchor.js')]
  if (process.env.DSH_KERNEL_NM) anchors.push(path.join(process.env.DSH_KERNEL_NM, 'seed-anchor.js'))
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const yaml = require('yaml')
      if (yaml && typeof yaml.parse === 'function') return yaml
    } catch {
      // try the next anchor
    }
  }
  die('cannot resolve the "yaml" package: run `npm install` in the repo, or set DSH_KERNEL_NM=<dsh>/lib/deepseek-harness/node_modules')
}

function normalizeRow(row, warns) {
  if (!row || typeof row !== 'object') return null
  if (Array.isArray(row.insert)) {
    const rows = []
    for (const item of row.insert) {
      const normalized = normalizeRow(item, warns)
      if (normalized) rows.push(normalized)
    }
    return rows.length > 0 ? rows : null
  }
  if (typeof row.id !== 'string' || row.id.length === 0) {
    warns.push(`skipping unrecognized row shape: ${JSON.stringify(row).slice(0, 120)}`)
    return null
  }
  const config = row.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null
  if (Object.keys(config).length === 0) return null
  return { id: row.id, name: typeof row.name === 'string' ? row.name : undefined, config }
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const dryRun = args.includes('--dry-run')
const positional = args.filter((arg) => !arg.startsWith('--'))
if (positional.length !== 1) die('usage: node scripts/seed.mjs <profileDir> [--force] [--dry-run]')
const profileDir = path.resolve(positional[0])

const documentPath = path.join(profileDir, 'cordis.patch.yml')
const fingerprintPath = path.join(profileDir, '.nix-managed')
const profileKey = path.basename(profileDir)
const statePath = path.join(path.dirname(path.dirname(profileDir)), 'settings-persist', profileKey, 'auto.json')

let documentText
try {
  documentText = await readFile(documentPath, 'utf8')
} catch {
  die(`cannot read ${documentPath}`)
}
let fingerprint = ''
try {
  fingerprint = await readFile(fingerprintPath, 'utf8')
} catch {
  console.warn(`seed: warning: ${fingerprintPath} missing (unmanaged profile?) — storing an empty fingerprint`)
}

const { parse } = await loadYaml()
let document
try {
  document = parse(documentText)
} catch (error) {
  die(`cannot parse ${documentPath}: ${error instanceof Error ? error.message : String(error)}`)
}
if (!Array.isArray(document)) die(`${documentPath} is not a YAML list of patch rows`)

const warns = []
const rows = []
for (const row of document) {
  const normalized = normalizeRow(row, warns)
  if (Array.isArray(normalized)) rows.push(...normalized)
  else if (normalized) rows.push(normalized)
}
for (const warn of warns) console.warn(`seed: warning: ${warn}`)

let existing = null
try {
  existing = JSON.parse(await readFile(statePath, 'utf8'))
} catch {
  // no state yet
}
if (existing && !force) die(`${statePath} already exists — pass --force to overwrite`)

const state = {
  schema: SCHEMA,
  profile: profileKey,
  source: 'auto',
  fingerprint,
  documentText,
  rows,
  updatedAt: new Date().toISOString(),
  seededAt: new Date().toISOString(),
  seededBy: 'dsh-settings-persist/scripts/seed.mjs',
}

console.log(`profile:      ${profileKey}`)
console.log(`document:     ${documentPath} (${documentText.length} bytes)`)
console.log(`fingerprint:  ${fingerprint ? `${fingerprint.split('\n').length} line(s)` : '(empty)'}`)
console.log(`rows:         ${rows.length > 0 ? rows.map((row) => row.id).join(', ') : '(none)'}`)
console.log(`state file:   ${statePath}`)

if (dryRun) {
  console.log('dry-run: nothing written')
  process.exit(0)
}

await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
const tmp = `${statePath}.${process.pid}.tmp`
await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
await rename(tmp, statePath)
await chmod(statePath, 0o600)
console.log('seeded: auto snapshot written — safe to deploy and restart dsh')
