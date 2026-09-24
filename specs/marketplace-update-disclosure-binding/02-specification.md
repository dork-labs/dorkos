---
slug: marketplace-update-disclosure-binding
number: 260924-114458
created: 2026-09-24
status: specified
linear-issue: DOR-2306
---

# Updates and global plugins run only what a person approved

**Status:** Approved
**Author:** Claude Code
**Date:** 2026-09-24

## Overview

An update, or a globally installed plugin, can start programs in every DorkOS session: hook commands, MCP and language servers, background monitors, commands on the agent's `PATH`, and skills that use tools without asking. DOR-2195 made the MCP `marketplace_update` apply show all of that on an approval card and hold the install to it. This spec brings the two remaining ways in to the same standard:

1. **The HTTP apply** (`POST /api/marketplace/updates`, and the per-package route's `apply`) shows what each new version runs, and installs only a version that runs exactly that.
2. **Global activation** loads a global package that runs anything on its own only when a person approved exactly that set of programs for it. Otherwise it is left out of every session until they do.

## Background / Problem Statement

See `01-ideation.md` §1 and §3. In short: `marketplace.install` is tier `act`, so an agent with a shell can `POST /api/marketplace/updates { apply: true }` and reinstall any package with a new version it (or anyone who can write the personal `file://` marketplace) controls. For a global plugin, the new hooks and MCP servers then load into every live session through `refreshActivatedPlugins`, which checks nothing. The app's own apply has the same gap in time: it shows versions only, and reinstalls whatever resolves at apply time.

## Goals

- No new version is reinstalled over HTTP unless the request carries, for each installation, the version and the disclosure it was shown, and the version resolved now still matches both. Refuse before anything is removed otherwise.
- An agent (a caller that is not the person) cannot apply over HTTP without a person approving a card that lists everything, bound the way DOR-2195's card is.
- A global plugin, skill-pack or adapter that runs anything on its own is loaded only when a person approved exactly what it runs now. Unapproved, unreadable, refused or undecidable: left out (fail closed), and a person is asked.
- The app's update confirm shows each installation's disclosure, and a row whose new version runs something goes through it.
- The app's install records the person's approval for a global plugin, so they are not asked twice.
- Exploit regressions: an unapproved hook or MCP server never activates through HTTP apply, HTTP install, or a file changed on disk.

## Non-Goals

- Extensions approved by id (`extension-load-policy.ts`). Same class, documented there, and gated by a separate person-approval (`approvedToRun`). A follow-up.
- Project installs' hooks: already gated at projection (`project-with-consent.ts`); unchanged.
- Files outside the package that a hook's script reads at run time (the package's own bytes are bound; see D3).
- Shapes and agents installed by an agent: they are not loaded into sessions by the SDK, so the agent-install card (D2b) covers plugins, skill-packs and adapters only.
- Any change to `marketplace-installer.ts` (DOR-2245 is rebasing onto it).

## Technical Dependencies

No new libraries. Builds on `disclosed-effects.ts`, `update-installed.ts#applyApprovedUpdates`, `UpdateFlow.planInstallations/applyPlan`, `TokenConfirmationProvider`, `ApprovalService`, `hook-consent.ts`.

## Detailed Design

### D1. Every check discloses

`checkInstalledUpdates` plans with `disclose: true`, so `GET /api/marketplace/updates` and the MCP advisory `marketplace_update` return, on every `update-available` check, `disclosed`: what the new version runs (`DisclosedEffects`, or `null` when nothing was previewed). A new version with a declaration DorkOS cannot read is `unknown` with the reason, as the MCP apply already treats it, so nothing unreadable can be offered.

The wire type moves to `@dorkos/shared/marketplace-schemas` (`DisclosedEffects` and its parts), and the server's `disclosed-effects.ts` uses those types, so there is one definition. `InstallationUpdateCheck.disclosed?: DisclosedEffects | null` is added.

### D2. One HTTP apply door, bound to what was shown

`POST /api/marketplace/updates` body (strict):

```ts
{
  apply: true,
  projectPath?: string,
  targets: [{ installPath: string, latestVersion: string, disclosed: DisclosedEffects | null }, ...], // min 1
  confirmationToken?: string,
}
```

