# dsh-settings-persist

Keep DeepSeek Harness **Settings edits alive across launches** on nix
**managed** profiles — with an auto backup and a snapshot management page.

## The problem

DSH's Settings UI persists edits into the profile's `cordis.patch.yml`. On a
managed profile (`programs.dsh.profiles.<name>.mode = "managed"`, the default),
the nix wrapper `dsh-seed-profile → dsh-sync-profiles` reverts that file to the
nix snapshot before every launch — so anything you configure in the UI
(subscriptions, toggles, paths …) is gone after a restart. Every plugin that
stores settings through the Settings UI hits this.

v1 additionally gated the restore on the `.nix-managed` fingerprint: any nix
rebuild rotates store paths inside the document, which changed the fingerprint
and made the plugin adopt the reverted document — **silently losing the
settings it exists to keep**. v2 removes that gate.

## What this plugin does

A zero-dependency DSH plugin with a headless host half and a browser page.
State lives per profile under `$DSH_HOME/settings-persist/<profile>/`
(dir `0700`, files `0600` — profile patches can contain tokens):

| path | role |
| --- | --- |
| `auto.json` | rolling **auto backup**: written on every live Settings save, replayed at every boot |
| `snapshots/<id>.json` | **manual snapshots**: created / restored / deleted only from the settings page |

| situation | verdict | action |
| --- | --- | --- |
| boot, auto document differs | sync reverted the document (restart **or rebuild**) | replay the auto backup via `ConfigEditor.edit()` |
| boot, documents identical | — | noop |
| document changed during a live session | your Settings save | adopt immediately (rewrite `auto.json`) |
| snapshot restored from the page | your explicit action | replay it, then refresh `auto.json` |

Restore goes through `ConfigEditor.edit()`, the official hot-apply path: file
lock, YAML row upsert, reconcile with rollback on failure. Rows whose entries
are no longer active (a nix rebuild dropped the bundle) are skipped and
reported — that is the only nix-wins guard still applied. Failed restores
keep the old auto backup and retry on the next config event — the plugin
fails open and never blocks boot.

Resulting semantics for the three edit channels:

- **nix yml** (`modules/.../dsh/<profile>.yml` + `just local`) — declarative;
  its values are restored over by `auto.json` at the next boot *unless* you
  reset the auto backup (page button) or delete `auto.json` first;
- **Settings UI** — durable across restarts **and rebuilds**;
- **hand edits of the managed file** — still ephemeral (by design, matching
  the upstream comment in the repo ymls).

## Snapshot page

Settings → **设置快照 / Settings Snapshots**: the auto backup card (last
write, row count, matches-current, restore now, rebuild-from-current) plus a
manual snapshot list with create / restore / delete. The page polls the
plugin's own JSON routes every few seconds:

```
GET  /settings-persist/state        inventory (auto + manual metadata)
POST /settings-persist/snapshot     create {name?}
POST /settings-persist/restore      {id: "<snapshot id>" | "auto"}
POST /settings-persist/delete       {id}          (manual only)
POST /settings-persist/reset-auto   rebuild auto from the live document
```

Routes register on both carriers (Web `webServer` + Desktop `connection`
`/api` bridge), the same transport pairing as `dsh-bas-remote`. The page is a
classic `window.__ModuleLoader__.load` script registered into the generic
`settings.section` slot — the stable recipe that has survived dsh UI changes
in `dsh-bas-remote`, with no bundler step (`lib/client.js` is the artifact).

## Seeding (one time, before first deploy)

The first launch with this plugin deployed happens *after* sync has already
reverted the document, so seed the current live document first:

```sh
DSH_KERNEL_NM=/nix/store/…-dsh-<version>/lib/deepseek-harness/node_modules \
  node scripts/seed.mjs ~/.dsh/profiles/<profile> [--dry-run] [--force]
```

(Or `npm install` in the repo instead of setting `DSH_KERNEL_NM`, so the
script can resolve `yaml` itself.)

Existing v1 files (`settings-persist/<profile>.json`) migrate to
`auto.json` automatically on first boot.

## Build / test

```sh
npm test                # = node --test test/*.test.js: unit tests (decision
                        # logic, paths, inventory) + boot/routes integration
```

Bundled by nix via `pkgs.dsh.buildDshBundle` (see `dsh-worktree` in
nur-DataEraserC for the same shape), then added to the profile's
`bundles` list.

## Limits

- Rows belonging to entries that are not active at boot are skipped and
  logged; they stay in the auto backup, so they can apply again if the entry
  returns.
- A Settings save landing inside the (millisecond) window where boot restore
  is still retrying can be overwritten by the restore; re-save afterwards.
- Headless/CLI compositions without `profileContext` never start the plugin.
- The routes carry the raw profile document metadata on the local machine's
  own server (same trust model as other dsh plugin routes); the state
  directory stays `0700`/`0600`.
