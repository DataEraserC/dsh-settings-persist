import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { buildRestorePlan, captureRows, decideAction, statePathFor } from '../lib/index.js'

const state = (over = {}) => ({
  schema: 1,
  profile: 'nix-web-qq',
  fingerprint: 'fp-a',
  documentText: 'doc-a',
  rows: [{ id: 'opencode2dsh', config: { ipPool: { enabled: true } } }],
  ...over,
})

test('decideAction: missing state adopts', () => {
  assert.equal(decideAction({ state: null, currentFingerprint: 'fp', currentText: 'x', bootMode: true }), 'adopt')
  assert.equal(decideAction({ state: undefined, currentFingerprint: 'fp', currentText: 'x', bootMode: false }), 'adopt')
})

test('decideAction: unknown schema adopts (self-heal on format change)', () => {
  const stale = state({ schema: 2 })
  assert.equal(decideAction({ state: stale, currentFingerprint: 'fp-a', currentText: 'doc-a', bootMode: false }), 'adopt')
})

test('decideAction: boot + fingerprint match + text differs → restore', () => {
  const action = decideAction({ state: state(), currentFingerprint: 'fp-a', currentText: 'reverted', bootMode: true })
  assert.equal(action, 'restore')
})

test('decideAction: boot + no drift → noop', () => {
  const action = decideAction({ state: state(), currentFingerprint: 'fp-a', currentText: 'doc-a', bootMode: true })
  assert.equal(action, 'noop')
})

test('decideAction: boot + nix fingerprint changed → nix wins (adopt)', () => {
  const action = decideAction({ state: state(), currentFingerprint: 'fp-b', currentText: 'reverted', bootMode: true })
  assert.equal(action, 'adopt')
})

test('decideAction: live edit (outside boot) → adopt, never restore', () => {
  const action = decideAction({ state: state(), currentFingerprint: 'fp-a', currentText: 'user-save', bootMode: false })
  assert.equal(action, 'adopt')
})

test('decideAction: live fingerprint change → adopt', () => {
  const action = decideAction({ state: state(), currentFingerprint: 'fp-b', currentText: 'doc-a', bootMode: false })
  assert.equal(action, 'adopt')
})

test('decideAction: live no drift → noop', () => {
  const action = decideAction({ state: state(), currentFingerprint: 'fp-a', currentText: 'doc-a', bootMode: false })
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

test('statePathFor derives $DSH_HOME/settings-persist/<key>.json', () => {
  const documentPath = '/home/u/.dsh/profiles/nix-web-qq/cordis.patch.yml'
  assert.equal(statePathFor(documentPath), path.join('/home/u/.dsh', 'settings-persist', 'nix-web-qq.json'))
})
