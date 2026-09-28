/**
 * dsh-settings-persist — keep Settings-UI edits alive under nix "managed"
 * profiles.
 *
 * DSH's Settings UI persists edits into the profile's cordis.patch.yml. Under
 * a managed profile the nix wrapper (dsh-seed-profile → dsh-sync-profiles)
 * reverts that file to the nix snapshot before every launch, so runtime
 * settings edits die on restart. This plugin keeps a private snapshot per
 * profile under $DSH_HOME/settings-persist/<key>.json, together with the
 * profile's .nix-managed fingerprint, and applies these rules:
 *
 *   boot, fingerprint matches, document differs → the revert happened while
 *     dsh was down: replay the snapshot through ConfigEditor.edit(), the
 *     official hot-apply path (file lock, YAML row upsert, reconcile,
 *     atomic write, rollback on failure);
 *   fingerprint differs → nix really changed (just local) → nix wins:
 *     adopt the current document as the new baseline;
 *   live document edits (Settings saves, observed through
 *     app-boot/config-reload / loader/volatile-update) → adopt immediately.
 *
 * Fail-open: every path is wrapped; errors are logged and never thrown at
 * boot. The snapshot directory (0700) and file (0600) hold the raw document,
 * so treat them as sensitive: profile patches can contain tokens.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SCHEMA = 1
const LOG_PREFIX = 'dsh-settings-persist:'

/** @typedef {{schema: number, profile?: string, fingerprint: string, documentText: string, rows: Array<{id: string, name?: string, config: object}>}} PersistState */

/**
 * Decide what to do with the live document.
 *
 * - `adopt`  – the live document is the new truth (first run, nix changed,
 *   or a live edit seen outside the boot window).
 * - `restore`– a managed-profile revert was detected during boot: replay the
 *   snapshot.
 * - `noop`   – nothing changed.
 *
 * @param {{state?: PersistState|null, currentFingerprint: string, currentText: string, bootMode: boolean}} input
 * @returns {'adopt'|'restore'|'noop'}
 */
export function decideAction({ state, currentFingerprint, currentText, bootMode }) {
  if (!state || typeof state !== 'object' || state.schema !== SCHEMA) return 'adopt'
  const drift = state.fingerprint !== currentFingerprint || state.documentText !== currentText
  if (!bootMode) return drift ? 'adopt' : 'noop'
  // Boot window: fingerprint mismatch means nix changed → nix wins.
  if (state.fingerprint !== currentFingerprint) return 'adopt'
  return state.documentText !== currentText ? 'restore' : 'noop'
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
 * Match snapshot rows against the currently active entries.
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

/** $DSH_HOME/settings-persist/<profile>.json, derived from the profile document. */
export function statePathFor(documentPath) {
  const profileDir = path.dirname(documentPath)
  const profileKey = path.basename(profileDir)
  return path.join(path.dirname(path.dirname(profileDir)), 'settings-persist', `${profileKey}.json`)
}

async function start(ctx, configEditor) {
  const logger = ctx.logger ?? console
  const documentPath = configEditor.documentPath
  const profileDir = path.dirname(documentPath)
  const profileKey = path.basename(profileDir)
  const fingerprintPath = path.join(profileDir, '.nix-managed')
  const statePath = statePathFor(documentPath)

  let bootMode = true
  let restoring = false
  let chain = Promise.resolve()
  const schedule = () => {
    chain = chain.then(handle, handle)
  }

  const readText = (file) => readFile(file, 'utf8').catch(() => null)

  async function readState() {
    try {
      const raw = await readFile(statePath, 'utf8')
      const state = JSON.parse(raw)
      return state && state.schema === SCHEMA && typeof state.documentText === 'string' ? state : null
    } catch {
      return null
    }
  }

  async function writeState(state) {
    await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
    const tmp = `${statePath}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, statePath)
    await chmod(statePath, 0o600)
  }

  async function snapshot({ text, fingerprint }) {
    try {
      const rows = captureRows(configEditor.configuration())
      await writeState({
        schema: SCHEMA,
        profile: profileKey,
        fingerprint,
        documentText: text,
        rows,
        updatedAt: new Date().toISOString(),
      })
      bootMode = false
    } catch (error) {
      logger.error?.(`${LOG_PREFIX} snapshot failed:`, error)
    }
  }

  async function handle() {
    if (restoring) return
    const currentText = await readText(documentPath)
    if (currentText === null) return
    const currentFingerprint = (await readText(fingerprintPath)) ?? ''
    const state = await readState()
    const action = decideAction({ state, currentFingerprint, currentText, bootMode })

    if (action === 'noop') {
      bootMode = false
      return
    }

    if (action === 'adopt') {
      await snapshot({ text: currentText, fingerprint: currentFingerprint })
      return
    }

    // action === 'restore' (boot window only): replay snapshot rows.
    restoring = true
    let failed = false
    try {
      const { plan, missing } = buildRestorePlan(state.rows, configEditor.entries())
      if (missing.length > 0) {
        logger.warn?.(`${LOG_PREFIX} no active entry for: ${missing.join(', ')} (rows kept for a later boot)`)
      }
      // Nothing restorable: keep the old state and retry on a later event
      // instead of adopting the reverted document.
      if (plan.length === 0 && (state.rows?.length ?? 0) > 0) failed = true
      for (const item of plan) {
        try {
          await configEditor.edit(item.entry, () => structuredClone(item.config))
        } catch (error) {
          failed = true
          logger.error?.(`${LOG_PREFIX} restore of "${item.id}" failed:`, error)
        }
      }
    } catch (error) {
      failed = true
      logger.error?.(`${LOG_PREFIX} restore failed:`, error)
    } finally {
      restoring = false
    }
    if (failed) return // keep bootMode and the old state; retry later

    const settledText = await readText(documentPath)
    if (settledText === null) return
    const settledFingerprint = (await readText(fingerprintPath)) ?? ''
    await snapshot({ text: settledText, fingerprint: settledFingerprint })
  }

  ctx.on('app-boot/config-reload', schedule)
  ctx.on('loader/volatile-update', schedule)
  const bootstrap = setTimeout(schedule, 1000)
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