`names` and `installPaths` are retired from this body: every target now says exactly which installation, which version and which disclosure. The route calls `applyApprovedUpdates` with the targets' install paths, and a gate that:

1. **Compares** each approvable update (recomputed now: plan with `disclose`) with its target. Any target whose installation's `latestVersion` or `disclosed` differs (same canonicalization as the approval hash, `sameDisclosedEffects`) refuses the whole batch with **409** `{ code: 'disclosure_changed', error, changed }` naming the reinstalls that moved; the app refetches the check. Nothing runs.
2. **Trusted caller** (`trustedCaller`, the person in the app or their own terminal): allowed. Records global consent (D4) for the batch's global installations.
3. **Anyone else** (an agent): asks through the server's `ConfirmationProvider` exactly as `marketplace_update` does (`operation: 'update'`, `updates`), answering **202** `{ status: 'requires_confirmation', confirmationToken, updates, message }`; a retry carries `confirmationToken` in the body; `declined` is **403** `{ status: 'declined', reason }`. An approved card records global consent (D4). `preApproved` does not exist on this surface.

The existing tier gate (`authorize(..., 'marketplace.install', ...)` per package, and `batchNeedsApproval`) runs first, unchanged.

After the gate, `applyPlan` holds each reinstall to the approved disclosure, and the installer's stage-once update refuses a `DisclosureChangedError` before uninstalling. So there are two checks and no gap: check→apply at the gate, apply→install in the installer.

`POST /api/marketplace/packages/:name/update` becomes advisory only: its body schema is strict, so `apply` is refused with a 400. `UpdateFlow.run`'s `apply` path, `UpdateFlow.checkInstallations` (whose only apply was unbound) and `applyInstalledUpdates` are deleted (superseded), and `UpdateFlow.applyPlan` requires the approved disclosures: no code path can reinstall without one.

### D3. Global activation consent

New module `services/marketplace/global-plugin-consent.ts`:

- `readActivationEffects(pluginDir)`: reads the installed tree with the same readers the preview uses (factored out of `PermissionPreviewBuilder.build` as `readRunnableDeclarations`), and returns either `{ effects }` (a `DisclosedEffects` with `schedules: []`) or `{ unreadable: string[] }`.
  Schedules are excluded on purpose: the SDK does not load them, and they have their own gate (`pending_approval`).
- `runsOnItsOwn(effects)`: any hook, MCP/LSP server, monitor, `bin/` command, or skill `allowed-tools`.
- `globalActivationEntry(dirName, effects)`: `<dirName>@global-<sha256>` over `['global-activation', dirName, stableStringify(effects)]`. Stored in `harness.approvedHooks` / `refusedHooks` (operator-only, listed and revoked by `dorkos harness hooks`), because it is the same decision: let an installed package run commands automatically.
- `partitionGlobalPlugins(dorkHome, decisions)`: every candidate `listEnabledPluginNames` returns, split into `activate` (runs nothing on its own, or approved exactly) and `withheld` (`refused` | `unasked` | `unreadable` | `unreadable-config`), checked refused → approved → unasked so a file that says both withholds.

`refreshActivatedPlugins` activates only `partition.activate`. A withheld plugin is left out whole (the SDK cannot load a plugin without its hooks).

### D4. Recording consent where a person approved

- HTTP update, trusted caller, gate passed: each global plugin/skill-pack/adapter update records its target disclosure.
- HTTP update, agent, card approved: same.
- MCP `marketplace_update`, card approved (not `preApproved`): same.
- HTTP install, trusted caller, `approvedDisclosure` sent and the installer accepted it: record for a global install of an activated type.
- MCP `marketplace_install`, card approved (not `preApproved`), global: record.

Recorded before `onPluginsChanged`, so the refresh it triggers sees the consent. The recorded entry is computed from the approved disclosure with schedules removed; activation computes it from the installed files. A parity test installs real fixtures through the real installer and asserts the two agree.

### D5. Asking about a withheld global plugin

