---
slug: marketplace-dev-link
id: 261003-184400
created: 2026-10-03
status: specified
linearIssue: DOR-2696
---

# Dev link: run a marketplace package from a working folder

**Status:** Draft (three product decisions open for Dorian, see "Decisions for Dorian")
**Author:** Claude Code (SPECIFY stage, /flow)
**Date:** 2026-10-03

## Overview

A **dev link** makes DorkOS run a marketplace `plugin` or `skill-pack` straight from a folder on
the owner's computer. The owner approves the folder once, on a card that names its absolute path.
From then on DorkOS loads the package from that folder, and an edit there reaches the running
DorkOS within seconds: extensions recompile and restart, skills and commands re-project to every
agent tool, and the next session picks up hooks and servers. No reinstall, no new approval per
edit.

A dev link is its own install kind. It is badged "Dev link: <path>" everywhere the package shows
up, it never counts as the published version, it never satisfies a trusted origin or a digest pin,
and only a person can create one. An installed copy of the same package is set aside, never
deleted, and comes back on unlink.

## Background / Problem Statement

Prototyping a marketplace plugin today means reinstalling and re-approving on every edit (DOR-2696,
Dorian 2026-10-03). The install path stages the files, records a content hash and, for a project
install, a digest of the whole folder (`services/marketplace/lib/install-digest.ts`); anything
edited afterwards is either invisible (the installed copy is a snapshot) or treated as tampering
(`extension-trusted-origin.ts` reports `problem: 'changed'`, and `extension-load-policy.ts`
requires an approval pinned to the new digest, so every edit asks again). The Flow Dashboard
(DOR-2690) is being built as a bare dev extension for this reason, outside its plugin.

There is a half-built precedent. A **hand-built linked install** (DOR-2194: the slot
`~/.dork/plugins/<name>` is a symlink to a working copy) is understood by the installed scanner
(`linked`), the update check (never reinstalled), uninstall (removes the link only), global consent
(approved by `linked:<realpath>`), and extension discovery. But:

1. Nothing creates one. A developer runs `ln -s` by hand.
2. **Harness Sync never projects it.** `packages/harness/src/sources/installed.ts`
   `scanPluginsRoot` keeps only `Dirent.isDirectory()` entries, which is `false` for a symlink, so
   a linked plugin's skills and commands silently reach no agent tool.
3. **An install silently replaces it.** The install transaction moves whatever sits at the target
   aside as the backup and deletes it on commit (`transaction.ts`), link included.
4. **At project scope, approvals alias.** An extension approval binds id + directory + carrying
   plugin (`approvedSourceOf`). A link at the same slot has the same directory and plugin name, so
   an approval given to the installed copy would match the link's files.
5. Nothing reloads on change, and nothing shows the person that a package is running from a folder.

Success is the ticket's "Done when": edit a file in a linked plugin's working folder → within
seconds the running DorkOS uses it, with no reinstall and no new approval; the Marketplace page
shows the dev badge and the path; unlinking restores the installed copy or removes the plugin; an
installed copy is never replaced by a dev link's files without the explicit switch.

## Goals

- `link`: a person turns a folder into the running copy of a `plugin` or `skill-pack`, at global or
  project scope, from the app, the terminal, or by approving an agent's request on a card that
  names the absolute path.
- Hot reload within seconds of an edit, through the existing seams: `ExtensionManager.reloadExtension`
  / `requestRefresh` (the seam `reload_extensions` and `test_extension` ride), Harness Sync
  re-projection, and the marketplace's post-change notifier.
- One approval: the link card covers what the folder runs at link time; editing never asks again;
  something new it starts running (a new extension, hook or server) asks once, through the card
  that already exists for it.
- Badged everywhere: Marketplace (Installed row, package sheet, browse card), Settings →
  Extensions, and the `/x/<extensionId>` page host (the Flow tab).
- Harness Sync projects a registered dev link exactly like an install, labels each projection as
  dev, and un-projects on unlink.
- `unlink`: restores the parked installed copy (and the approvals it had) or removes the package.
- `dorkos marketplace link <path>` / `unlink <name>`; MCP `marketplace_link` (destructive).
- `dorkos doctor` and `GET /api/health/deep` list dev links and whether each folder exists.
- Installed copies keep exactly today's trust: no path, origin, digest or source approval ever
  crosses between an installed copy and a dev link.

## Non-Goals

- Publishing (git push, opening a PR against a marketplace repo). The badge's action switches the
  running copy to a published one (see Decision for Dorian 3).
- `agent`, `adapter` and `shape` packages. Agents register with Mesh on install; adapters load
  through Relay's own loader (`packages/relay/src/adapter-plugin-loader.ts`). Each needs its own
  design. `link` refuses them with a sentence.
- Sandboxing dev-linked code (DOR-2686). A dev-linked extension runs in-process like any approved
  extension.
- Late-registered extension tools and skills (DOR-2685). When it lands, it rides the same reload.
- Changing how hand-built links (DOR-2194) behave. `link` on the same path adopts one.
- Syncing dev links across machines, or committing them. A dev link is machine-local by design.

## Technical Dependencies

- `chokidar` (already a server dependency; `services/harness/skills-watcher.ts` is the reference
  usage, including its measured drop rates and the sweep + re-arm backstop).
