/**
 * Integration smoke test: boots the plugin against a mocked cordis context +
 * ConfigEditor inside a temp $DSH_HOME, then drives the boot restore and all
 * five routes end-to-end. Covers the v1 → v2 legacy migration and the v2
 * core guarantee — a rotated .nix-managed fingerprint (nix rebuild) must NOT
 * discard the user's auto backup.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(20)
  }
  throw new Error('waitFor: condition not met in time')
}

/** Build a temp profile tree + plugin harness. */
async function makeHarness({ documentText, fingerprint, legacyState = null }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-sp-'))
  const profileDir = path.join(root, 'profiles', 'test-profile')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), documentText)
  if (fingerprint !== null) {
    await writeFile(path.join(profileDir, '.nix-managed'), fingerprint)
  }
  if (legacyState) {
    await mkdir(path.join(root, 'settings-persist'), { recursive: true, mode: 0o700 })
    await writeFile(path.join(root, 'settings-persist', 'test-profile.json'), JSON.stringify(legacyState), {
      mode: 0o600,
    })
  }

  const documentPath = path.join(profileDir, 'cordis.patch.yml')
  const routes = new Map()
  const events = new Map()
  const edits = []
  let applied = new Map() // id → config, as the real ConfigEditor would hold

  const configEditor = {
    documentPath,
    configuration() {
      return [...applied].map(([id, config]) => ({ entry: { options: { id, name: id } }, override: config }))
    },
    entries() {
      return [
        { options: { id: 'x' } },
        { options: { id: 'y' } },
      ]
    },
    async edit(entry, factory) {
      const config = factory()
      const id = entry.options.id
      applied.set(id, config)
      edits.push(id)
      // Simulate the reconcile writing into the document.
      const current = await readFile(documentPath, 'utf8')
      const line = `# applied ${id}: ${JSON.stringify(config)}\n`
      if (!current.includes(line)) await writeFile(documentPath, current + line)
    },
  }

  const logger = { info() {}, warn() {}, error() {} }

  const inner = (servicesMap) => ({
    get(name) { return servicesMap[name] },
    effect(factory) { const dispose = factory(); return dispose },
    inject(names, cb) { cb(this) },
    on() {},
  })

  const sctx = {
    logger,
    configEditor,
    events,
    on(event, cb) { events.set(event, cb) },
    effect(factory) { const dispose = factory(); return dispose },
    inject(names, cb) {
      if (names[0] === 'webServer') {
        cb(inner({
          webServer: {
            register({ path: p, handler }) {
              routes.set(p, handler)
              return () => routes.delete(p)
            },
          },
        }))
        return
      }
      if (names[0] === 'connection') {
        cb(inner({ connection: {} })) // no connection carrier in tests
        return
      }
      throw new Error(`unexpected inject: ${names.join(',')}`)
    },
  }

  const ctx = {
    inject(names, cb) { if (names[0] === 'configEditor') cb(sctx) },
  }

  apply(ctx)

  const call = async (routePath, method, body) => {
    const handler = routes.get(routePath)
    assert.ok(handler, `route ${routePath} registered`)
    const req = Object.assign(
      (async function* () {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      })(),
      { method, url: routePath, headers: {} },
    )
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) { this.headers[key] = value },
      end(payload) { this.body = payload },
    }
    await handler(req, res)
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
  }

  const trigger = (event) => { const cb = events.get(event); if (cb) cb() }
  const dispose = () => { const cb = events.get('dispose'); if (cb) cb() }

  return {
    root,
    profileDir,
    documentPath,
    routes,
    edits,
    getApplied: () => applied,
    call,
    trigger,
    dispose,
    readDocument: () => readFile(documentPath, 'utf8'),
    statePath: path.join(root, 'settings-persist', 'test-profile', 'auto.json'),
    legacyPath: path.join(root, 'settings-persist', 'test-profile.json'),
    snapshotsDir: path.join(root, 'settings-persist', 'test-profile', 'snapshots'),
  }
}

