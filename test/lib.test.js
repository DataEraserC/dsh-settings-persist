import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  autoPathFor,
  buildRestorePlan,
  captureRows,
  decideAction,
  isSnapshotId,
  profileKeyFor,
  snapshotMeta,
  snapshotsDirFor,
  statePathFor,
} from '../lib/index.js'

const state = (over = {}) => ({
  schema: 1,
  profile: 'nix-web-qq',
  source: 'auto',
  fingerprint: 'fp-a',
  documentText: 'doc-a',
  rows: [{ id: 'opencode2dsh', config: { ipPool: { enabled: true } } }],
  ...over,
})

test('decideAction: missing state adopts', () => {
  assert.equal(decideAction({ state: null, currentText: 'x', bootMode: true }), 'adopt')
  assert.equal(decideAction({ state: undefined, currentText: 'x', bootMode: false }), 'adopt')
})

test('decideAction: unknown schema adopts (self-heal on format change)', () => {
  const stale = state({ schema: 2 })
  assert.equal(decideAction({ state: stale, currentText: 'doc-a', bootMode: false }), 'adopt')
})

test('decideAction: non-string documentText adopts', () => {
  const broken = state({ documentText: null })
  assert.equal(decideAction({ state: broken, currentText: 'doc-a', bootMode: true }), 'adopt')
})

test('decideAction: boot + text differs → restore', () => {
  const action = decideAction({ state: state(), currentText: 'reverted', bootMode: true })
  assert.equal(action, 'restore')
})

test('decideAction: boot + fingerprint rotated (nix rebuild) still restores', () => {
  // The v1 fingerprint gate adopted here and discarded the user's settings;
  // v2 must replay the auto backup regardless of the fingerprint.
  const rotated = state({ fingerprint: 'fp-old-before-rebuild' })
  const action = decideAction({ state: rotated, currentText: 'rebuilt-doc', bootMode: true })
  assert.equal(action, 'restore')
})

test('decideAction: boot + no drift → noop', () => {
  const action = decideAction({ state: state(), currentText: 'doc-a', bootMode: true })
  assert.equal(action, 'noop')
})

test('decideAction: live edit (outside boot) → adopt, never restore', () => {
  const action = decideAction({ state: state(), currentText: 'user-save', bootMode: false })
  assert.equal(action, 'adopt')
})

test('decideAction: live no drift → noop', () => {
  const action = decideAction({ state: state(), currentText: 'doc-a', bootMode: false })
  assert.equal(action, 'noop')
})

test('captureRows keeps only non-empty config overrides', () => {
  const configuration = [
    { entry: { options: { id: 'opencode2dsh', name: '@opencode2dsh/dsh-plugin' } }, override: { ipPool: { enabled: true } } },
    { entry: { options: { id: 'nameOnly', name: 'pkg' } }, override: {} },
    { entry: { options: { id: '' } }, override: { a: 1 } },
    { entry: {}, override: { a: 1 } },
    { entry: { options: { id: 'nulled', name: 'pkg' } }, override: null },
  ]
  assert.deepEqual(captureRows(configuration), [
    { id: 'opencode2dsh', name: '@opencode2dsh/dsh-plugin', config: { ipPool: { enabled: true } } },
  ])
  assert.deepEqual(captureRows(undefined), [])
})

test('buildRestorePlan matches by id and reports missing entries', () => {
  const entries = [{ options: { id: 'opencode2dsh' } }, { options: { id: 'navbar' } }]
  const rows = [
    { id: 'opencode2dsh', config: { a: 1 } },
    { id: 'ghost', config: { b: 2 } },
    { id: 'navbar', config: { c: 3 } },
  ]
  const { plan, missing } = buildRestorePlan(rows, entries)
  assert.deepEqual(
    plan.map((item) => item.id),
    ['opencode2dsh', 'navbar'],
  )
  assert.deepEqual(missing, ['ghost'])
  assert.equal(plan[0].entry, entries[0])
})

test('buildRestorePlan tolerates empty input', () => {
  assert.deepEqual(buildRestorePlan(undefined, undefined), { plan: [], missing: [] })
})

const documentPath = '/home/u/.dsh/profiles/nix-web-qq/cordis.patch.yml'

test('profileKeyFor derives the profile directory name', () => {
  assert.equal(profileKeyFor(documentPath), 'nix-web-qq')
})

test('statePathFor derives the legacy flat file (migration source)', () => {
  assert.equal(statePathFor(documentPath), path.join('/home/u/.dsh', 'settings-persist', 'nix-web-qq.json'))
})

test('autoPathFor derives the v2 auto backup path', () => {
  assert.equal(
    autoPathFor(documentPath),
    path.join('/home/u/.dsh', 'settings-persist', 'nix-web-qq', 'auto.json'),
  )
})

test('snapshotsDirFor derives the manual snapshots directory', () => {
  assert.equal(
    snapshotsDirFor(documentPath),
    path.join('/home/u/.dsh', 'settings-persist', 'nix-web-qq', 'snapshots'),
  )
})

test('isSnapshotId accepts ids and rejects traversal/invalid names', () => {
  assert.equal(isSnapshotId('2026-09-29T16-00-00-000Z'), true)
  assert.equal(isSnapshotId('auto-ish_name.v2'), true)
  assert.equal(isSnapshotId('../auto'), false)
  assert.equal(isSnapshotId('a/b'), false)
  assert.equal(isSnapshotId(''), false)
  assert.equal(isSnapshotId(null), false)
  assert.equal(isSnapshotId('x'.repeat(100)), false)
})

test('snapshotMeta reports inventory without leaking documentText', () => {
  const meta = snapshotMeta(
    state({ source: 'manual', name: 'pre-rebuild', updatedAt: '2026-09-29T00:00:00.000Z' }),
    '2026-09-29T00-00-00-000Z',
  )
  assert.deepEqual(meta, {
    id: '2026-09-29T00-00-00-000Z',
    source: 'manual',
    name: 'pre-rebuild',
    updatedAt: '2026-09-29T00:00:00.000Z',
    fingerprint: 'fp-a',
    rowCount: 1,
    bytes: Buffer.byteLength('doc-a', 'utf8'),
  })
  assert.equal('documentText' in meta, false)
})

test('snapshotMeta defaults source to auto for v1 files', () => {
  const meta = snapshotMeta({ schema: 1, fingerprint: '', documentText: 'x', rows: [] }, 'auto')
  assert.equal(meta.source, 'auto')
  assert.equal(meta.name, null)
})