- Node `fs.symlink(target, path, 'junction')` on Windows, `'dir'` elsewhere. The harness's
  `apply/windows-links.ts` documents junction behaviour (absolute target text, no privilege).
- No new packages.

## Detailed Design

### Architecture changes

```
person (app dialog | terminal | agent card)
  └─ marketplace.link capability  (destructive, area: null)
       └─ DevLinkService.link
            ├─ validate folder + slot + boundary
            ├─ park installed copy:  <slot> → <slot>.dorkos-devlink-parked
            ├─ create link:          <slot> → <realpath>   (symlink | junction)
            ├─ write registry:       {dorkHome}/marketplace/dev-links.json
            ├─ record the person's yes for what it runs today
            └─ notify: onPluginsChanged + extensionManager.requestRefresh
  DevLinkWatcher (one chokidar watch per registered link, on its realpath)
       └─ on change (debounced): reloadExtension | re-project | refresh plugins
            └─ SSE marketplace_dev_link_reloaded (+ existing extension_reloaded)
```

The link sits at the package's normal slot (`{dorkHome}/plugins/<name>` or
`<project>/.dork/plugins/<name>`), so every path a package uses (`${CLAUDE_PLUGIN_ROOT}`, the
`.dork/plugins/<name>` relDir the projector writes, the extension directory) is unchanged. The
**registry** is what makes it a dev link rather than a hand-built link: a record DorkOS writes only
on a person's yes, read by the server, the harness engine and the CLI through one schema.

**A slot counts as dev-linked only while all three hold:** the registry has a record for it, the
slot is a symlink or junction, and `realpath(slot) === record.target`. A retargeted link (an agent
running `ln -sfn /elsewhere <slot>`) fails the third test and is treated as an unregistered link:
no harness projection, no dev-link approvals, held back by global consent.

### Implementation approach

#### 1. Registry (`{dorkHome}/marketplace/dev-links.json`)

Schema in `@dorkos/shared/marketplace-schemas` (no new subpath), so the server, `@dorkos/harness`
and the CLI parse one shape:

```ts
export const DevLinkRecordSchema = z.object({
  name: PackageNameSchema, // from the folder's manifest at link time
  type: z.enum(['plugin', 'skill-pack']),
  scope: z.enum(['global', 'project']),
  projectPath: z.string().optional(), // canonical; required when scope is 'project'
  slot: z.string(), // absolute path of the link
  target: z.string(), // realpath of the working folder
  parked: z.string().optional(), // absolute path of the set-aside installed copy
  restoreApprovals: z
    .object({
      // what unlink puts back for the parked copy
      extensions: z.record(z.string(), ExtensionApprovedSourceSchema).optional(),
      globalActivation: z.array(z.string()).optional(), // stored `<name>@global-<digest>` entries
    })
    .optional(),
  linkedAt: z.string(), // ISO-8601
  linkedVia: z.enum(['app', 'terminal', 'agent-card']),
});
export const DevLinksFileSchema = z.object({
  version: z.literal(1),
  links: z.array(DevLinkRecordSchema),
});
```

Writes are serialised in-process and land by fsynced atomic rename, exactly as
`lib/project-install-index.ts` does. A file that does not parse is refused by every reader (no
slot counts as dev-linked, the listing says so, doctor warns); the next successful `link` moves it
aside to `dev-links.json.corrupt-<time>`. Readers: `services/marketplace/dev-links/registry.ts`
(async, server) and a small sync reader in `@dorkos/harness` (`sources/dev-links.ts`) and the CLI.

#### 2. `DevLinkService` (`services/marketplace/dev-links/dev-link-service.ts`)

`preview({ path, scope, projectPath })` (read-only), `link({ … , replaceInstalled, via })`,
`unlink({ name, scope, projectPath })`, `list()`, `reconcile()`.

**Validation, in order, each refusal a typed error with one plain sentence:**

1. `path` is absolute and `realpath(path) === path` (`dev_link_path_not_real`, carrying the real
   path to retry with). The card must name where the code actually lives.
2. It is a directory, readable, inside the directory boundary when one is configured
   (`lib/boundary.ts`), and not inside `{dorkHome}` (`dev_link_path_not_allowed`).