`askAboutWithheldGlobalPlugins({ dorkHome, approvals, onGranted })` runs at boot (after the approval service exists) and after every `onPluginsChanged`. For each `unasked` plugin with no card open: one card, capability `marketplace.activate_global_plugin`, title "Let a globally installed package run programs in every session", tier `destructive`, summary naming the package and counts, detail listing every program in full (the update card's line builder, moved to `services/marketplace/describe-effects.ts`). Grant records the approval and calls `onGranted` (refresh); deny records a refusal; expiry records nothing (asked again next time). A plugin whose list is too long for the card, or whose declarations cannot be read, is withheld and logged, never shown cut.

### D6. App

- `ConfirmUpdatesDialog`: each item lists what its new version runs, under its name and versions, with the same row style as the install preview's commands group (verbatim commands, hidden characters revealed), and when programs start: "in every session" for a global install, "declared, not started for a project install" otherwise. An item whose new version runs nothing says so in one line.
- A row's Update applies directly only when the new version runs nothing on its own (`disclosed` null or empty); otherwise it opens the dialog with that one item.
- `ApplyUpdateTarget` is `{ installPath, latestVersion, disclosed }`, filled from the check the dialog rendered; the transport sends `targets`.
- A 409 `disclosure_changed`: the updates query is refetched and the toast says the package changed what it runs since it was shown and to review it again.
- A 202 (only an agent gets one) is not reachable from the app.
- Install: the preview response carries `disclosed`; `InstallConfirmationDialog` sends it as `approvedDisclosure`; the route passes it to the installer (which already compares its own resolve against it) and records global consent (D4). `InstallRequest.approvedDisclosure`'s note about never being in the body is rewritten: a caller can set it, and every value but the true one is refused.

### D7. CLI

- `dorkos update [<name>] --apply`: `GET /updates`, keeping the checks of that name when one is given (a name with no installation in view is "not installed", exit 1), prints each stale installation and everything its new version runs, asks "Update these?" unless `--yes`, then `POST /updates` with the targets it printed. A 202 prints the card instruction and `Retry with: dorkos update … --apply --approval <token>`; 409 prints the change and exits 1.
- `dorkos install`: sends the `disclosed` from the preview it printed as `approvedDisclosure`.
- `dorkos harness hooks --list` names a global-activation entry as "for the globally installed package, in every session".

## User Experience

- **Update from the app:** the Installed view shows "Update available". Pressing Update on a package whose new version runs nothing updates it at once. Otherwise the confirm opens and lists, for that package, every command it runs and when, every server it starts. Confirm updates exactly that; if the package changed meanwhile, nothing changes and the toast says to review it again.
- **Update all:** the same confirm, one item per installation, each with its list.
- **After upgrading DorkOS:** a globally installed plugin that runs programs of its own is paused, and one approval card per plugin asks "Let a globally installed package run programs in every session". Allow brings it back in every session; Deny keeps it out until it changes or `dorkos harness hooks --revoke <name>`.
- **An agent updates a package:** a card appears listing everything; nothing changes until a person allows it.

## Testing Strategy

Exploit regressions (each must fail on the current code):

1. `POST /updates` from an agent with valid-looking targets: never reinstalls without a granted card (route test with a real `TokenConfirmationProvider` over a fake approvals store).
2. `POST /updates` from the person with a stale `disclosed` (source added a hook after the check): 409, the installer's `update` never called.
3. `POST /packages/:name/update { apply: true }`: 400, nothing reinstalled.
4. Global activation: a plugin installed with a hook / `.mcp.json` and no consent is not in the SDK plugins array; after consent it is; after a file edit that adds a hook it is withheld again; a skill-pack that runs nothing activates with no consent; an unreadable declaration withholds; unreadable config withholds.
5. Parity: real installer + fixtures, the consent recorded from the approved disclosure matches what activation reads from the installed tree.
6. MCP: an approved update/install card records consent; a `preApproved` one does not.

Unit tests for the partition order, the entry form, the card wait loop (grant/deny/expiry), the dialog (renders every program verbatim, row routing, targets carry disclosures, 409 toast), the CLI (prints, prompts, sends targets, handles 202/409). Mutation checks on the comparison, the partition order, the consent record, and the row routing.

## Performance Considerations

A check now builds a preview for each stale installation (the MCP apply already does). Activation reads a few small files per global plugin at boot and on each package change.

## Security Considerations

- The trust line is `trustedCaller`, the same one every gated route uses; with login off a caller that omits its agent header counts as the person (DOR-505), a residual shared with every such route. Require login closes it.
- `harness.approvedHooks` is operator-only through every DorkOS write path; a raw shell can still edit `config.json`, the residual `hook-consent.ts` states.
- A hook's script content is not bound (stated limit, as in `hook-consent.ts`).

## Documentation

- `docs/` marketplace page on updates: what the confirm shows, global plugins asking once.
- `contributing/marketplace-installs.md`: the bound apply and activation consent.
- OpenAPI registry for the changed bodies and responses.
- Changelog fragment.

## Implementation Phases

One phase: shared types → server core (checks disclose, bound apply gate, retire unbound paths) → activation consent + card → MCP recording → app → CLI → docs.

## Open Questions

None open. Decisions are in `01-ideation.md` §4, and the ADR `decisions/260924-114320-updates-and-global-plugins-run-only-what-was-approved.md`.

## References

- DOR-2195 / #2070 (`7ed6ee577`), DOR-647, DOR-522, DOR-1849, ADR 260706-192819.

## Review delta (round 1, 2026-09-24)

The adversarial review (CHANGES_REQUIRED) proved that binding an approval to a package's NAME and DECLARATIONS is not enough: a same-named package with the same `hooks.json` and a hostile `hooks/fmt.sh` loaded under the old approval. The design now binds bytes:

- **D3, amended.** A global package's approval binds the content hash of its installed tree (`lib/content-hash.ts`: every file's path, execute bit and SHA-256, every in-tree link's target; DorkOS's runtime state skipped: `.dork/data`, `.dork/secrets.json`, the install records). A link out of the tree or a special file makes the package unapprovable. The declarations stay in the binding for display. One approval per package: recording one replaces the rest, and every global install, update and uninstall forgets them, so a downgrade to old approved bytes is held back.
- **D2b, new.** An agent's HTTP install of a global plugin, skill-pack or adapter that runs anything, or that replaces an existing global package, goes through the `marketplace_install` card, bound to its disclosure and staged content hash, and naming who asked, the version and the source.
- **D4, amended.** Consent is settled only after the install or update landed (`GlobalConsentRecorder.settle`), and records a yes only when the landed copy declares what the person saw and its shipped files hash the same as the `contentHash` they were shown (preview, update check and update target all carry it). A failed apply records nothing.
- **I1.** The runtime re-checks the consented list at the start of every turn; the hash is cached behind an lstat fingerprint (size, mtime, ctime, inode), so an unchanged tree costs one `lstat` walk. Residual: a file rewritten mid-turn runs in that turn.
- **I2.** `GET /api/marketplace/held-back`, `POST /held-back/:name/review`, `POST /held-back/:name/decision` (operator only, bound to the hash shown); Installed rows show "Held back" with Review; `dorkos marketplace held-back [--allow|--refuse]`; `dorkos` prints held-back packages at start.
- **M1.** At most one open card per package name, and one per ten minutes per name while it keeps changing (a person's Review bypasses the wait). Cards state why, the version and the source; for on-disk changes DorkOS cannot know who made them, and says so.
- **M3.** An older CLI's apply is answered with a 400 `client_outdated` telling the person to update the CLI.
- **UX.** The confirm marks each thing a new version runs as New or Changed against the installed version (`installedDisclosed` on each check), folds unchanged ones behind a count, and opens with a summary line. Commands wrap at `/` and quotes, and paths wrap instead of truncating.
- **Content hashing and DOR-2245 / DOR-2197.** DOR-2245 (not merged) hashes files for ownership (`lib/installed-files.ts`: per-file SHA-256 in a record). Sharing its helper would couple this security fix to an unmerged branch, so `lib/content-hash.ts` is written to be adopted: `hashTree(root, { skip })` and `TreeHashCache`. DOR-2197 can store `hashTree` in `InstallMetadata`; when DOR-2245 lands, its `userEditable` matcher belongs in the installed-hash skip.
