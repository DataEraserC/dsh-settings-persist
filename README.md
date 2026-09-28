# dsh-settings-persist

Keep DeepSeek Harness **Settings edits alive across launches** on nix
**managed** profiles.

## The problem

DSH's Settings UI persists edits into the profile's `cordis.patch.yml`. On a
managed profile (`programs.dsh.profiles.<name>.mode = "managed"`, the default),
the nix wrapper `dsh-seed-profile → dsh-sync-profiles` reverts that file to the
nix snapshot before every launch — so anything you configure in the UI
(subscriptions, toggles, paths …) is gone after a restart. Every plugin that
stores settings through the Settings UI hits this; the
`dsh-seed-profile → dsh-sync-profiles` wrapper decides it by a
`.nix-managed` fingerprint check.

## What this plugin does

A headless, zero-dependency DSH plugin that keeps a private snapshot per
profile at `$DSH_HOME/settings-persist/<profile>.json` (dir `0700`,
file `0600` — profile patches can contain tokens) plus the profile's
`.nix-managed` fingerprint:

| situation | verdict | action |
| --- | --- | --- |
| boot, fingerprint matches, document differs | revert while dsh was down | replay snapshot rows via `ConfigEditor.edit()` |
| fingerprint differs | nix really changed (`just local`) | **nix wins** — adopt the current document |
| document changed during a live session | your Settings save | adopt immediately (next snapshot) |
| nothing changed | — | noop |

Restore goes through `ConfigEditor.edit()`, the official hot-apply path: file
lock, YAML row upsert, reconcile with rollback on failure. Failed restores
keep the old snapshot and retry on the next config event — the plugin fails
open and never blocks boot.

Resulting semantics for the three edit channels:

- **nix yml** (`modules/.../dsh/<profile>.yml` + `just local`) — declarative, always wins when it changes;
- **Settings UI** — durable across restarts;
- **hand edits of the managed file** — still ephemeral (by design, matching the upstream comment in the repo ymls).

## Seeding (one time, before first deploy)

The first launch with this plugin deployed happens *after* sync has already
reverted the document, so seed the current live document first:

```sh
DSH_KERNEL_NM=/nix/store/…-dsh-<version>/lib/deepseek-harness/node_modules \
  node scripts/seed.mjs ~/.dsh/profiles/<profile> [--dry-run] [--force]
```

(Or `npm install` in the repo instead of setting `DSH_KERNEL_NM`, so the
script can resolve `yaml` itself.)

## Build / test

```sh
node --test test/     # unit tests for the decision logic
```

Bundled by nix via `pkgs.dsh.buildDshBundle` (see `dsh-worktree` in
nur-DataEraserC for the same shape), then added to the profile's
`bundles` list.

## Limits

- Rows belonging to entries that are not active at boot are kept in the
  snapshot and retried on a later boot; they are never dropped.
- A Settings save landing inside the (millisecond) window where boot restore
  is still retrying can be overwritten by the restore; re-save afterwards.
- Headless/CLI compositions without `profileContext` never start the plugin.
