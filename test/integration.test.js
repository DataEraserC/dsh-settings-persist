/**
 * Integration smoke test: boots the plugin against a mocked cordis context +
 * ConfigEditor inside a temp $DSH_HOME, then drives the boot restore and all
 * six routes end-to-end. Covers the v1 → v2 legacy migration and the v2
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
async function makeHarness({ documentText, fingerprint, legacyState = null, withCommands = true }) {
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
  const commands = new Map()
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

  // The plugin reaches the command registry through ctx.reflect.get, not by
  // naming `commands` in `inject`, so the stub has to model that path.
  const commandSink = { register: (command) => commands.set(command.name, command) }
  const sctx = {
    logger,
    configEditor,
    events,
    reflect: { get: (name) => (withCommands && name === 'commands' ? commandSink : undefined) },
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
    const qIndex = routePath.indexOf('?')
    const barePath = qIndex >= 0 ? routePath.slice(0, qIndex) : routePath
    const handler = routes.get(barePath)
    assert.ok(handler, `route ${barePath} registered`)
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

  // Startup is async, so the command may not be there the instant apply() returns.
  const slash = async (raw) => {
    await waitFor(() => commands.has('snapshots'))
    return commands.get('snapshots').handler({ rawInput: raw })
  }

  return {
    root,
    profileDir,
    documentPath,
    routes,
    commands,
    slash,
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
    await waitFor(() => harness.routes.size >= 6)
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
    await waitFor(() => harness.routes.size >= 6)
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
    await waitFor(() => harness.routes.size >= 6)
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
    await waitFor(() => harness.routes.size >= 6)
    harness.trigger('app-boot/config-reload')
    await sleep(80)
    assert.deepEqual(harness.edits, [], 'no replay when documents match')
    const view = await harness.call('/settings-persist/state', 'GET')
    assert.equal(view.body.auto.matchesCurrent, true)
  } finally {
    harness.dispose()
  }
})

test('document route: preview payloads for current / auto / snapshot / bad ids', async () => {
  const harness = await makeHarness({
    documentText: 'LIVE-DOC\n',
    fingerprint: 'fp-1\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'USER-EDIT\n',
      rows: [
        { id: 'x', name: 'x', config: { a: 1 } },
        { id: 'y', name: 'y', config: { b: 2 } },
      ],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 6)
    harness.trigger('app-boot/config-reload')
    await waitFor(async () => {
      const view = await harness.call('/settings-persist/state', 'GET')
      return view.body.auto !== null && view.body.auto.matchesCurrent
    })

    // current: raw live document + rows from configuration()
    const current = await harness.call('/settings-persist/document?id=current', 'GET')
    assert.equal(current.status, 200)
    assert.equal(current.body.text, await harness.readDocument())
    assert.deepEqual(current.body.rows.map((row) => row.id).sort(), ['x', 'y'])

    // auto: the auto backup payload
    const auto = await harness.call('/settings-persist/document?id=auto', 'GET')
    assert.equal(auto.status, 200)
    assert.equal(auto.body.text, JSON.parse(await readFile(harness.statePath, 'utf8')).documentText)

    // a manual snapshot payload
    const created = await harness.call('/settings-persist/snapshot', 'POST', { name: 'p' })
    const snapId = created.body.snapshot.id
    const snap = await harness.call(`/settings-persist/document?id=${snapId}`, 'GET')
    assert.equal(snap.status, 200)
    assert.equal(snap.body.rows.length, 2)

    // guards
    assert.equal((await harness.call('/settings-persist/document?id=../evil', 'GET')).status, 400)
    assert.equal((await harness.call('/settings-persist/document?id=nope', 'GET')).status, 404)
  } finally {
    harness.dispose()
  }
})

test('selective restore (merge): only requested row ids are applied', async () => {
  const harness = await makeHarness({
    documentText: 'LIVE-DOC\n',
    fingerprint: 'fp-1\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'USER-EDIT\n',
      rows: [
        { id: 'x', name: 'x', config: { a: 1 } },
        { id: 'y', name: 'y', config: { b: 2 } },
      ],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 6)
    harness.trigger('app-boot/config-reload')
    await waitFor(async () => {
      const view = await harness.call('/settings-persist/state', 'GET')
      return view.body.auto !== null && view.body.auto.matchesCurrent
    })
    assert.deepEqual(harness.edits, ['x', 'y'], 'boot replayed both rows')

    const created = await harness.call('/settings-persist/snapshot', 'POST', {})
    const snapId = created.body.snapshot.id
    assert.equal(created.body.snapshot.rowCount, 2)

    // Merge only row x: y must not be replayed.
    await writeFile(harness.documentPath, 'MUTATED-DOC\n')
    const before = harness.edits.length
    const merged = await harness.call('/settings-persist/restore', 'POST', { id: snapId, only: ['x'] })
    assert.equal(merged.status, 200)
    assert.equal(merged.body.applied, 1)
    assert.deepEqual(harness.edits.slice(before), ['x'])
    assert.deepEqual(harness.getApplied().get('y'), { b: 2 }, 'y untouched')

    // Requesting only rows that do not exist is rejected.
    const ghost = await harness.call('/settings-persist/restore', 'POST', { id: snapId, only: ['ghost'] })
    assert.equal(ghost.status, 400)
  } finally {
    harness.dispose()
  }
})

test('the snapshots command saves, lists, shows, restores and deletes', async () => {
  const harness = await makeHarness({
    documentText: 'LIVE-DOC\n',
    fingerprint: 'fp-1\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'USER-EDIT\n',
      rows: [{ id: 'x', name: 'x', config: { a: 1 } }],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 6)
    harness.trigger('app-boot/config-reload')
    await waitFor(async () => {
      const view = await harness.call('/settings-persist/state', 'GET')
      return view.body.auto !== null && view.body.auto.matchesCurrent
    })

    const saved = await harness.slash('save before the experiment')
    assert.equal(saved.kind, 'success')
    const snapshotId = saved.text.slice('Saved '.length).split(' ')[0]

    const listed = await harness.slash('list')
    assert.equal(listed.kind, 'success')
    assert.ok(listed.text.includes(snapshotId), 'the new snapshot is listed')
    assert.ok(listed.text.includes('before the experiment'), 'and carries its name')

    const shown = await harness.slash(`show ${snapshotId}`)
    assert.equal(shown.kind, 'success')
    assert.match(shown.text, /1 rows/)
    assert.match(shown.text, / {2}x \(x\)/)

    await writeFile(harness.documentPath, 'MUTATED-DOC\n')
    const before = harness.edits.length
    const restored = await harness.slash(`restore ${snapshotId}`)
    assert.equal(restored.kind, 'success')
    assert.match(restored.text, /1 applied, 0 failed/)
    assert.deepEqual(harness.edits.slice(before), ['x'])

    const deleted = await harness.slash(`delete ${snapshotId}`)
    assert.equal(deleted.kind, 'success')
    assert.ok((await harness.slash('list')).text.includes('no manual snapshots'))
  } finally {
    harness.dispose()
  }
})

test('the command and the routes are one implementation, not two', async () => {
  // The TUI and the settings page must never drift: whatever one saves, the
  // other has to see. They share the functions, but that is exactly the kind
  // of sharing a rewrite breaks while both sides still pass their own tests.
  const harness = await makeHarness({
    documentText: 'LIVE-DOC\n',
    fingerprint: 'fp-1\n',
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'USER-EDIT\n',
      rows: [{ id: 'x', name: 'x', config: { a: 1 } }],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 6)
    harness.trigger('app-boot/config-reload')
    await waitFor(async () => {
      const view = await harness.call('/settings-persist/state', 'GET')
      return view.body.auto !== null && view.body.auto.matchesCurrent
    })

    const viaCommand = (await harness.slash('save made by the command')).text.slice('Saved '.length).split(' ')[0]
    const state = await harness.call('/settings-persist/state', 'GET')
    assert.ok(
      state.body.snapshots.some((snapshot) => snapshot.id === viaCommand),
      'the route sees what the command saved',
    )

    const viaRoute = await harness.call('/settings-persist/snapshot', 'POST', { name: 'made by the route' })
    assert.ok(
      (await harness.slash('list')).text.includes(viaRoute.body.snapshot.id),
      'the command sees what the route saved',
    )

    // And the shared reset-auto: the route's behaviour is the command's.
    await writeFile(harness.documentPath, 'MUTATED-DOC\n')
    assert.equal((await harness.slash('reset-auto')).kind, 'success')
    const after = await harness.call('/settings-persist/state', 'GET')
    assert.equal(after.body.auto.matchesCurrent, true)
  } finally {
    harness.dispose()
  }
})

test('the snapshots command rejects what it cannot do', async () => {
  const harness = await makeHarness({ documentText: 'LIVE-DOC\n', fingerprint: 'fp-1\n' })
  try {
    await waitFor(() => harness.routes.size >= 6)
    assert.equal((await harness.slash('bogus')).kind, 'error')
    assert.match((await harness.slash('bogus')).text, /unknown subcommand "bogus"/)
    assert.match((await harness.slash('restore')).text, /usage: \/snapshots restore/)
    assert.match((await harness.slash('delete')).text, /usage: \/snapshots delete/)
    assert.equal((await harness.slash('delete ../escape')).kind, 'error')
    assert.match((await harness.slash('restore does-not-exist')).text, /snapshot not found|bad snapshot id/)
  } finally {
    harness.dispose()
  }
})

test('the plugin still starts when the harness has no command service', async () => {
  // ctx.reflect.get('commands') returning undefined must cost the /snapshots
  // command and nothing else — the boot restore is the plugin's actual job.
  const harness = await makeHarness({
    documentText: 'NIX-REVERTED\n',
    fingerprint: 'fp-1\n',
    withCommands: false,
    legacyState: {
      schema: 1,
      profile: 'test-profile',
      fingerprint: 'fp-1',
      documentText: 'USER-EDIT\n',
      rows: [{ id: 'x', name: 'x', config: { a: 1 } }],
    },
  })
  try {
    await waitFor(() => harness.routes.size >= 6)
    harness.trigger('app-boot/config-reload')
    await waitFor(() => harness.edits.includes('x'))
    assert.equal(harness.commands.size, 0, 'no command was registered')
    assert.deepEqual(harness.edits, ['x'], 'the boot restore still ran')
  } finally {
    harness.dispose()
  }
})
