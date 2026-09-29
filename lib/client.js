// dsh-settings-persist — client half (browser).
//
// A settings section page for snapshot management: the rolling auto backup
// (replayed at boot, what keeps Settings edits alive across nix managed
// profile syncs and rebuilds) plus user-created manual snapshots with
// create / preview / diff / merge / restore / delete actions.
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
    var DIFF_MAX_LINES = 2000

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
        'currentFp':     '当前指纹',
        'confirmDelete': '删除这个快照？',
        'confirmRestore': '用这个快照恢复当前设置？',
        'confirmAll':    '恢复全部配置项？（只想恢复一部分请用「对比」勾选）',
        'err':           '出错',
        'restored':      '已恢复（{n} 项）',
        'missingNote':   '，{n} 项已不存在被跳过',
        'created':       '已创建',
        'deleted':       '已删除',
        'preview':       '预览',
        'previewCurrent': '查看当前配置',
        'diff':          '对比',
        'back':          '返回列表',
        'merge':         '合并勾选（{n}）',
        'mergeHint':     '勾选要从快照合并进当前的配置项；「仅当前有」的项不受影响。',
        'changedRows':   '有差异',
        'onlySnap':      '仅快照有',
        'onlyCur':       '仅当前有（不受恢复影响）',
        'sameRows':      '与当前相同：{n} 项',
        'docDiff':       '文档逐行差异（git 风格）',
        'noDiff':        '无差异',
        'tooBig':        '文档过大，不显示逐行差异（上方按配置项的对比仍可用）',
        'copy':          '复制',
        'copied':        '已复制',
        'jsonTooBig':    '该配置项差异过大，不逐行展示',
        'loading':       '加载中…',
        'diffTitle':     '{a} ↔ 当前配置',
        'rowDiffTitle':  '{a} · 当前 → 快照',
        'textDiffNote':  '当前配置 → 该快照（− 恢复后会消失，+ 恢复后会出现）',
        'previewTitle':  '预览：{a}',
        'currentDoc':    '当前配置',
        'snapshotName':  '未命名',
        'selectSome':    '至少勾选一项再合并',
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
        'currentFp':     'Current fingerprint',
        'confirmDelete': 'Delete this snapshot?',
        'confirmRestore': 'Restore current settings from this snapshot?',
        'confirmAll':    'Restore every setting? (Use "Diff" to pick a subset.)',
        'err':           'Error',
        'restored':      'Restored ({n} settings)',
        'missingNote':   ', {n} skipped (entries no longer exist)',
        'created':       'Created',
        'deleted':       'Deleted',
        'preview':       'Preview',
        'previewCurrent': 'View current config',
        'diff':          'Diff',
        'back':          'Back to list',
        'merge':         'Merge checked ({n})',
        'mergeHint':     'Check the settings to merge from the snapshot; "current only" items stay untouched.',
        'changedRows':   'changed',
        'onlySnap':      'snapshot only',
        'onlyCur':       'current only (not affected)',
        'sameRows':      'identical: {n} settings',
        'docDiff':       'Document line diff (git style)',
        'noDiff':        'No differences',
        'tooBig':        'Document too large for a line diff (the row diff above still works)',
        'copy':          'Copy',
        'copied':        'Copied',
        'jsonTooBig':    'This setting differs too much to show line by line',
        'loading':       'Loading…',
        'diffTitle':     '{a} ↔ current config',
        'rowDiffTitle':  '{a} · current → snapshot',
        'textDiffNote':  'current → snapshot (− lines vanish after restore, + lines appear)',
        'previewTitle':  'Preview: {a}',
        'currentDoc':    'Current config',
        'snapshotName':  'unnamed',
        'selectSome':    'Check at least one setting to merge',
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

    function fetchDoc(id) {
      return api('GET', '/settings-persist/document?id=' + encodeURIComponent(id))
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
          whiteSpace: 'nowrap',
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

    function Badge(props) {
      var color = props.tone === 'add' ? T.ok : props.tone === 'del' ? T.danger : props.tone === 'warn' ? T.warn : T.textMuted
      return React.createElement('span', {
        style: {
          fontSize: 10, lineHeight: '14px', padding: '1px 6px', borderRadius: 8,
          border: '1px solid ' + color, color: color, whiteSpace: 'nowrap',
        },
      }, props.children)
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

    // ── line diff engine (LCS, unified hunks with 3 lines of context) ─────

    function computeLineDiff(aText, bText) {
      var a = String(aText).split('\n')
      var b = String(bText).split('\n')
      if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null
      var n = a.length
      var m = b.length
      var w = m + 1
      var dp = new Uint32Array((n + 1) * w)
      var i, j
      for (i = n - 1; i >= 0; i--) {
        for (j = m - 1; j >= 0; j--) {
          dp[i * w + j] = a[i] === b[j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
        }
      }
      var ops = []
      var x = 0
      var y = 0
      while (x < n && y < m) {
        if (a[x] === b[y]) {
          ops.push({ t: ' ', line: a[x], aNo: x + 1, bNo: y + 1 })
          x++
          y++
        } else if (dp[(x + 1) * w + y] >= dp[x * w + y + 1]) {
          ops.push({ t: '-', line: a[x], aNo: x + 1 })
          x++
        } else {
          ops.push({ t: '+', line: b[y], bNo: y + 1 })
          y++
        }
      }
      while (x < n) { ops.push({ t: '-', line: a[x], aNo: x + 1 }); x++ }
      while (y < m) { ops.push({ t: '+', line: b[y], bNo: y + 1 }); y++ }
      return groupHunks(ops)
    }

    function groupHunks(ops, context) {
      if (context === undefined) context = 3
      var changeIdx = []
      var k
      for (k = 0; k < ops.length; k++) if (ops[k].t !== ' ') changeIdx.push(k)
      if (changeIdx.length === 0) return []
      var hunks = []
      var start = Math.max(0, changeIdx[0] - context)
      var end = Math.min(ops.length - 1, changeIdx[0] + context)
      for (k = 1; k < changeIdx.length; k++) {
        var idx = changeIdx[k]
        if (idx - context <= end + 1) {
          end = Math.min(ops.length - 1, idx + context)
        } else {
          hunks.push([start, end])
          start = Math.max(0, idx - context)
          end = Math.min(ops.length - 1, idx + context)
        }
      }
      hunks.push([start, end])
      return hunks.map(function (range) {
        var slice = ops.slice(range[0], range[1] + 1)
        var aStart = null
        var bStart = null
        var adds = 0
        var dels = 0
        slice.forEach(function (op) {
          if (op.aNo && aStart === null) aStart = op.aNo
          if (op.bNo && bStart === null) bStart = op.bNo
          if (op.t === '+') adds++
          if (op.t === '-') dels++
        })
        return { aStart: aStart, bStart: bStart, ops: slice, adds: adds, dels: dels }
      })
    }

    function DiffLine(props) {
      var op = props.op
      var bg = op.t === '-' ? 'rgba(224,108,117,0.13)' : op.t === '+' ? 'rgba(76,197,125,0.13)' : 'transparent'
      var fg = op.t === '-' ? 'rgba(224,108,117,0.95)' : op.t === '+' ? 'rgba(76,197,125,0.95)' : T.textMuted
      var mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: '17px' }
      return React.createElement('div', {
        style: Object.assign({ background: bg, whiteSpace: 'pre', minWidth: 'min-content' }, mono),
      },
        React.createElement('span', { style: { color: T.textMuted, display: 'inline-block', width: 42, textAlign: 'right', paddingRight: 8, userSelect: 'none' } }, op.aNo || ''),
        React.createElement('span', { style: { color: T.textMuted, display: 'inline-block', width: 42, textAlign: 'right', paddingRight: 8, userSelect: 'none' } }, op.bNo || ''),
        React.createElement('span', { style: { color: fg, display: 'inline-block', width: 14, userSelect: 'none' } }, op.t === ' ' ? '' : op.t),
        React.createElement('span', { style: { color: T.text } }, op.line),
      )
    }

    function DiffView(props) {
      var hunks = props.hunks
      if (hunks === null) return React.createElement('div', { style: { fontSize: 12, color: T.warn } }, boundTr('tooBig'))
      if (!hunks || hunks.length === 0) return React.createElement('div', { style: { fontSize: 12, color: T.textMuted } }, boundTr('noDiff'))
      var out = []
      hunks.forEach(function (hunk, hi) {
        out.push(React.createElement('div', {
          key: 'h' + hi,
          style: Object.assign({
            background: T.bg2, color: T.textMuted, fontSize: 12, padding: '2px 8px',
            border: '1px solid ' + T.borderL3, borderTop: hi === 0 ? '1px solid ' + T.borderL3 : 'none',
          }, { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }),
        }, '@@ -' + (hunk.aStart ?? 0) + ' +' + (hunk.bStart ?? 0) + ' @@  +' + hunk.adds + ' -' + hunk.dels))
        hunk.ops.forEach(function (op, oi) {
          out.push(React.createElement(DiffLine, { key: 'h' + hi + 'l' + oi, op: op }))
        })
      })
      return React.createElement('div', {
        style: {
          border: '1px solid ' + T.border, borderRadius: T.radius, overflowX: 'auto',
          maxHeight: 360, overflowY: 'auto', background: T.bg,
        },
      }, out)
    }

    // ── document viewer (preview) ─────────────────────────────────────────

    function DocViewer(props) {
      var copied = props.copied
      var text = props.text
      var lines = text.split('\n')
      return React.createElement('div', null,
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
          React.createElement('span', { style: { fontSize: 11, color: T.textMuted } }, formatBytes(BufferByteLength(text)) + ' · ' + lines.length + ' lines'),
          React.createElement(Button, { disabled: props.busy, onClick: props.onCopy }, copied ? boundTr('copied') : boundTr('copy')),
        ),
        React.createElement('pre', {
          style: {
            margin: 0, padding: '8px 10px', background: T.bg, border: '1px solid ' + T.border,
            borderRadius: T.radius, fontSize: 12, lineHeight: '17px', color: T.text,
            maxHeight: 480, overflow: 'auto', whiteSpace: 'pre',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          },
        }, text),
      )
    }

    function BufferByteLength(text) {
      try { return new TextEncoder().encode(text).length } catch { return text.length }
    }

    // ── row matrix (per-setting diff used by the merge view) ──────────────

    function buildRowMatrix(curRows, snapRows) {
      var map = {}
      function put(id, side, config, name) {
        var entry = map[id] || (map[id] = { id: id, name: null })
        entry[side] = config
        if (name && !entry.name) entry.name = name
      }
      ;(snapRows || []).forEach(function (row) { put(row.id, 'snap', row.config, row.name) })
      ;(curRows || []).forEach(function (row) { put(row.id, 'cur', row.config, row.name) })
      var changed = []
      var onlySnap = []
      var onlyCur = []
      var sameCount = 0
      Object.keys(map).sort().forEach(function (id) {
        var entry = map[id]
        if (entry.snap !== undefined && entry.cur !== undefined) {
          if (JSON.stringify(entry.snap) === JSON.stringify(entry.cur)) sameCount++
          else changed.push(entry)
        } else if (entry.snap !== undefined) {
          onlySnap.push(entry)
        } else {
          onlyCur.push(entry)
        }
      })
      return { changed: changed, onlySnap: onlySnap, onlyCur: onlyCur, sameCount: sameCount }
    }

    function JsonDiff(props) {
      var a = JSON.stringify(props.from, null, 2)
      var b = JSON.stringify(props.to, null, 2)
      var hunks = computeLineDiff(a, b)
      return React.createElement('div', { style: { marginTop: 6 } },
        React.createElement('div', { style: { fontSize: 11, color: T.textMuted, marginBottom: 4 } },
          boundTr('rowDiffTitle', { a: props.left })),
        React.createElement(DiffView, { hunks: hunks }),
      )
    }

    // ── diff + merge panel ────────────────────────────────────────────────

    function DiffPanel(props) {
      var targetLabel = props.targetLabel
      var targetId = props.targetId

      var sd = React.useState(null)
      var docs = sd[0], setDocs = sd[1]
      var sc = React.useState({})
      var checked = sc[0], setChecked = sc[1]
      var se = React.useState(null)
      var error = se[0], setError = se[1]
      var st = React.useState(false)
      var showTextDiff = st[0], setShowTextDiff = st[1]

      React.useEffect(function () {
        var active = true
        setDocs(null)
        setError(null)
        setChecked({})
        Promise.all([fetchDoc('current'), fetchDoc(targetId)])
          .then(function (res) {
            if (!active) return
            setDocs({ cur: res[0], tgt: res[1] })
            var defaults = {}
            var matrix = buildRowMatrix(res[0].rows, res[1].rows)
            matrix.changed.forEach(function (entry) { defaults[entry.id] = true })
            matrix.onlySnap.forEach(function (entry) { defaults[entry.id] = true })
            setChecked(defaults)
          })
          .catch(function (e) { if (active) setError(e.message) })
        return function () { active = false }
      }, [targetId])

      if (error) {
        return React.createElement('div', { style: { padding: 10 } },
          React.createElement('div', { style: { fontSize: 12, color: T.danger, marginBottom: 8 } }, boundTr('err') + ': ' + error),
          React.createElement(Button, { onClick: props.onClose }, boundTr('back')),
        )
      }
      if (!docs) {
        return React.createElement('div', { style: { padding: 10, fontSize: 12, color: T.textMuted } }, boundTr('loading'))
      }

      var matrix = buildRowMatrix(docs.cur.rows, docs.tgt.rows)
      var selectable = matrix.changed.concat(matrix.onlySnap)
      var selectedCount = selectable.filter(function (entry) { return checked[entry.id] }).length

      function toggle(id) {
        setChecked(function (prev) {
          var next = Object.assign({}, prev)
          next[id] = !next[id]
          return next
        })
      }

      async function doMerge() {
        if (selectedCount === 0) { props.notify(boundTr('selectSome'), false); return }
        var only = selectable.filter(function (entry) { return checked[entry.id] }).map(function (entry) { return entry.id })
        await props.run(function () {
          return api('POST', '/settings-persist/restore', { id: targetId, only: only })
        })
        props.onClose()
      }

      async function doRestoreAll() {
        if (!window.confirm(boundTr('confirmAll'))) return
        await props.run(function () {
          return api('POST', '/settings-persist/restore', { id: targetId })
        })
        props.onClose()
      }

      var groups = []

      groups.push(React.createElement('div', {
        key: 'hint',
        style: { fontSize: 12, color: T.textMuted, lineHeight: '18px', marginBottom: 8 },
      }, boundTr('mergeHint')))

      if (matrix.changed.length > 0) {
        groups.push(React.createElement('div', { key: 'gh', style: { fontWeight: 600, fontSize: 13, color: T.text, marginTop: 6 } },
          boundTr('changedRows') + ' (' + matrix.changed.length + ')'))
        matrix.changed.forEach(function (entry) {
          groups.push(React.createElement('div', {
            key: 'c-' + entry.id,
            style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderTop: '1px solid ' + T.borderL3, flexWrap: 'wrap' },
          },
            React.createElement('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: T.text, cursor: 'pointer', flex: '1 1 200px', minWidth: 0 } },
              React.createElement('input', { type: 'checkbox', checked: !!checked[entry.id], onChange: function () { toggle(entry.id) } }),
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: entry.id },
                entry.name || entry.id),
            ),
            React.createElement(Badge, { tone: 'warn' }, boundTr('changedRows')),
            React.createElement('details', { style: { flex: '1 1 100%' } },
              React.createElement('summary', { style: { fontSize: 11, color: T.textMuted, cursor: 'pointer' } }, 'diff'),
              React.createElement(JsonDiff, { from: entry.cur, to: entry.snap, left: entry.name || entry.id }),
            ),
          ))
        })
      }

      if (matrix.onlySnap.length > 0) {
        groups.push(React.createElement('div', { key: 'gh2', style: { fontWeight: 600, fontSize: 13, color: T.text, marginTop: 8 } },
          boundTr('onlySnap') + ' (' + matrix.onlySnap.length + ')'))
        matrix.onlySnap.forEach(function (entry) {
          groups.push(React.createElement('div', {
            key: 's-' + entry.id,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '1px solid ' + T.borderL3 },
          },
            React.createElement('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: T.text, cursor: 'pointer', flex: 1, minWidth: 0 } },
              React.createElement('input', { type: 'checkbox', checked: !!checked[entry.id], onChange: function () { toggle(entry.id) } }),
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name || entry.id),
            ),
            React.createElement(Badge, { tone: 'add' }, boundTr('onlySnap')),
          ))
        })
      }

      if (matrix.onlyCur.length > 0) {
        groups.push(React.createElement('div', { key: 'gh3', style: { fontWeight: 600, fontSize: 13, color: T.text, marginTop: 8 } },
          boundTr('onlyCur') + ' (' + matrix.onlyCur.length + ')'))
      }

      if (matrix.sameCount > 0) {
        groups.push(React.createElement('div', { key: 'same', style: { fontSize: 11, color: T.textMuted, marginTop: 8 } },
          boundTr('sameRows', { n: matrix.sameCount })))
      }

      groups.push(React.createElement('div', {
        key: 'actions',
        style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' },
      },
        React.createElement(Button, { variant: 'primary', disabled: props.busy, onClick: doMerge },
          boundTr('merge', { n: selectedCount })),
        React.createElement(Button, { disabled: props.busy, onClick: doRestoreAll }, boundTr('restore')),
        React.createElement(Button, { disabled: props.busy, onClick: props.onClose }, boundTr('back')),
      ))

      var textDiff = null
      if (showTextDiff) {
        var hunks = computeLineDiff(docs.cur.text, docs.tgt.text)
        textDiff = React.createElement('div', { style: { marginTop: 8 } },
          React.createElement('div', { style: { fontSize: 11, color: T.textMuted, marginBottom: 4 } }, boundTr('textDiffNote')),
          React.createElement(DiffView, { hunks: hunks }))
      }
      groups.push(React.createElement('div', { key: 'textdiff', style: { marginTop: 10 } },
        React.createElement('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: T.text, cursor: 'pointer' } },
          React.createElement('input', { type: 'checkbox', checked: showTextDiff, onChange: function (e) { setShowTextDiff(e.target.checked) } }),
          boundTr('docDiff'),
        ),
        textDiff,
      ))

      return React.createElement('div', { style: { background: T.bg, border: '1px solid ' + T.border, borderRadius: T.radius, padding: '10px 12px', marginBottom: 12 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 13, color: T.text, marginBottom: 8 } },
          boundTr('diffTitle', { a: targetLabel })),
        groups,
      )
    }

    // ── preview panel ─────────────────────────────────────────────────────

    function PreviewPanel(props) {
      var sp = React.useState(null)
      var doc = sp[0], setDoc = sp[1]
      var se = React.useState(null)
      var error = se[0], setError = se[1]
      var sc = React.useState(false)
      var copied = sc[0], setCopied = sc[1]

      React.useEffect(function () {
        var active = true
        setDoc(null)
        setError(null)
        setCopied(false)
        fetchDoc(props.docId)
          .then(function (res) { if (active) setDoc(res) })
          .catch(function (e) { if (active) setError(e.message) })
        return function () { active = false }
      }, [props.docId])

      var body
      if (error) body = React.createElement('div', { style: { fontSize: 12, color: T.danger } }, boundTr('err') + ': ' + error)
      else if (!doc) body = React.createElement('div', { style: { fontSize: 12, color: T.textMuted } }, boundTr('loading'))
      else {
        body = React.createElement(DocViewer, {
          text: doc.text,
          copied: copied,
          busy: props.busy,
          onCopy: function () {
            try {
              navigator.clipboard.writeText(doc.text)
              setCopied(true)
              setTimeout(function () { setCopied(false) }, 1500)
            } catch { /* clipboard unavailable */ }
          },
        })
      }

      return React.createElement('div', { style: { background: T.bg, border: '1px solid ' + T.border, borderRadius: T.radius, padding: '10px 12px', marginBottom: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          React.createElement('span', { style: { fontWeight: 600, fontSize: 13, color: T.text, flex: 1 } },
            boundTr('previewTitle', { a: props.label })),
          React.createElement(Button, { disabled: props.busy, onClick: props.onClose }, boundTr('back')),
        ),
        body,
      )
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
      var sv = React.useState(null)
      var view = sv[0], setView = sv[1]

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
          return true
        } catch (error) {
          setFeedback({ ok: false, text: boundTr('err') + ': ' + error.message })
          return false
        } finally {
          setBusy(false)
        }
      }, [refresh])

      var notify = React.useCallback(function (text, ok) {
        setFeedback({ ok: !!ok, text: text })
      }, [])

      function createSnapshot(label) {
        run(function () {
          return api('POST', '/settings-persist/snapshot', label ? { name: label } : {})
        }, boundTr('created'))
      }

      function restoreQuick(id) {
        if (!window.confirm(boundTr('confirmRestore'))) return
        run(function () { return api('POST', '/settings-persist/restore', { id: id }) })
      }

      function deleteSnapshot(id) {
        if (!window.confirm(boundTr('confirmDelete'))) return
        run(function () { return api('POST', '/settings-persist/delete', { id: id }) }, boundTr('deleted'))
      }

      // ── sub views (preview / diff) ──────────────────────────────────────
      if (view) {
        if (view.kind === 'preview') {
          return React.createElement('div', { style: { maxWidth: 720 } },
            feedback ? React.createElement('div', { style: { fontSize: 12, color: feedback.ok ? T.ok : T.danger, marginBottom: 8 } }, feedback.text) : null,
            React.createElement(PreviewPanel, {
              docId: view.id,
              label: view.label,
              busy: busy,
              onClose: function () { setView(null) },
            }),
          )
        }
        if (view.kind === 'diff') {
          return React.createElement('div', { style: { maxWidth: 720 } },
            feedback ? React.createElement('div', { style: { fontSize: 12, color: feedback.ok ? T.ok : T.danger, marginBottom: 8 } }, feedback.text) : null,
            React.createElement(DiffPanel, {
              targetId: view.id,
              targetLabel: view.label,
              busy: busy,
              run: run,
              notify: notify,
              onClose: function () { setView(null) },
            }),
          )
        }
      }

      // ── main list ───────────────────────────────────────────────────────
      var sections = []

      sections.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 10px', fontSize: 12, color: T.textMuted, lineHeight: '18px' },
      }, boundTr('intro')))

      if (state && state.profile) {
        sections.push(React.createElement('div', {
          key: 'meta',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: T.textMuted, marginBottom: 10 },
        },
          React.createElement('span', null, boundTr('currentFp') + ': ' + shortFp(state.currentFingerprint) + ' · ' + formatBytes(state.documentBytes)),
          React.createElement(Button, {
            disabled: busy,
            onClick: function () { setView({ kind: 'preview', id: 'current', label: boundTr('currentDoc') }) },
          }, boundTr('previewCurrent')),
        ))
      }

      // Auto backup card
      var auto = state && state.auto
      var cardChildren = []
      cardChildren.push(React.createElement('div', {
        key: 'auto-title',
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
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
            onClick: function () { restoreQuick('auto') },
          }, busy ? boundTr('busy') : boundTr('restoreAuto')),
          React.createElement(Button, {
            disabled: busy,
            onClick: function () { setView({ kind: 'preview', id: 'auto', label: boundTr('autoTitle') }) },
          }, boundTr('preview')),
          React.createElement(Button, {
            disabled: busy,
            onClick: function () { setView({ kind: 'diff', id: 'auto', label: boundTr('autoTitle') }) },
          }, boundTr('diff')),
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
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0',
              borderTop: '1px solid ' + T.borderL3, minWidth: 0, flexWrap: 'wrap',
            },
          },
            React.createElement('span', {
              style: { fontSize: 12, color: T.text, flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: snap.id,
            },
              snap.name ? snap.name + ' · ' : '',
              formatTime(snap.updatedAt),
            ),
            React.createElement('span', { style: { fontSize: 11, color: T.textMuted, whiteSpace: 'nowrap' } },
              boundTr('rows', { n: snap.rowCount }) + ' · ' + formatBytes(snap.bytes)),
            React.createElement(Button, {
              disabled: busy,
              onClick: function () { setView({ kind: 'preview', id: snap.id, label: snap.name || snap.id }) },
            }, boundTr('preview')),
            React.createElement(Button, {
              variant: 'primary',
              disabled: busy,
              onClick: function () { setView({ kind: 'diff', id: snap.id, label: snap.name || snap.id }) },
            }, boundTr('diff')),
            React.createElement(Button, {
              disabled: busy,
              onClick: function () { restoreQuick(snap.id) },
            }, boundTr('restore')),
            React.createElement(Button, {
              variant: 'danger',
              disabled: busy,
              onClick: function () { deleteSnapshot(snap.id) },
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
            if (e.key !== 'Enter' || busy) return
            var label = name.trim()
            setName('')
            createSnapshot(label)
          },
        }),
        React.createElement(Button, {
          variant: 'primary',
          disabled: busy,
          onClick: function () {
            var label = name.trim()
            setName('')
            createSnapshot(label)
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
