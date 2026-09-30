/**
 * Client-half tests: boot lib/client.js in a vm with a stubbed module
 * loader + cordis context, then assert the Plugins-page row registration
 * (plugins.row.config keys, summary/page views) and the spec-guarded
 * legacy plugins.item fallback — the dsh-bas-remote pattern.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Execute the classic script and return { moduleExports, injections }. */
function loadClient({ rowConfigSlot } = {}) {
  let spec = null
  const window = {
    __ModuleLoader__: {
      load(s) {
        spec = s
      },
    },
  }
  vm.runInNewContext(SOURCE, { window, console }, { filename: 'client.js' })
  assert.ok(spec && typeof spec.factory === 'function', 'client registers with __ModuleLoader__')

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
  }
  const moduleExports = spec.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })

  const injections = new Map() // slot name → callback list, in order
  const slots = {
    inject(slot, cb) {
      if (!injections.has(slot)) injections.set(slot, [])
      injections.get(slot).push(cb)
    },
    register(name, component) {
      return { kind: 'registered', name, component }
    },
    // undefined = host without plugins.row.config (0.1.x); object = 0.2 host.
    spec(slot) {
      return slot === 'plugins.row.config' ? rowConfigSlot : undefined
    },
  }
  const ctx = {
    get(dep) {
      // No locale service in this harness: wireLocale falls back to tr().
      if (dep === 'slots') return slots
      return undefined
    },
    effect() {},
  }
  moduleExports.apply(ctx)
  return { moduleExports, injections }
}

/** Fire every callback registered for a slot; guard-skipped ones yield nothing. */
function fire(injections, slot) {
  const out = []
  for (const cb of injections.get(slot) || []) {
    const res = cb()
    if (res !== undefined) out.push(res)
  }
  return out
}

test('plugins.row.config registers both bundle×row-id keys', () => {
  const { injections } = loadClient()
  const regs = fire(injections, 'plugins.row.config')
  assert.equal(regs.length, 2)
  assert.deepEqual(
    regs.map((r) => r.name.key),
    ['dsh-settings-persist#settingsPersist', 'dsh-settings-persist#dsh-settings-persist'],
  )
  for (const r of regs) {
    assert.equal(r.name.name, 'plugins.row.config')
    assert.equal(r.name.locale, 'dsh-settings-persist')
    assert.equal(typeof r.component, 'function')
  }
})

test('summary view renders the translated one-liner, not the raw key', () => {
  const { injections } = loadClient()
  const [{ component }] = fire(injections, 'plugins.row.config')
  for (const props of [undefined, { view: 'summary' }]) {
    const node = component(props)
    assert.equal(node.type, 'span')
    const text = node.children.join('')
    assert.ok(text.includes('持久化设置改动'), text)
    assert.ok(!text.includes('card.summary'), text)
  }
})

test('page view reuses the SnapshotPage settings body', () => {
  const { injections } = loadClient()
  const [{ component }] = fire(injections, 'plugins.row.config')
  const node = component({ view: 'page' })
  assert.equal(node.type.name, 'SnapshotPage')
})

test('legacy plugins.item registers when the host lacks plugins.row.config', () => {
  const { injections } = loadClient({ rowConfigSlot: undefined })
  const [reg] = fire(injections, 'plugins.item')
  assert.ok(reg, 'expected a plugins.item registration')
  assert.equal(reg.name.name, 'plugins.item')
  assert.equal(reg.name.id, 'dsh-settings-persist')
  assert.equal(reg.name.locale, 'dsh-settings-persist')
  const label = reg.name.label()
  assert.ok(label.includes('持久化设置改动'), label)
})

test('legacy plugins.item stays off when plugins.row.config exists', () => {
  const { injections } = loadClient({ rowConfigSlot: { kind: 'keyed', scope: 'root' } })
  assert.equal(fire(injections, 'plugins.item').length, 0)
})

test('settings.section still registers the settings entry (regression)', () => {
  const { injections } = loadClient()
  const [reg] = fire(injections, 'settings.section')
  assert.equal(reg.name.name, 'settings.section')
  assert.equal(reg.name.id, 'dsh-settings-persist')
  assert.equal(reg.name.order, 44)
  assert.equal(typeof reg.component, 'function')
})

test('card.summary exists in both locale dictionaries', () => {
  assert.equal((SOURCE.match(/'card\.summary':/g) || []).length, 2)
})
