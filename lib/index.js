/**
 * dsh-settings-persist — keep Settings-UI edits alive under nix "managed"
 * profiles, with an auto backup plus user-managed snapshots.
 *
 * DSH's Settings UI persists edits into the profile's cordis.patch.yml. Under
 * a managed profile the nix wrapper (dsh-seed-profile → dsh-sync-profiles)
 * reverts that file to the nix snapshot before every launch, so runtime
 * settings edits die on restart. This plugin keeps its state under
 * $DSH_HOME/settings-persist/<profile>/:
 *
 *   auto.json          rolling auto backup — saved on every live Settings
 *                      edit and replayed at every boot (the boot restore
 *                      source);
 *   snapshots/*.json   manual snapshots — created and restored only from
 *                      the "设置快照" settings page, never touched at boot.
 *
 * Boot rules (v2 — the fingerprint gate is gone):
 *
 *   auto document differs from the live document → replay the auto backup
 *     through ConfigEditor.edit(), the official hot-apply path (file lock,
 *     YAML row upsert, reconcile, atomic write, rollback on failure).
 *     A nix rebuild rotates store paths inside the document and thus the
 *     .nix-managed fingerprint; that must NOT discard user settings — rows
 *     whose entries no longer exist are skipped (buildRestorePlan), which
 *     is the only nix-wins guard still applied.
 *   live document edits (Settings saves, observed through
 *     app-boot/config-reload / loader/volatile-update) → adopt immediately
 *     (rewrites auto.json).
 *
 * Routes (registered on both carriers like dsh-bas-remote):
 *   GET  /settings-persist/state        auto + manual snapshot inventory
 *   GET  /settings-persist/document     raw document + rows for preview
 *                                       (?id=current|auto|<snapshot id>)
 *   POST /settings-persist/snapshot     create a manual snapshot
 *   POST /settings-persist/restore      restore auto or a manual snapshot
 *                                       ({id, only?: [row ids]} for merge)
 *   POST /settings-persist/delete       delete a manual snapshot
 *   POST /settings-persist/reset-auto   rebuild auto from the live document
 *
 * Fail-open: every path is wrapped; errors are logged and never thrown at
 * boot. The snapshot directory (0700) and files (0600) hold the raw
 * document, so treat them as sensitive: profile patches can contain tokens.
 */
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SCHEMA = 1
const LOG_PREFIX = 'dsh-settings-persist:'

/** @typedef {{schema: number, profile?: string, source?: string, name?: string, fingerprint: string, documentText: string, rows: Array<{id: string, name?: string, config: object}>, updatedAt?: string}} PersistState */

/**
 * Decide what to do with the live document.
 *
 * - `adopt`  – the live document is the new truth (first run / format change,
 *   or a live edit seen outside the boot window).
 * - `restore`– the auto backup differs from the live document at boot: replay
 *   it. Fingerprint changes (a nix rebuild rotating store paths) no longer
 *   opt out of this — restoring user settings is the plugin's purpose.
 * - `noop`   – nothing changed.
 *
 * @param {{state?: PersistState|null, currentText: string, bootMode: boolean}} input
 * @returns {'adopt'|'restore'|'noop'}
 */
export function decideAction({ state, currentText, bootMode }) {
  if (!state || typeof state !== 'object' || state.schema !== SCHEMA) return 'adopt'
  if (typeof state.documentText !== 'string') return 'adopt'
  const drift = state.documentText !== currentText
  if (!bootMode) return drift ? 'adopt' : 'noop'
  return drift ? 'restore' : 'noop'
}

/**
 * Extract restorable rows from `ConfigEditor.configuration()`. Rows without a
 * config override (name-only inserts) carry no settings and are skipped;
 * their presence in the document is preserved by not touching them.
 *
 * @param {Array<{entry: {options: {id?: string, name?: string}}, override?: object}>} configuration
 * @returns {Array<{id: string, name?: string, config: object}>}
 */
