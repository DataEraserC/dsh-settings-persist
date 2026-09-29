// dsh-settings-persist — client half (browser).
//
// A settings section page for snapshot management: the rolling auto backup
// (replayed at boot, what keeps Settings edits alive across nix managed
// profile syncs and rebuilds) plus user-created manual snapshots with
// create / restore / delete actions.
//
// Written as a classic script following the dsh-bas-remote pattern
// (window.__ModuleLoader__.load / require('react') / inline styles with
// --dsw-alias-* tokens). No bundler required — the stable route that has
// survived dsh UI changes where slot-hopping plugins did not.

window.__ModuleLoader__.load({
  id: 'dsh-settings-persist',
  factory: (require) => {
    var React = require('react')
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var NS = 'dsh-settings-persist'
    var POLL_MS = 4000

    // ── i18n ──────────────────────────────────────────────────────────────

    var L = {
      zh: {
        'nav':           '设置快照',
        'intro':         'auto 快照在每次开机时自动恢复；手动快照只在这里管理。',
        'autoTitle':     'Auto backup（开机自动恢复）',
        'autoMissing':   '还没有 auto 快照。打开设置改动一次后会自动生成。',
        'restoreAuto':   '立即恢复',
        'resetAuto':     '用当前文档重建',
        'matches':       '与当前设置一致',
        'mismatch':      '与当前设置不同（开机时会恢复它）',
        'manualTitle':   '手动快照',
        'noManual':      '还没有手动快照。',
        'namePlaceholder': '备注（可选）',
        'create':        '创建快照',
        'restore':       '恢复',
        'delete':        '删除',
        'busy':          '处理中…',
        'rows':          '{n} 项设置',
        'bytes':         '{n}',
        'createdAt':     '创建于',
        'fingerprint':   '指纹',
        'currentFp':     '当前指纹',
        'confirmDelete': '删除这个快照？',
        'confirmRestore': '用这个快照恢复当前设置？',
        'err':           '出错',
        'restored':      '已恢复（{n} 项）',
        'missingNote':   '，{n} 项已不存在被跳过',
        'created':       '已创建',
        'deleted':       '已删除',
      },
      en: {
        'nav':           'Settings Snapshots',
        'intro':         'The auto snapshot is replayed at every boot; manual snapshots are managed here only.',
        'autoTitle':     'Auto backup (restored at boot)',
        'autoMissing':   'No auto snapshot yet. It appears after your first settings edit.',
        'restoreAuto':   'Restore now',
        'resetAuto':     'Rebuild from current',
        'matches':       'Matches current settings',
        'mismatch':      'Differs from current settings (restored at boot)',
        'manualTitle':   'Manual snapshots',
        'noManual':      'No manual snapshots yet.',
        'namePlaceholder': 'Label (optional)',
        'create':        'Create snapshot',
        'restore':       'Restore',
        'delete':        'Delete',
        'busy':          'Working…',
        'rows':          '{n} settings',
        'bytes':         '{n}',
        'createdAt':     'Created',
        'fingerprint':   'Fingerprint',
        'currentFp':     'Current fingerprint',
        'confirmDelete': 'Delete this snapshot?',
        'confirmRestore': 'Restore current settings from this snapshot?',
        'err':           'Error',
        'restored':      'Restored ({n} settings)',
        'missingNote':   ', {n} skipped (entries no longer exist)',
        'created':       'Created',
        'deleted':       'Deleted',
      },
    }

    var fallbackLang = 'zh'
    function tr(key, params) {
      var table = L[fallbackLang] || L.zh
      var raw = table[key]
      if (raw === undefined) raw = (L.zh[key] ?? L.en[key] ?? key)
      if (params) {
        raw = raw.replace(/\{(\w+)\}/g, function (_m, name) {
          return params[name] !== undefined ? String(params[name]) : '{' + name + '}'
        })
      }
      return raw
    }

    var localeDisposer = null
    var boundTr = tr
    function wireLocale(ctx) {
      var locale = ctx && ctx.get && ctx.get('locale')
      if (!locale || typeof locale.register !== 'function') return
      var dispose = locale.register(NS, { zh: L.zh, en: L.en })
      var bound = locale.bind(NS)
      boundTr = function (key, params) {
        var raw = bound(key, params)
        if (raw !== undefined) return raw
        return tr(key, params)
      }
      localeDisposer = dispose
      return dispose
    }

    // ── theme tokens (same pattern as dsh-bas-remote) ─────────────────────

    var v = function (name, fb) { return 'var(' + name + ', ' + fb + ')' }
    var T = {
      bg:         v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
      bg2:        v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.10)'),
      border:     v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      borderL3:   v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
      text:       v('--dsw-alias-label-primary', '#e0e0e0'),
      textMuted:  v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
      danger:     v('--dsw-static-red-500', '#e06c75'),
      ok:         v('--dsw-static-green-500', '#4caf7d'),
      warn:       v('--dsw-static-yellow-500', '#e6c07b'),
      radius:     8,
    }

    // ── API helper (web host path, or /api over the desktop connection) ───

    function apiPath(path) {
      return window.location && window.location.protocol === 'dsh-app:'
        ? '/api' + path : path
    }

    async function api(method, path, body) {
      var opts = { method: method, headers: {} }
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = JSON.stringify(body)
      }
      var res = await fetch(apiPath(path), opts)
      var data = await res.json().catch(function () { return {} })
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
      return data
    }

    // ── small components ──────────────────────────────────────────────────

    function Pill(props) {
      var color = props.ok === true ? T.ok : props.ok === false ? T.danger : T.warn
      return React.createElement('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          backgroundColor: color, marginRight: 6, verticalAlign: 'middle',
        },
      })
    }

    function Button(props) {
      var primary = props.variant === 'primary'
      var danger = props.variant === 'danger'
      var bg = primary ? 'rgba(59,130,246,0.18)' : danger ? 'rgba(224,108,117,0.15)' : T.bg2
      var color = primary ? '#60a5fa' : danger ? T.danger : T.text
      var border = primary ? '1px solid rgba(59,130,246,0.4)' : danger ? '1px solid rgba(224,108,117,0.4)' : '1px solid ' + T.border
      return React.createElement('button', {
        onClick: props.onClick,
        disabled: props.disabled,
        style: {
          padding: '4px 10px', borderRadius: T.radius, background: bg, color: color,
          border: border, cursor: props.disabled ? 'not-allowed' : 'pointer',
          fontSize: 12, lineHeight: '17px', fontWeight: 500, opacity: props.disabled ? 0.5 : 1,
          transition: 'background 0.15s, opacity 0.15s',
        },
      }, props.children)
    }

    function Field(props) {
      return React.createElement('input', {
        value: props.value,
        onChange: function (e) { props.onChange(e.target.value) },
        onKeyDown: props.onKeyDown,
        placeholder: props.placeholder,
        disabled: props.disabled,
        style: {
          flex: 1, minWidth: 140, padding: '5px 8px', borderRadius: T.radius,
          background: T.bg, color: T.text, border: '1px solid ' + T.border,
          fontSize: 13, outline: 'none', opacity: props.disabled ? 0.5 : 1,
        },
      })
    }

    function formatTime(iso) {
      if (!iso) return '—'
      var d = new Date(iso)
      if (isNaN(d.getTime())) return String(iso)
      return d.toLocaleString()
    }

    function formatBytes(n) {
      if (typeof n !== 'number') return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    function shortFp(fp) {
      return typeof fp === 'string' && fp.length > 0 ? fp.slice(0, 12) : '—'
    }

    // ── the snapshot page ─────────────────────────────────────────────────

    function SnapshotPage() {
      var st = React.useState(null)
      var state = st[0], setState = st[1]
      var sf = React.useState(null)
      var feedback = sf[0], setFeedback = sf[1]
      var sb = React.useState(false)
      var busy = sb[0], setBusy = sb[1]
      var sn = React.useState('')
      var name = sn[0], setName = sn[1]

      var refresh = React.useCallback(async function () {
        try {
          var res = await api('GET', '/settings-persist/state')
          setState(res)
        } catch { /* backend offline; keep last view */ }
      }, [])

      React.useEffect(function () {
        var active = true
        async function poll() {
          try {
            var res = await api('GET', '/settings-persist/state')
            if (active) setState(res)
          } catch { /* backend offline */ }
        }
        poll()
        var timer = setInterval(poll, POLL_MS)
        return function () { active = false; clearInterval(timer) }
      }, [])

      var run = React.useCallback(async function (fn, okPrefix) {
        setBusy(true)
        setFeedback(null)
        try {
          var result = await fn()
          var note = ''
          if (result && typeof result.applied === 'number') {
            note = boundTr('restored', { n: result.applied })
            if (result.missing && result.missing.length > 0) {
              note += boundTr('missingNote', { n: result.missing.length })
            }
          }
          var prefix = okPrefix ? okPrefix : ''
          if (prefix && note) prefix += ' · '
          setFeedback({ ok: true, text: prefix + note })
          await refresh()
        } catch (error) {
          setFeedback({ ok: false, text: boundTr('err') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [refresh])

      var sections = []

      sections.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 10px', fontSize: 12, color: T.textMuted, lineHeight: '18px' },
      }, boundTr('intro')))

      if (state && state.profile) {
        sections.push(React.createElement('div', {
          key: 'meta',
          style: { fontSize: 11, color: T.textMuted, marginBottom: 10 },
        }, boundTr('currentFp') + ': ' + shortFp(state.currentFingerprint) + ' · ' + formatBytes(state.documentBytes)))
      }

      // Auto backup card
      var auto = state && state.auto
      var cardChildren = []
      cardChildren.push(React.createElement('div', {
        key: 'auto-title',
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
      },
        React.createElement('span', { style: { fontWeight: 600, fontSize: 13, color: T.text } }, boundTr('autoTitle')),
        auto
          ? React.createElement('span', { style: { fontSize: 11, color: auto.matchesCurrent ? T.ok : T.warn } },
              React.createElement(Pill, { ok: auto.matchesCurrent }),
              auto.matchesCurrent ? boundTr('matches') : boundTr('mismatch'))
          : null,
      ))

      if (!auto) {
        cardChildren.push(React.createElement('div', {
          key: 'auto-missing',
          style: { fontSize: 12, color: T.textMuted, marginBottom: 6 },
        }, boundTr('autoMissing')))
      } else {
        cardChildren.push(React.createElement('div', {
          key: 'auto-facts',
          style: { fontSize: 12, color: T.textMuted, marginBottom: 8, lineHeight: '18px' },
        },
          formatTime(auto.updatedAt) + ' · ' + boundTr('rows', { n: auto.rowCount }) + ' · ' + formatBytes(auto.bytes),
        ))
        cardChildren.push(React.createElement('div', {
          key: 'auto-actions',
          style: { display: 'flex', gap: 8, flexWrap: 'wrap' },
        },
          React.createElement(Button, {
            variant: 'primary',
            disabled: busy,
            onClick: function () {
              if (!window.confirm(boundTr('confirmRestore'))) return
              run(function () { return api('POST', '/settings-persist/restore', { id: 'auto' }) })
            },
          }, busy ? boundTr('busy') : boundTr('restoreAuto')),
          React.createElement(Button, {
            disabled: busy,
            onClick: function () {
              run(function () { return api('POST', '/settings-persist/reset-auto') }, boundTr('created'))
            },
          }, boundTr('resetAuto')),
        ))
      }

      sections.push(React.createElement('div', {
        key: 'auto-card',
        style: {
          background: T.bg, border: '1px solid ' + T.border, borderRadius: T.radius,
          padding: '10px 12px', marginBottom: 12,
        },
      }, cardChildren))

      // Manual snapshots
      var snapshots = (state && state.snapshots) || []
      var manualChildren = [
        React.createElement('div', {
          key: 'manual-title',
          style: { fontWeight: 600, fontSize: 13, color: T.text, marginBottom: 6 },
        }, boundTr('manualTitle') + ' (' + snapshots.length + ')'),
      ]

      if (snapshots.length === 0) {
        manualChildren.push(React.createElement('div', {
          key: 'manual-empty',
          style: { fontSize: 12, color: T.textMuted, marginBottom: 8 },
        }, boundTr('noManual')))
      } else {
        snapshots.forEach(function (snap) {
          manualChildren.push(React.createElement('div', {
            key: 'snap-' + snap.id,
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
              borderTop: '1px solid ' + T.borderL3, minWidth: 0,
            },
          },
            React.createElement('span', {
              style: { fontSize: 12, color: T.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: snap.id,
            },
              snap.name ? snap.name + ' · ' : '',
              formatTime(snap.updatedAt),
            ),
            React.createElement('span', { style: { fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' } },
              boundTr('rows', { n: snap.rowCount }) + ' · ' + formatBytes(snap.bytes)),
            React.createElement(Button, {
              variant: 'primary',
              disabled: busy,
              onClick: function () {
                if (!window.confirm(boundTr('confirmRestore'))) return
                run(function () { return api('POST', '/settings-persist/restore', { id: snap.id }) })
              },
            }, boundTr('restore')),
            React.createElement(Button, {
              variant: 'danger',
              disabled: busy,
              onClick: function () {
                if (!window.confirm(boundTr('confirmDelete'))) return
                run(function () { return api('POST', '/settings-persist/delete', { id: snap.id }) }, boundTr('deleted'))
              },
            }, boundTr('delete')),
          ))
        })
      }

      manualChildren.push(React.createElement('div', {
        key: 'manual-create',
        style: { display: 'flex', gap: 8, marginTop: 10 },
      },
        React.createElement(Field, {
          value: name,
          onChange: setName,
          placeholder: boundTr('namePlaceholder'),
          disabled: busy,
          onKeyDown: function (e) {
            if (e.key !== 'Enter' || busy || !name.trim()) return
            var label = name.trim()
            setName('')
            run(function () { return api('POST', '/settings-persist/snapshot', { name: label }) }, boundTr('created'))
          },
        }),
        React.createElement(Button, {
          variant: 'primary',
          disabled: busy || !name.trim(),
          onClick: function () {
            var label = name.trim()
            setName('')
            run(function () { return api('POST', '/settings-persist/snapshot', { name: label }) }, boundTr('created'))
          },
        }, boundTr('create')),
      ))

      sections.push(React.createElement('div', {
        key: 'manual-card',
        style: {
          background: T.bg, border: '1px solid ' + T.border, borderRadius: T.radius,
          padding: '10px 12px', marginBottom: 12,
        },
      }, manualChildren))

      if (feedback) {
        sections.push(React.createElement('div', {
          key: 'feedback',
          style: { fontSize: 12, color: feedback.ok ? T.ok : T.danger },
        }, feedback.text))
      }

      if (!state) {
        sections.push(React.createElement('div', {
          key: 'loading',
          style: { fontSize: 12, color: T.textMuted },
        }, '…'))
      }

      return React.createElement('div', { style: { maxWidth: 720 } }, sections)
    }

    // ── apply (client entry point) ────────────────────────────────────────

    function apply(ctx) {
      wireLocale(ctx)
      var localeDisposer2 = localeDisposer

      var slots = ctx.get('slots')

      // Settings section page — the stable generic slot (dsh-bas-remote style)
      slots.inject('settings.section', function () {
        return slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 44,
            label: function () { return boundTr('nav') },
            locale: NS,
          },
          function () { return React.createElement(SnapshotPage, null) },
        )
      })

      if (localeDisposer2) {
        ctx.effect(function () { return localeDisposer2 }, NS + '.locale')
      }
    }

    exports.name = NS
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