3. It has a package identity (`readInstalledIdentity`, the same reader the installed list uses:
   `.dork/manifest.json` or `.claude-plugin/plugin.json`) and passes the package validator
   (`dev_link_not_a_package`, with the validator's first problem).
4. Its type is `plugin` or `skill-pack` (`dev_link_unsupported_type`).
5. Project scope: `projectPath` goes through the router's existing boundary helper and must be a
   known project or an existing directory.
6. No other dev link for the same name in the same scope (`dev_link_exists`).
7. The slot: empty → fine. Holds an unregistered link whose realpath equals `path` → adopt it (no
   parking). Holds an unregistered link elsewhere → refuse (`dev_link_slot_is_linked`). Holds an
   installed copy → refuse unless `replaceInstalled: true` (`dev_link_slot_taken`, carrying the
   installed version). Holds a parked sibling already → refuse (`dev_link_parked_exists`).

**Link**, under `withInstallTargetLock(slot)` (the per-target lock install and uninstall take, DOR-711):

1. If replacing: `rename(slot, slot + '.dorkos-devlink-parked')` (same directory, so atomic and
   same filesystem). Capture the parked copy's current extension approvals and global-activation
   entries into `restoreApprovals`.
2. `symlink(target, slot, platform === 'win32' ? 'junction' : 'dir')`.
3. Write the registry record. If any step fails, undo the earlier ones in reverse (remove the link,
   rename the parked copy back) before rethrowing.
4. Record the person's yes for what it runs today (§4).
5. `onPluginsChanged({ projectPath })` and `extensionManager.requestRefresh()`; start the watcher.

**Unlink**, under the same lock: stop the watcher; remove the link (`unlink` for a symlink,
`rmdir` for a junction: never a recursive delete, which on a junction would empty the developer's
folder); if `parked`, rename it back and restore `restoreApprovals` (each extension entry only when
the id's current approval is still the dev-link one; the global entries verbatim, since they bind
the parked copy's recorded content hash, which is unchanged); forget the dev-link approvals; drop
the record; notify as above. Result: `{ restored: 'installed' | 'removed' }`.

**Reconcile** (boot, and before every `list()`): for each record, report one of `active`,
`folder-missing` (target gone), `link-missing` (slot gone), `link-replaced` (slot is a real folder
or points elsewhere). Reconcile never repairs on its own; the listing and doctor say what happened,
and `unlink` finishes the job from any state (it skips steps whose subject is already gone, and
never touches a slot that is no longer the recorded link).

**Install sibling marker.** Add `MARKETPLACE_DEVLINK_PARKED_MARKER = '.dorkos-devlink-parked'` to
`MARKETPLACE_INSTALL_SIBLING_MARKERS`, so every reader that lists packages, plugins, skills or
extensions skips the parked copy (installed scanner, harness `scanPluginsRoot`, extension
discovery, `readTrustedInstalls`). The name carries no `<timestamp>-<uuid>` stamp, so recovery and
the backup janitor leave it alone (`isInstallSiblingName` docs: "a name that carries a marker but
not the full stamp is still hidden from readers, while recovery leaves it alone"). A test pins both.

**Guards elsewhere** (each refuses with `package_is_dev_linked`, 409, "Flow runs from a dev link.
Unlink it first."):

- `MarketplaceInstaller` install into a dev-linked slot (today it would delete the link).
- `UpdateFlow`: a registered dev link is checked as `unknown` with the note `Dev link — runs from
your folder`, never applied (hand-built links keep `LINKED_INSTALL_NOTE`).
- `UninstallFlow`: refused for a registered dev link (unlink is the verb; it knows about the parked
  copy). Hand-built links keep today's remove-the-link behaviour.

#### 3. Trust: a dev link never borrows an installed copy's trust, and never lends its own

- **Trusted origin** (`extension-trusted-origin.ts`): `proveOrigin` gains an input
  `devLinkedRoots: ReadonlySet<string>` (from the registry, read once per discovery pass). A copy
  whose install root is in it returns `{ origin: null, problem: 'dev-link', pinnedDigest: null }`
  **before** any record or digest check, at both scopes. So trusted sources (`trustSource`) never
  cover it, it never runs from a snapshot (`extension-snapshots.ts` is only for origin copies), and
  the parked copy's `project-installs.json` digest is never compared against the link.
  `OriginProblem` and `ExtensionRecord.originProblem` (`@dorkos/extension-api`) widen to
  `'changed' | 'linked' | 'dev-link'`; the record also carries `devLink?: { path: string }`.
- **Load policy** (`extension-load-policy.ts`): `ExtensionApprovedSourceSchema` gains optional
  `devLink: string` (the target realpath). `approvedSourceOf` sets it for a dev-linked copy.
  `isApprovedByPath` requires `source.devLink === copy.devLink?.path` (both absent, or equal), so
  an installed copy's approval never covers a link at its path, and a link's approval never covers
  the installed copy put back after unlink. A dev-linked copy is approved by path alone: no digest,
  so edits never ask. `isApprovedByOrigin` is unreachable for it (origin is null). This is an
  additive optional config field; follow the `adding-config-fields` skill (schema, docs, test; no
  default to declare, so no migration unless the skill's checklist says otherwise).
- **Global consent** (`consent/global-plugin-consent.ts`): a registered dev link is already a
  linked install, bound by `linked:<realpath>`. Nothing changes in matching. The link-time yes
  (§4) is recorded through `recordApprovedEntry`, the same store and format.
- **Telemetry and versions:** a dev link emits no install telemetry, has no `install-metadata.json`
  written by DorkOS, and is never the "installed version" the browse card or update check compares
  against.

#### 4. One approval at link time

What the folder runs is read with the same readers the install preview uses
(`preview/disclosed-effects.ts` `disclosedEffectsOf`, plus the extension ids under
`.dork/extensions/`). The preview returns it; the card shows it; on a yes, `link` records:

- for each extension id found: `approvedToRun += id`,
  `approvedSources[id] = { path: <slot>/.dork/extensions/<id>, plugin: name, devLink: target }`;
- global scope: a global-activation yes bound to `linked:<target>` and the current declarations;
- project scope: hook-consent approvals for the plugin's current hooks (`harness/hook-consent.ts`).

A yes covers what was shown. Something new later (a new extension id, a new hook, a new server) is
a different thing and asks once through its existing card: the extension approval inbox, the
held-back card, or the hook consent card. Editing what was shown never asks. (This is Decision for
Dorian 1's recommended option.)

#### 5. Harness Sync

- `scanInstalledSources(opts)` gains `devLinks?: readonly DevLinkRecord[]`. `scanPluginsRoot`
  accepts a symlinked entry **only** when a record names that exact slot and
  `realpathSync(slot) === record.target`; every other link is skipped as today (the containment
  rule in `collectPortableSkills` stands: a link a repo committed must never project a private
  folder). Inside the package, scans keep `followSymlinks: false`.
- `InstalledPlugin` gains `devLink?: { path: string }`.
- The projector labels: each generated command wrapper gets a second marker line
  `<!-- dorkos:dev-link <target> -->` beside `GENERATED_COMMAND_MARKER`; managed hook groups carry
  `_dorkosDevLink: "<target>"` beside `_dorkosHarness`; the plan, `dorkos harness sync --check` and
  the harness status route (`services/harness/status.ts`) mark each dev-linked package
  `(dev link: <path>)`. Skill symlink names stay `<pkg>__<name>` (renaming would change skill ids);
  the status listing is where a reviewer reads that a skill came from a dev link.
- Callers that pass `devLinks`: `runAutoProjection`, `skills-watcher.ts`, `project-with-consent.ts`,
  `dorkos harness sync`. Each reads the registry through the shared reader; a missing `dorkHome`
  means no dev links (and no global scope), exactly as today.
- Un-project on unlink: unlink calls `onPluginsChanged`, whose projection run either sweeps the
  orphaned projections (package removed) or rewrites them for the restored installed copy (dev
  markers gone, same relDir).

#### 6. Hot reload (`services/marketplace/dev-links/dev-link-watcher.ts`)

One chokidar watch per active record, on `target`, with `ignoreInitial: true`, ignoring `.git/`,
`node_modules/`, and every runtime-state path (`isRuntimeStatePath` from `lib/content-hash.ts`).
Events are collected per link and flushed after a 300 ms quiet period, then classified by the path
relative to `target`:

| Changed path                                                                                                                                                          | Action                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.dork/extensions/<id>/**` (id known)                                                                                                                                 | `extensionManager.reloadExtension(id)` when it is enabled and may run; else nothing                                                                                              |
| a new or removed `.dork/extensions/<id>/`                                                                                                                             | `extensionManager.requestRefresh()`                                                                                                                                              |
| `skills/**`, `.dork/tasks/**`, `commands/**`, `hooks/**`                                                                                                              | harness re-projection for the link's scope (project root, or the global projection)                                                                                              |
| `.dork/manifest.json`, `.claude-plugin/plugin.json`, `hooks/**`, `bin/**`, and every other file `readRunnableDeclarations` reads (MCP and language servers, monitors) | `onPluginsChanged({ projectPath })`: refreshes the runtime's plugin list and re-checks global consent, so the next session picks it up and a new declaration is held back to ask |

A compile error from `reloadExtension` is not a watcher failure: it is reported on the extension
(as today) and in the event. The watcher also re-arms every 60 s and sweeps (compares a cheap
listing of the watched roots) so a dropped event or a recreated folder is still caught, following
`skills-watcher.ts`. If `target` disappears, the record reports `folder-missing` and the watch is
re-armed by the sweep when it comes back.

After each flush the server broadcasts `marketplace_dev_link_reloaded`
`{ name, scope, projectPath?, at, actions: ('extension' | 'projection' | 'plugins')[], errors?: string[] }`
on the global event stream, so the badge can say "Reloaded 4s ago" and the Installed query is
invalidated. `extension_reloaded` keeps doing what it does.

The extension compiler writes its output to the build cache under `{dorkHome}`, never into the
extension directory (`extension-build-cache.ts`), so a reload cannot trigger itself. A test pins
that no write under `target` happens during a reload.

### Code structure & file organization

```
packages/shared/src/marketplace-schemas.ts            + DevLinkRecordSchema, DevLinksFileSchema,
                                                        DevLinkStatus, marker constant
packages/shared/src/config-schema.ts                  + ExtensionApprovedSource.devLink
packages/extension-api/src/types.ts                   originProblem + 'dev-link'; devLink field
apps/server/src/services/marketplace/dev-links/
  registry.ts                                         read/write dev-links.json (atomic)
  dev-link-service.ts                                 preview/link/unlink/list/reconcile
  dev-link-watcher.ts                                 chokidar + sweep + classify + broadcast
  errors.ts                                           typed refusals
  index.ts
apps/server/src/services/marketplace/installer/…      install guard
apps/server/src/services/marketplace/flows/update.ts  dev-link note
apps/server/src/services/marketplace/flows/uninstall/ refusal
apps/server/src/services/marketplace/installed-scanner.ts   InstalledPackage.devLink
apps/server/src/services/extensions/extension-trusted-origin.ts, extension-load-policy.ts,
  extension-discovery.ts, extension-manager.ts (pass devLinkedRoots; record field)
apps/server/src/services/marketplace-mcp/tool-link.ts + marketplace-capabilities.ts
apps/server/src/routes/marketplace/dev-links.ts       route group, mounted in marketplace.ts
apps/server/src/services/core/openapi-registry.ts     + docs/api/openapi.json regenerated
packages/harness/src/sources/dev-links.ts, sources/installed.ts, plan/installed-projector.ts
packages/cli/src/commands/marketplace-link.ts, marketplace-unlink.ts, marketplace-dispatcher.ts,
  marketplace-installed.ts (marker), doctor-checks.ts (+ health/deep)
apps/client/src/layers/entities/marketplace/          useDevLinks, useLinkFolder, useUnlink
apps/client/src/layers/features/marketplace/ui/       DevLinkBadge, LinkFolderDialog,
                                                        UnlinkDialog; Installed row, sheet, card
apps/client/src/layers/features/extensions/ui/ExtensionCard.tsx   dev-link badge
apps/client/src/layers/widgets/extension-page/        dev-link strip on /x/<id>
```

`DevLinkBadge` lives in `features/marketplace` and is exported from its barrel; the extensions
feature and the extension-page widget may not import a sibling feature (FSD), so the badge's
presentational part goes in `shared/ui` (`DevLinkTag`: tag + path, no data), and each surface
passes the path it already has.

### API changes

All under `/api/marketplace`, registered in the OpenAPI registry, docs regenerated.

| Route                          | Bar                                                    | Body / answer                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /dev-links/preview`      | none (read-only)                                       | `{ path, scope, projectPath? }` → `{ name, type, version?, path, scope, slot, replaces: { version } \| null, effects, extensions: string[] }`, or the typed refusal (400/403/409) |
| `POST /dev-links`              | `marketplace.link` gate via `ctx` (202 card, 403, run) | `{ path, scope, projectPath?, replaceInstalled? }` + `X-DorkOS-Approval` on retry → `201 DevLinkStatus`                                                                           |
| `GET /dev-links`               | none                                                   | `{ links: DevLinkStatus[], registryUnreadable?: string }`                                                                                                                         |
| `POST /dev-links/:name/unlink` | `trustedCaller` (as `/held-back/:name/decision`)       | `{ scope, projectPath? }` → `{ restored: 'installed' \| 'removed' }`                                                                                                              |

`DevLinkStatus = { name, type, scope, projectPath?, path, state: 'active' | 'folder-missing' |
'link-missing' | 'link-replaced', parked: { version? } | null, linkedAt, lastReloadAt? }`.

`InstalledPackage` gains `devLink?: { path: string; state: DevLinkStatus['state']; parked: boolean }`;
a registered dev link no longer sets `linked: true` (it is not a hand-built link). A record whose
slot no longer resolves still appears in the installed list, built from the registry, so a
missing folder is a visible row, never a vanished package.

**Capability** `marketplace.link` in `marketplace-capabilities.ts`:

```ts
defineCapability({
  id: 'marketplace.link',
  title: 'Run a package from a folder',
  description:
    'Run a plugin or skill pack from a folder on this computer, reloading on every edit. ' +
    'A person must approve the exact folder. Pass an absolute path. Use projectPath for one project.',
  tier: 'destructive',
  area: null,
  areaNote: 'Always asks: a dev link runs a folder’s code unreviewed on every edit, so no setting may pre-approve it.',
  input: z.object({ path: z.string(), projectPath: z.string().optional(), replaceInstalled: z.boolean().optional() }),
  approvalDisplayFields: ['path', 'projectPath', 'replaceInstalled'],
  approvalDetailField: 'path',
  surfaces: { mcp: { toolName: 'marketplace_link', servers: ['in-session', 'external'] } },
  invoke: …
});
```

`destructive` means the tier gate requires a person's approval bound to this capability and this
exact input on every call, whatever the caller's identity (`tier-enforcement.ts`); `area: null`
means no Allowed setting or "Always allow" can pre-approve it. The implementation must prove the
second property with a test (an "Always allow" recorded on a `marketplace_link` card does not let
the next call run). Adding the verb trips the two claude-code tool-count census guards by design;
decide it as a deferred (not always-loaded) tool, since only plugin authors use it. Unlink and
list are not MCP tools in v1: the installed list carries `devLink`, and unlinking is the owner's.

### Data model changes

- New file `{dorkHome}/marketplace/dev-links.json` (above).
- `extensions.approvedSources[id].devLink?: string` (optional, additive).
- `ExtensionRecord.originProblem` adds `'dev-link'`; `ExtensionRecord.devLink?: { path }`.
- `InstalledPackage.devLink?`.
- Harness: `InstalledPlugin.devLink?`; command wrapper dev marker; hook group `_dorkosDevLink`.

### CLI

```
dorkos marketplace link <path> [--project <path>] [--replace-installed] [--yes] [--approval <token>] [--json]
dorkos marketplace unlink <name> [--project <path>] [--json]
```

- `link` resolves `<path>` against the caller's cwd and to its real path, calls preview, prints the
  name, the real path, what it runs and what it replaces, and asks `Run <name> from <path>?` (TTY;
  `--yes` skips the question for scripts). Then `POST /dev-links`. An agent caller (carrying
  `DORKOS_AGENT_TOKEN`) gets `approval_required` back and the retry line, exactly as
  `dorkos marketplace uninstall` does.
- `unlink` prints what comes back ("Your installed copy of flow is back." / "flow removed. Your
  folder was not touched.").
- `dorkos marketplace installed` marks dev links `dev link → <path>` and a missing folder.
- `dorkos doctor`: a `Dev links` check (reads the registry file directly, no server needed):
  `ok` with none, or all active (each listed); `warn` naming each record not `active` with the fix
  (`dorkos marketplace unlink <name>`); `warn` when the registry does not parse. The same
  `CheckResult` is returned by `GET /api/health/deep`.

## User Experience

All copy follows `writing-app-copy`: at most 15 words a block, no "we", exact-action buttons. The
nouns are "dev link", "folder", "installed copy". No code names.

**Link from the app.** Marketplace → Installed → toolbar "Link a folder". A dialog:

1. Path field (paste; in the desktop app a Browse button uses the existing folder picker), and the
   same scope choice the install dialog offers (This computer / a project).
2. On blur, preview runs. A refusal shows inline under the field, keeping what was typed:
   "No package found in this folder." / "That path is a link. Use /real/path instead."
3. Ready state, the card:
   - Title: "Run Flow from this folder?"
   - Path, monospace, wrapping: `/Users/dorian/Keep/dork-os/marketplace/plugins/flow`
   - "Edits here run in DorkOS right away, without asking."
   - When replacing: "Your installed copy (v0.9.2) is set aside, not deleted." and a checkbox
     "Use my folder instead of the installed copy" that must be ticked (the explicit switch).
   - "It runs:" then the same disclosure list the install dialog shows.
   - Buttons: "Cancel", "Link folder".

**Link requested by an agent.** The approval card: "Scout wants to run Flow from a folder." The
path below it in monospace, then the same "Edits here run…" line and disclosure. Buttons "Don't
allow" / "Allow". No "Always allow" (see capability).

**Badged everywhere.**

- Installed row: a "Dev link" tag beside the name, then `Dev link: <path>` on its own wrapping line,
  then status: "Reloaded 4s ago", or "Couldn't reload: <extension> has a build error." with a
  Details toggle, or "Folder missing. Restore it or unlink." Actions: "Use installed copy" (parked
  copy exists), "Install published version" (no parked copy, the package is in a marketplace),
  "Unlink". No Update or Uninstall on a dev-linked row.
- Package sheet and browse card: "Dev link" replaces "Installed vX"; the sheet repeats the path and
  the same actions.
- Settings → Extensions: each extension the dev link carries shows the tag and `Dev link: <path>`,
  and "Use installed copy" / "Unlink" link to the Installed row.
- `/x/<extensionId>` (the Flow tab): a slim strip above the page: `Dev link: <path>` and "Use
  installed copy". It is quiet (muted text, no colour alarm): the owner chose this.

**Unlink.** Confirmation: title "Unlink Flow?"; body "Your installed copy comes back." or "Flow is
removed. Your folder is not touched."; buttons "Cancel", "Unlink". Success toast: "Flow runs from
the installed copy." / "Flow removed."

**Install published version** = unlink, then the normal install dialog for the package (preview,
disclosure, consent). If unlink succeeds and the install is cancelled, the package is simply not
installed, and the toast says so.

**Exit and error paths.** Folder deleted while linked → row stays, "Folder missing", Unlink works.
Registry unreadable → Installed shows one notice "Dev links can't be read right now." and doctor
names the file. Build error on reload → the extension shows its error as today; the previous good
bundle keeps running if the compiler keeps it (existing behaviour), and the badge says it did not
reload.

## Testing Strategy

Each test carries a purpose comment. Real filesystem in temp dirs (symlinks and junction shapes,
as `windows-links.ts` tests stage them), `FakeAgentRuntime` where a session is needed.

- **Unit (server)**
  - Registry: round-trip; torn/corrupt file refused by readers and moved aside on next write;
    concurrent writes serialised.
  - Service validation: each refusal in order, including `realpath` mismatch naming the real path,
    a path inside `{dorkHome}`, outside the boundary, an `agent` package, an existing dev link.
  - Link over an installed copy: refused without `replaceInstalled`; with it, the installed copy is
    parked byte-identical, its approvals captured; a failure after parking puts it back.
  - Unlink: restores parked copy and its approvals; removes a junction without touching the
    target's files (a test that would fail if `rm -r` were used); works from every reconcile state;
    never touches a slot that is no longer the recorded link.
  - Parked sibling is invisible to the installed scanner, harness scan, extension discovery and
    `readTrustedInstalls`, and untouched by recovery and the backup janitor.
  - Guards: install, update and uninstall each refuse a registered dev link; a hand-built link keeps
    today's behaviour (regression pin).
  - Trust: `proveOrigin` returns `dev-link` before reading any record or digest (a project record
    with a matching `source` still yields no origin); `isApprovedByPath` rejects an installed-copy
    approval for a dev-linked copy at the same path, and a dev-link approval for the restored
    installed copy; a retargeted link is not a dev link; `trustSource` never covers a dev-linked copy.
  - Capability: an agent call returns `approval_required`; an approved retry with a different `path`
    is refused (input binding); an "Always allow" does not pre-approve the next call.
  - Watcher: classification table, debounce coalescing, ignored paths, no self-trigger during
    reload, folder disappears and returns (sweep re-arms).
- **Unit (harness)**: a symlinked plugin dir is skipped without a record, followed with a matching
  record, skipped with a record whose target differs; inner `followSymlinks: false` still holds;
  dev markers appear in wrappers and hook groups; unlink re-plan removes or rewrites them.
- **Unit (CLI)**: `link` prompts and sends the real path; `--yes`; agent path prints the retry line;
  `unlink` messages; doctor check states.
- **Unit (client)**: badge on each surface; dialog states (refusal keeps input, replace checkbox
  gates the button); unlink dialog copy per parked/not-parked; SSE event updates "Reloaded".
- **Integration**: the ticket's "Done when" as one test: link a fixture plugin carrying an
  extension and a skill, edit the extension's source, and within the debounce + compile window
  `extension_reloaded` fires with the new `sourceHash` and no approval is pending; add a skill, and
  `.claude/skills/<pkg>__<new>` exists; unlink, and the installed copy is back with its approval.
- **E2E (Playwright, queue-only)**: one spec: link via the dialog (test-mode server, temp folder),
  see the badge and path on Installed and Settings → Extensions, unlink. Grep `apps/e2e` for any
  Installed-row copy this changes before pushing.

## Performance Considerations

- One watcher per active dev link (a handful at most). `node_modules` and `.git` are ignored, which
  is what keeps a plugin like Flow (thousands of files with dependencies) cheap. `dorkos doctor`
  already warns about low file-descriptor limits.
- The 300 ms quiet period coalesces editor save bursts and `git checkout` storms into one reload.
- Reconcile is a few `lstat`/`realpath` calls per record.
- No digest is ever computed for a dev link, by design.

## Security Considerations

- **Who can create one.** Only through `marketplace.link`, whose tier gate needs a person's yes on
  the exact input every time, and whose `area: null` leaves no setting that pre-approves it. The
  HTTP route runs the same gate (`ctx.gate`), so a trusted caller (the app, or the terminal in the
  default posture, or a session cookie under Require login) runs it and an agent gets a card.
  Unlink requires `trustedCaller`. The residual is the documented one (DOR-505): with login off, a
  caller that omits its agent header is treated as the operator. Require login closes it.
- **What the card binds.** The input carries the absolute real path, refused when it is not its own
  realpath, so the card always names where the code lives. The registry stores the realpath; a
  slot whose link now points elsewhere stops being a dev link everywhere.
- **No trust crosses kinds.** Dev-linked copies have no trusted origin, never use snapshots, never
  match a trusted source, and their approvals carry `devLink`; installed-copy approvals never match
  them, and theirs never match the installed copy.
- **Harness containment holds.** Only a registered, matching link is followed; a link committed into
  a repo is skipped exactly as today.
- **The trade, stated.** Anything that can write into the linked folder changes what runs, without
  asking. That is the point of a dev link, it is the same trade `extension-load-policy.ts` already
  makes for an approved extension, and the card says it in one line. A new extension, hook or server
  still asks once.
- **Unlink never deletes the developer's folder.** Junction removal uses `rmdir`/`unlink`, never a
  recursive delete; a test fails if it would.
- **Registry location.** `{dorkHome}` is DorkOS's own; a local process running as the person can
  write it, as it can write `~/.claude/settings.json`. The boundary is the API door, as
  `global-plugin-consent.ts` states for the same reason.

## Documentation

- `docs/marketplace/` — new guide page "Develop a package with a dev link": link, edit, see it
  reload, unlink, switch to the published copy. Plain language (`writing-for-humans`).
- `contributing/marketplace-installs.md` — the dev-link install kind, the registry, the parked
  sibling, the guards, and how it differs from a hand-built linked install.
- `contributing/extension-authoring.md` — the dev loop now has a plugin-level option.
- `docs/api/openapi.json` regenerated; CLI help text.
- Changelog fragment in `changelog/unreleased/` (user-facing: "Run a package from your own folder
  while you build it").

## Implementation Phases

Each phase is one PR. Phase 1 must land before anything creates a link, because the trust bindings
are what keep a link from borrowing an installed copy's approval.

- **Phase 1 — Registry, service, trust, and the gated door (server).** Schema, registry, service
  (preview/link/unlink/list/reconcile), parked-sibling marker, install/update/uninstall guards,
  trusted-origin and load-policy bindings (`devLink`), `InstalledPackage.devLink`,
  `marketplace.link` capability + MCP tool, `/dev-links` routes, OpenAPI. Link-time yes for
  extensions (one-card behaviour).
- **Phase 2 — Harness projection and global consent.** Harness scan follows registered links,
  dev labels on wrappers/hooks/status, callers pass `devLinks`, un-project on unlink; global
  link-time consent yes and project hook-consent yes; `restoreApprovals` for global entries.
- **Phase 3 — Hot reload.** Watcher, classification, sweep/re-arm, `marketplace_dev_link_reloaded`
  broadcast, integration test for "Done when".
- **Phase 4 — CLI and doctor.** `link`, `unlink`, installed marker, `Dev links` doctor check and
  `/api/health/deep`.
- **Phase 5 — App.** `DevLinkTag`, Installed row badge/status/actions, Link a folder dialog, unlink
  dialog, package sheet + browse card state, Settings → Extensions badge, `/x/<id>` strip, e2e spec,
  docs guide, changelog fragment.

Phases 3, 4 and 5 depend on 1; 3 also needs 2 for projection actions. 4 and 5 can run in parallel.

## Decisions for Dorian

Three product calls only Dorian can make. Each has a recommendation the spec is written against;
changing one changes only the named section.

1. **Does the link card also approve what the folder runs today?**
   - **(A) One card (recommended).** The link yes approves the folder's current extensions, hooks
     and servers. New ones ask once later. Matches "approve the folder once".
   - (B) Two steps. The link card creates the link; each extension, hook and server then asks
     through its usual card the first time.
   - **Pick: A.** The ticket's whole complaint is approval churn, and the card already discloses
     what runs. (Affects §4.)
2. **Linking a package you already have installed.**
   - **(A) Set the installed copy aside and bring it back on unlink (recommended).** The card needs
     the explicit "Use my folder instead" tick.
   - (B) Refuse until the installed copy is uninstalled.
   - **Pick: A.** It is the only reading where "unlinking restores the installed copy" holds, and
     nothing is deleted. (Affects §2 Link/Unlink.)
3. **What "Publish" means on the badge.**
   - **(A) Switch only (recommended).** "Use installed copy" or "Install published version";
     publishing stays in git, checked by `dorkos package validate`.
   - (B) DorkOS publishes: it opens a pull request from the folder to the package's marketplace.
   - **Pick: A.** B needs forge credentials and per-marketplace rules; nothing in DorkOS publishes
     today. B can follow as its own ticket. (Affects User Experience, CLI.)

## Open Questions

1. ~~Symlink in the slot, or a separate install root? (RESOLVED)~~
   **Answer:** symlink (junction on Windows) in the normal slot, plus the registry.
   **Rationale:** every consumer that handles DOR-2194 links keeps working and in-package paths are
   unchanged; a separate root means five scanners grow a second source. Ideation §5.
2. ~~Registry in `config.json` or its own file? (RESOLVED)~~
   **Answer:** `{dorkHome}/marketplace/dev-links.json`.
   **Rationale:** same pattern as `project-installs.json`; no `conf` migration; the boundary is the
   API door either way.
3. ~~Can a permission setting pre-approve `marketplace_link`? (RESOLVED)~~
   **Answer:** no. `tier: 'destructive'`, `area: null`, pinned by a test.
   **Rationale:** the ticket requires a card naming the path every time an agent asks.
4. ~~Should agents be able to unlink? (RESOLVED)~~
   **Answer:** not in v1. Unlink is a person's action (`trustedCaller`), and there is no MCP tool.
   **Rationale:** unlink changes which code runs (it restores the installed copy); the owner-only
   mode stays owner-only end to end. An agent can ask in chat.
5. ~~Which package types? (RESOLVED)~~
   **Answer:** `plugin` and `skill-pack`.
   **Rationale:** covers Flow and every extension carrier; agents and adapters load through other
   systems and need their own design.
6. ~~What happens to install/update/uninstall over a dev link? (RESOLVED)~~
   **Answer:** refused with "Unlink it first"; the update check reports it as unchecked with a
   dev-link note.
   **Rationale:** today an install deletes a link silently; the explicit switch must hold both ways.
7. ~~Do approvals given to the installed copy survive a link/unlink round trip? (RESOLVED)~~
   **Answer:** yes, captured in `restoreApprovals` at link and restored at unlink.
   **Rationale:** the parked copy's bytes are unchanged, and its approvals bind those bytes (hash)
   or its origin (re-proved against the unchanged digest). Re-asking would be churn with no new
   information.
8. ~~Should skill projections be renamed to show they are dev? (RESOLVED)~~
   **Answer:** no. Names stay `<pkg>__<name>`; the label lives in wrappers, hook groups and the
   status listing.
   **Rationale:** renaming changes skill ids, so a session would see a different skill after
   switching back.
9. ~~How does a dev link interact with DOR-2685 (extension tools/skills) and DOR-2686 (isolated
   backends)? (RESOLVED)~~
   **Answer:** it doesn't change them. Both hang off `reloadExtension` / the load path, which the
   watcher already drives.
   **Rationale:** build order is 2683 → this → 2685 → 2686 (Dorian).

## Related ADRs

- `decisions/260706-192819-harness-native-plugin-delivery.md` — projection is the delivery path.
- `decisions/0304-file-scoped-rollback-for-marketplace-installs.md`,
  `decisions/0231-atomic-transaction-engine-for-marketplace-installs.md` — the transaction this
  guards against.
- `decisions/0303-harness-sync-multi-source-projection.md`.
- `decisions/0305-per-cwd-plugin-activation-for-project-scoped-installs.md`.
- `decisions/260923-163513-installed-files-owned-by-provenance.md`.
- `decisions/0213-directus-style-server-extension-registration.md` — in-process extensions.
- Draft decision records for this spec: `specs/marketplace-dev-link/design-decisions.md`.

## References

- Linear DOR-2696 (this), DOR-2194 (hand-built linked installs), DOR-2306 (global consent),
  DOR-2527 (project digest), DOR-2383 (approval per copy), DOR-2517, DOR-2683, DOR-2685, DOR-2686,
  DOR-2690 (Flow Dashboard umbrella).
- `research/20260626_plugin_config_and_iteration_patterns.md` (npm link, VS Code extension host,
  Raycast develop).
- Code: paths cited inline above; ideation `specs/marketplace-dev-link/01-ideation.md`.