test('boot: legacy v1 file migrates to auto and is replayed over a reverted document', async () => {
  const harness = await makeHarness({
    documentText: 'NIX-REVERTED\n',
    fingerprint: 'fp-1\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'USER-SETTINGS\n',
      rows: [{ id: 'x', name: 'x', config: { a: 1 } }],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 5)
    await waitFor(async () => {
      try {
        await readFile(harness.legacyPath, 'utf8')
        return false
      } catch {
        return true
      }
    }, 3000) // migration (write auto → unlink legacy) runs after routes register
    const auto = JSON.parse(await readFile(harness.statePath, 'utf8'))
    assert.equal(auto.source, 'auto')
    assert.equal(auto.documentText, 'USER-SETTINGS\n')

    harness.trigger('app-boot/config-reload')
    await waitFor(() => harness.edits.length > 0)
    assert.deepEqual(harness.edits, ['x'])
    assert.deepEqual(harness.getApplied().get('x'), { a: 1 })

    // Settled document adopted as the new auto backup.
    await waitFor(async () => {
      const autoNow = JSON.parse(await readFile(harness.statePath, 'utf8'))
      return autoNow.documentText.includes('# applied x')
    })
    const view = await harness.call('/settings-persist/state', 'GET')
    assert.equal(view.status, 200)
    assert.equal(view.body.auto.matchesCurrent, true)
    assert.equal(view.body.snapshots.length, 0)
  } finally {
    harness.dispose()
  }
})

test('boot: rotated fingerprint (nix rebuild) still restores the auto backup', async () => {
  const harness = await makeHarness({
    documentText: 'REBUILT-DOC\n',
    fingerprint: 'fp-rotated-after-rebuild\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-old',
      documentText: 'USER-SETTINGS\n',
      rows: [{ id: 'x', name: 'x', config: { a: 2 } }],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 5)
    harness.trigger('app-boot/config-reload')
    // v1 would have adopted (fingerprint mismatch → nix wins → settings lost);
    // v2 must replay the auto backup regardless of the rotated fingerprint.
    await waitFor(() => harness.edits.length > 0)
    assert.deepEqual(harness.getApplied().get('x'), { a: 2 })
  } finally {
    harness.dispose()
  }
})

test('routes: snapshot create → inventory → restore → delete → reset-auto', async () => {
  const harness = await makeHarness({
    documentText: 'LIVE-DOC\n',
    fingerprint: 'fp-1\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'USER-EDIT\n', // differs → boot restores → applied map has rows to snapshot
      rows: [{ id: 'x', name: 'x', config: { keep: true } }],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 5)
    harness.trigger('app-boot/config-reload')
    await waitFor(async () => {
      const view = await harness.call('/settings-persist/state', 'GET')
      return view.body.auto !== null && view.body.auto.matchesCurrent
    })

    // Create a manual snapshot.
    const created = await harness.call('/settings-persist/snapshot', 'POST', { name: 'before-experiment' })
    assert.equal(created.status, 200)
    assert.equal(created.body.snapshot.source, 'manual')
    assert.equal(created.body.snapshot.name, 'before-experiment')
    const files = await readdir(harness.snapshotsDir)
    assert.equal(files.length, 1)

    // Inventory lists it; auto untouched.
    const view = await harness.call('/settings-persist/state', 'GET')
    assert.equal(view.body.snapshots.length, 1)
    assert.equal(view.body.auto.id, 'auto')

    // Mutate live document, then restore the manual snapshot.
    await writeFile(harness.documentPath, 'MUTATED-DOC\n')
    const before = harness.edits.length
    const restored = await harness.call('/settings-persist/restore', 'POST', { id: view.body.snapshots[0].id })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.ok, true)
    assert.ok(harness.edits.length > before, 'restore replayed rows')
    assert.equal(restored.body.applied, 1)

    // Reject traversal ids.
    const bad = await harness.call('/settings-persist/restore', 'POST', { id: '../auto' })
    assert.equal(bad.status, 400)
    const badDelete = await harness.call('/settings-persist/delete', 'POST', { id: '../../etc' })
    assert.equal(badDelete.status, 400)

    // Delete the manual snapshot.
    const deleted = await harness.call('/settings-persist/delete', 'POST', { id: view.body.snapshots[0].id })
    assert.equal(deleted.status, 200)
    assert.equal((await readdir(harness.snapshotsDir)).length, 0)

    // reset-auto rebuilds auto from the live document.
    await harness.call('/settings-persist/reset-auto', 'POST', {})
    const auto = JSON.parse(await readFile(harness.statePath, 'utf8'))
    assert.equal(auto.documentText, await harness.readDocument())
  } finally {
    harness.dispose()
  }
})

test('boot: identical documents are a noop (no edits)', async () => {
  const harness = await makeHarness({
    documentText: 'SAME\n',
    fingerprint: 'fp-1\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'SAME\n',
      rows: [{ id: 'x', name: 'x', config: { a: 1 } }],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 5)
    harness.trigger('app-boot/config-reload')
    await sleep(80)
    assert.deepEqual(harness.edits, [], 'no replay when documents match')
    const view = await harness.call('/settings-persist/state', 'GET')
    assert.equal(view.body.auto.matchesCurrent, true)
  } finally {
    harness.dispose()
  }
})