export function captureRows(configuration) {
  const rows = []
  for (const item of configuration ?? []) {
    const id = item?.entry?.options?.id
    if (typeof id !== 'string' || id.length === 0) continue
    const override = item?.override
    if (override === null || typeof override !== 'object' || Array.isArray(override)) continue
    if (Object.keys(override).length === 0) continue
    rows.push({ id, name: item?.entry?.options?.name, config: override })
  }
  return rows
}

/**
 * Match snapshot rows against the currently active entries. Rows without an
 * active entry are reported in `missing` and skipped — that is how a nix
 * rebuild which dropped a bundle degrades a restore instead of failing it.
 *
 * @param {PersistState['rows']} rows
 * @param {Array<{options: {id?: string}}>} entries
 */
export function buildRestorePlan(rows, entries) {
  const plan = []
  const missing = []
  for (const row of rows ?? []) {
    const entry = (entries ?? []).find((candidate) => candidate?.options?.id === row.id)
    if (!entry) {
      missing.push(row.id)
      continue
    }
    plan.push({ entry, id: row.id, config: row.config })
  }
  return { plan, missing }
}

/** $DSH_HOME — two directories above `<harness>/profiles/<profile>`. */
function harnessHomeFor(documentPath) {
  const profileDir = path.dirname(documentPath)
  return path.dirname(path.dirname(profileDir))
}

/** Profile key (directory name) the document lives in. */
export function profileKeyFor(documentPath) {
  return path.basename(path.dirname(documentPath))
}

/** v2 rolling auto backup: $DSH_HOME/settings-persist/<profile>/auto.json */
export function autoPathFor(documentPath) {
  return path.join(harnessHomeFor(documentPath), 'settings-persist', profileKeyFor(documentPath), 'auto.json')
}

/** Manual snapshots: $DSH_HOME/settings-persist/<profile>/snapshots/<id>.json */
export function snapshotsDirFor(documentPath) {
  return path.join(harnessHomeFor(documentPath), 'settings-persist', profileKeyFor(documentPath), 'snapshots')
}

/** v1 flat file $DSH_HOME/settings-persist/<profile>.json (migrated to auto). */
export function statePathFor(documentPath) {
  return path.join(harnessHomeFor(documentPath), 'settings-persist', `${profileKeyFor(documentPath)}.json`)
}

/** Snapshot ids are directory-safe by construction (timestamp-based). */
export function isSnapshotId(id) {
  return typeof id === 'string' && /^[0-9A-Za-z._-]{1,80}$/.test(id) && !id.includes('..')
}

/** Inventory metadata for one snapshot file (never leaks documentText). */
export function snapshotMeta(state, id) {
  return {
    id,
    source: state.source === 'manual' ? 'manual' : 'auto',
    name: typeof state.name === 'string' && state.name.length > 0 ? state.name : null,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
    fingerprint: typeof state.fingerprint === 'string' ? state.fingerprint : '',
    rowCount: Array.isArray(state.rows) ? state.rows.length : 0,
    bytes: typeof state.documentText === 'string' ? Buffer.byteLength(state.documentText, 'utf8') : 0,
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

/** Read a JSON body from either carrier (Node IncomingMessage or adapter). */
async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Register the same JSON routes on both carriers: the Web host's HTTP server
 * and, when present, the harness `connection` fetch channel used by Desktop.
 * (Same transport pairing as dsh-bas-remote.)
 * @param {object} ctx - cordis context.
 * @param {Array} routes - `{path, handler(req, res)}` entries, all GET-or-POST.
 */
function registerTransports(ctx, routes) {
  ctx.inject(['webServer'], (inner) => {
    const disposers = routes.map((route) =>
      inner.get('webServer').register({ kind: 'exact', path: route.path, handler: route.handler }),
    )
    inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-settings-persist.web-routes')
  })

  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (!connection || typeof connection.fetch?.register !== 'function') return
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(
          connection.fetch.register({
            path: `/api${route.path}`,
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            async fetch(request) {
              const url = new URL(request.url)
              let body = ''
              if (request.body) body = await request.text()
              const req = Object.assign(
                (function* () {
                  if (body) yield Buffer.from(body)
                })(),
                { method: request.method, url: `${route.path}${url.search}`, headers: request.headers },
              )
              const headers = new Headers()
              let status = 200
              let payload = ''
              const res = {
                setHeader(key, value) {
                  headers.set(key, value)
                },
                end(value) {
                  payload = value === undefined ? '' : String(value)
                },
                get statusCode() {
                  return status
                },
                set statusCode(value) {
                  status = value
                },
              }
              await route.handler(req, res)
              return new Response(payload, { status, headers })
            },
          }),
        )
      } catch (error) {
        console.warn(`[dsh-settings-persist] route ${route.path} was not registered: ${error.message}`)
      }
    }
    inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-settings-persist.fetch-routes')
  })
}

async function start(ctx, configEditor) {
  const logger = ctx.logger ?? console
  const documentPath = configEditor.documentPath
  const profileKey = profileKeyFor(documentPath)
  const fingerprintPath = path.join(path.dirname(documentPath), '.nix-managed')
  const autoPath = autoPathFor(documentPath)
  const snapshotsDir = snapshotsDirFor(documentPath)
  const legacyPath = statePathFor(documentPath)

  let bootMode = true
  let restoring = false
  let chain = Promise.resolve()

  /** Serialize every mutation (boot handling and UI actions) on one chain. */
  const runExclusive = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const readText = (file) => readFile(file, 'utf8').catch(() => null)

  async function readSnapshot(file) {
    try {
      const raw = await readFile(file, 'utf8')
      const state = JSON.parse(raw)
      return state && state.schema === SCHEMA && typeof state.documentText === 'string' ? state : null
    } catch {
      return null
    }
  }

  async function writeSnapshot(file, state) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, file)
    await chmod(file, 0o600)
  }

  /** v1 → v2 migration: the old flat file becomes the auto backup. */
  async function migrateLegacy() {
    try {
      const legacy = await readSnapshot(legacyPath)
      if (!legacy) return
      const auto = await readSnapshot(autoPath)
      if (auto) return // v2 already established; leave the legacy file alone
      await writeSnapshot(autoPath, { ...legacy, source: 'auto' })
      await unlink(legacyPath).catch(() => {})
      logger.info?.(`${LOG_PREFIX} migrated legacy snapshot to ${autoPath}`)
    } catch (error) {
      logger.error?.(`${LOG_PREFIX} legacy migration failed:`, error)
    }
  }

  const currentFingerprint = async () => (await readText(fingerprintPath)) ?? ''

  /** Write the rolling auto backup from an already-known live document. */
  async function writeAuto({ text, fingerprint }) {
    try {
      const rows = captureRows(configEditor.configuration())
      await writeSnapshot(autoPath, {
        schema: SCHEMA,
        profile: profileKey,
        source: 'auto',
        fingerprint,
        documentText: text,
        rows,
        updatedAt: new Date().toISOString(),
      })
      bootMode = false
    } catch (error) {
      logger.error?.(`${LOG_PREFIX} auto snapshot failed:`, error)
    }
  }

  /**
   * Replay snapshot rows through ConfigEditor.edit(). Returns
   * `{applied, missing, failed}`; `failed` counts rows whose edit rejected.
   */
  async function restoreFrom(state) {
    const { plan, missing } = buildRestorePlan(state.rows, configEditor.entries())
    if (missing.length > 0) {
      logger.warn?.(`${LOG_PREFIX} no active entry for: ${missing.join(', ')} (rows skipped)`)
    }
    if (plan.length === 0 && (state.rows?.length ?? 0) > 0) {
      return { applied: 0, missing, failed: state.rows.length }
    }
    let applied = 0
    let failed = 0
    for (const item of plan) {
      try {
        await configEditor.edit(item.entry, () => structuredClone(item.config))
        applied += 1
      } catch (error) {
        failed += 1
        logger.error?.(`${LOG_PREFIX} restore of "${item.id}" failed:`, error)
      }
    }
    return { applied, missing, failed }
  }

  /** Boot / live-event handling against the auto backup. */
  async function handle() {
    if (restoring) return
    const currentText = await readText(documentPath)
    if (currentText === null) return
    const fingerprint = await currentFingerprint()
    const state = await readSnapshot(autoPath)
    const action = decideAction({ state, currentText, bootMode })

    if (action === 'noop') {
      bootMode = false
      return
    }

    if (action === 'adopt') {
      await writeAuto({ text: currentText, fingerprint })
      return
    }

    // action === 'restore' (boot window only): replay the auto backup.
    restoring = true
    let result = { applied: 0, missing: [], failed: 1 }
    try {
      result = await restoreFrom(state)
    } catch (error) {
      logger.error?.(`${LOG_PREFIX} restore failed:`, error)
    } finally {
      restoring = false
    }
    if (result.failed > 0) return // keep bootMode and auto; retry on a later event

    const settledText = await readText(documentPath)
    if (settledText === null) return
    await writeAuto({ text: settledText, fingerprint: await currentFingerprint() })
  }

  // ── snapshot inventory & actions (the settings page's backing API) ──────

  async function listSnapshots() {
    let files = []
    try {
      files = (await readdir(snapshotsDir)).filter((name) => name.endsWith('.json'))
    } catch {
      files = []
    }
    const snapshots = []
    for (const file of files) {
      const state = await readSnapshot(path.join(snapshotsDir, file))
      if (state) snapshots.push(snapshotMeta(state, path.basename(file, '.json')))
    }
    snapshots.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return snapshots
  }

  async function stateView() {
    const auto = await readSnapshot(autoPath)
    const currentText = await readText(documentPath)
    const fingerprint = await currentFingerprint()
    return {
      ok: true,
      profile: profileKey,
      currentFingerprint: fingerprint,
      documentBytes: currentText === null ? 0 : Buffer.byteLength(currentText, 'utf8'),
      auto: auto ? { ...snapshotMeta(auto, 'auto'), matchesCurrent: auto.documentText === currentText } : null,
      snapshots: await listSnapshots(),
    }
  }

  async function createManualSnapshot(body) {
    const name = String(body?.name ?? '')
      .trim()
      .slice(0, 80)
    const text = await readText(documentPath)
    if (text === null) return { status: 500, payload: { ok: false, error: 'document unreadable' } }
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}`
    const state = {
      schema: SCHEMA,
      profile: profileKey,
      source: 'manual',
      name: name || null,
      fingerprint: await currentFingerprint(),
      documentText: text,
      rows: captureRows(configEditor.configuration()),
      updatedAt: new Date().toISOString(),
    }
    await writeSnapshot(path.join(snapshotsDir, `${id}.json`), state)
    return { status: 200, payload: { ok: true, snapshot: snapshotMeta(state, id) } }
  }

  async function restoreById(id, only) {
    if (id !== 'auto' && !isSnapshotId(id)) {
      return { status: 400, payload: { ok: false, error: 'bad snapshot id' } }
    }
    const file = id === 'auto' ? autoPath : path.join(snapshotsDir, `${id}.json`)
    let state = await readSnapshot(file)
    if (!state) return { status: 404, payload: { ok: false, error: 'snapshot not found' } }
    if (Array.isArray(only)) {
      // Selective restore ("merge"): apply only the requested row ids.
      const ids = only.filter((value) => typeof value === 'string').slice(0, 1000)
      const rows = (state.rows ?? []).filter((row) => ids.includes(row.id))
      if (rows.length === 0) {
        return { status: 400, payload: { ok: false, error: 'none of the requested rows exist in the snapshot' } }
      }
      state = { ...state, rows }
    }
    const result = await restoreFrom(state)
    if (result.failed > 0) {
      return { status: 500, payload: { ok: false, ...result, error: 'some rows failed to apply' } }
    }
    // Restored content is now the live truth: refresh the auto backup.
    const settledText = await readText(documentPath)
    if (settledText !== null) {
      await writeAuto({ text: settledText, fingerprint: await currentFingerprint() })
    }
    return { status: 200, payload: { ok: true, ...result } }
  }

  /** Preview payload: raw document text + structured rows for one source. */
  async function documentById(id) {
    if (id === 'current') {
      const text = await readText(documentPath)
      if (text === null) return { status: 500, payload: { ok: false, error: 'document unreadable' } }
      return {
        status: 200,
        payload: { ok: true, id, text, rows: captureRows(configEditor.configuration()) },
      }
    }
    if (id !== 'auto' && !isSnapshotId(id)) {
      return { status: 400, payload: { ok: false, error: 'bad id' } }
    }
    const file = id === 'auto' ? autoPath : path.join(snapshotsDir, `${id}.json`)
    const state = await readSnapshot(file)
    if (!state) return { status: 404, payload: { ok: false, error: 'snapshot not found' } }
    return { status: 200, payload: { ok: true, id, text: state.documentText, rows: state.rows ?? [] } }
  }

  async function deleteManual(id) {
    if (!isSnapshotId(id)) return { status: 400, payload: { ok: false, error: 'bad snapshot id' } }
    try {
      await unlink(path.join(snapshotsDir, `${id}.json`))
      return { status: 200, payload: { ok: true } }
    } catch {
      return { status: 404, payload: { ok: false, error: 'snapshot not found' } }
    }
  }

  const routes = [
    {
      path: '/settings-persist/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          sendJson(res, 200, await runExclusive(stateView))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/settings-persist/document',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const url = new URL(req.url, 'http://dsh.local')
          const id = url.searchParams.get('id') ?? ''
          const { status, payload } = await runExclusive(() => documentById(id))
          sendJson(res, status, payload)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/settings-persist/snapshot',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const { status, payload } = await runExclusive(() => createManualSnapshot(body))
          sendJson(res, status, payload)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/settings-persist/restore',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const { status, payload } = await runExclusive(() =>
            restoreById(String(body.id ?? ''), Array.isArray(body.only) ? body.only : null),
          )
          sendJson(res, status, payload)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/settings-persist/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readBody(req)
          const { status, payload } = await runExclusive(() => deleteManual(String(body.id ?? '')))
          sendJson(res, status, payload)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      },
    },
    {
      path: '/settings-persist/reset-auto',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const result = await runExclusive(async () => {
            const text = await readText(documentPath)
            if (text === null) return { ok: false, error: 'document unreadable' }
            await writeAuto({ text, fingerprint: await currentFingerprint() })
            return { ok: true }
          })
          sendJson(res, result.ok ? 200 : 500, result)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      },
    },
  ]

  registerTransports(ctx, routes)
  await migrateLegacy()

  ctx.on('app-boot/config-reload', () => void runExclusive(handle))
  ctx.on('loader/volatile-update', () => void runExclusive(handle))
  const bootstrap = setTimeout(() => void runExclusive(handle), 1000)
  ctx.on('dispose', () => clearTimeout(bootstrap))
}

/**
 * Cordis entry point. `configEditor` is asked for lazily so headless/CLI
 * compositions (no profileContext) simply never start this plugin.
 *
 * @param {{inject?: (services: string[], callback: (ctx: unknown) => unknown) => unknown, logger?: unknown}} ctx
 */
export function apply(ctx) {
  if (typeof ctx?.inject !== 'function') return
  void Promise.resolve(
    ctx.inject(['configEditor'], (sctx) => {
      const configEditor = /** @type {{configEditor?: unknown}} */ (sctx)?.configEditor
      if (!configEditor) return
      const logger = /** @type {{logger?: unknown}} */ (sctx)?.logger ?? console
      void start(/** @type {never} */ (sctx), /** @type {never} */ (configEditor)).catch((error) => {
        logger.error?.(`${LOG_PREFIX} startup failed:`, error)
      })
    }),
  )
}
