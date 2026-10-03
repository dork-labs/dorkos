---
slug: marketplace-dev-link
id: 261003-184400
created: 2026-10-03
status: ideation
linearIssue: DOR-2696
---

# Dev link: run a marketplace package from a working folder

**Slug:** marketplace-dev-link
**Author:** Claude Code (IDEATE stage, /flow)
**Date:** 2026-10-03

---

## 1) Intent & Assumptions

- **Task brief (DOR-2696, Dorian 2026-10-03):** prototyping a marketplace plugin today means
  reinstalling and re-approving on every edit, because the install path pins a digest and
  snapshots the files, so a change in the working folder is invisible until a full reinstall.
  A **dev link** runs a marketplace plugin (or any package) straight from a working folder, for
  its owner only, hot-reloaded, without reinstalling or re-approving per edit, then publishes
  when ready. Concretely, from the ticket:
  - owner-made, **path-approved**: the person approves the folder once on a card naming the
    absolute path; from then on the plugin loads from that path and reloads on change, through
    the same reload seam the dev extension path uses (`test_extension` → `reload_extensions`);
  - **badged everywhere** the plugin shows up (Marketplace page, Settings → Extensions, the Flow
    tab if it is Flow): "Dev link: <path>", with a one-click "Publish / switch to installed copy";
  - **trust is not weakened for installed copies**: a separate install kind that never satisfies a
    digest pin, never counts as the published version, cannot be created by an agent (owner only,
    a card), and whose harness projection is labelled dev;
  - Harness Sync projects dev-linked skills/commands exactly as for an installed plugin, and
    un-projects on unlink;
  - CLI `dorkos marketplace link <path>` / `unlink <name>`; MCP `marketplace_link` (destructive
    tier, so a card);
  - selftest/doctor shows active dev links and whether each path still exists.
  - **Done when:** edit a file in a linked plugin's working folder → within seconds the running
    DorkOS uses it, with no reinstall and no new approval; the Marketplace page shows the dev badge
    and the path; unlinking restores the installed copy or removes the plugin; an installed copy
    of the same plugin is never replaced by a dev link's files without the explicit switch.
- **Why now:** the Flow Dashboard (umbrella DOR-2690) is being built as a dev extension because
  this does not exist. Build order (Dorian, on DOR-2685): DOR-2683, then this, then DOR-2685
  (extensions provide tools + skills), then DOR-2686 (isolated extension backends).
- **Assumptions:**
  - The working folder has the same layout as an installed package (`.dork/manifest.json` and/or
    `.claude-plugin/plugin.json`, `skills/`, `commands/`, `hooks/`, `.dork/extensions/<id>/`).
    Verified against `marketplace/plugins/flow/` (has `.dork/manifest.json`, `.dork/extensions`,
    `skills`, `commands`, `hooks`).
  - The owner is the person at the keyboard of this DorkOS (local operator, or a signed-in
    session cookie under Require login): the same bar `trustedCaller()` already draws.
  - A dev link is machine-local. It never travels in a repo, a Shape, or a sync.
  - Anything that can write into the linked folder can change what runs. That is the deliberate
    trade (the same one `extension-load-policy.ts` states for approved extensions), and the card
    says it plainly.
- **Out of scope:**
  - Publishing to a marketplace (git push, PR to a marketplace repo). "Publish" here means switching
    the running copy back to a published, installed one. See §6 and the spec's Decisions.
  - Agent, adapter and Shape packages (v1 links `plugin` and `skill-pack`, which covers Flow and
    every extension-carrying plugin). Agents register with Mesh and adapters load through Relay's
    own loader; both need their own design.
  - Sandboxing a dev-linked extension (DOR-2686).
  - Registering extension tools/skills at load (DOR-2685); dev link reuses whatever the extension
    seam does when that lands.
  - Changing hand-built linked installs (DOR-2194) beyond letting `link` adopt one.

## 2) Pre-reading Log

- `AGENTS.md`: Marketplace installs are a file-scoped transaction (ADR-0304); Harness Sync is the
  delivery mechanism (ADR 260706-192819); app copy follows `writing-app-copy` (≤15 words a block,
  no "we"); "integration/connector/adapter/provider" are not user-facing nouns.
- `decisions/260706-192819-harness-native-plugin-delivery.md`: project plugins reach every harness
  as files: skills as `<pkg>__<name>` symlinks, commands as generated wrappers with
  `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute install dir, hooks merged into
  `.claude/settings.local.json` under a `_dorkosHarness` sentinel. Global installs are still
  SDK-injected.
- `research/20260626_plugin_config_and_iteration_patterns.md`: surveyed `npm link`, VS Code
  extension development host, Raycast `ray develop`: the universal pattern is "run from the
  working tree, clearly marked, then publish separately"; no ecosystem automates edit → publish.
- `apps/server/src/services/marketplace/consent/global-plugin-consent.ts`: **a linked install
  already exists as a concept** (DOR-2194): `~/.dork/plugins/<name>` being a symlink to a
  developer's working copy. It is approved by name and real path (`linked:<realpath>` binding,
  `ActivationSubject { kind: 'linked' }`), "pinning bytes a developer edits all day would only
  teach them to click yes".
- `services/marketplace/installed-scanner.ts`: `InstallationRecord.linked` / `InstalledPackage.linked`
  set when the install folder is a symlink; listed and checked, never reinstalled.
- `services/marketplace/flows/update.ts`: `LINKED_INSTALL_NOTE = 'linked install — update its source
instead'`; a linked install is checked as `unknown`, never reinstalled.
- `services/marketplace/flows/uninstall/uninstall.ts:254`: a linked install is uninstalled by
  `unlink(root)`; nothing inside it is touched.
- `services/marketplace/transaction.ts:515`: a linked target is never walked for carry-over. But
  an **install** aimed at a slot holding a link moves the link aside as the backup and deletes it on
  commit: today an install silently replaces a hand-built link.
- `services/marketplace/lib/install-digest.ts`: project installs record the staged folder's
  digest in `{dorkHome}/marketplace/project-installs.json`; any symlink anywhere means no digest
  (`kind: 'linked'`).
- `services/extensions/extension-trusted-origin.ts`: a copy has a trusted origin only from
  DorkOS's own install records; a global linked plugin gets `problem: 'linked'`; a project copy
  whose folder digest no longer matches gets `problem: 'changed'`.
- `services/extensions/extension-load-policy.ts`: the gate is on the artifact: a person approves
  an extension copy (id + path + carrying plugin, `extensions.approvedSources`) once, then every
  load, compile error and fix is silent. A project copy with `originProblem: 'changed'` needs an
  approval pinned to its current digest, so **every edit re-asks**.
- `services/extensions/extension-discovery.ts:395`: plugin roots are enumerated with
  `isDirectory() || isSymbolicLink()`, so extensions inside a linked plugin are discovered.
- `services/extensions/extension-snapshots.ts`: copies that run by trusted origin run from a
  content-addressed snapshot, not the project folder. A copy with no origin runs from its path.
- `services/extensions/extension-manager.ts`: `reload()` / `requestRefresh()` re-scan and switch
  copies; `reloadExtension(id)` recompiles and restarts one server half; clients hear
  `extension_reloaded`. The MCP `reload_extensions` / `test_extension` tools ride these.
- `packages/harness/src/sources/installed.ts:715`: `scanPluginsRoot` keeps only
  `entry.isDirectory()` entries from `readdir({ withFileTypes: true })`, which is `false` for a
  symlink. **A linked plugin is silently never projected by Harness Sync today.** Skill scans use
  `followSymlinks: false` as a containment rule (a repo-committed link must not project a private
  folder, reproduced 2026-09-07).
- `packages/harness/src/plan/installed-projector.ts`: command wrappers carry
  `GENERATED_COMMAND_MARKER` (`dorkos:generated-command`), the sweep's ownership predicate.
- `apps/server/src/services/harness/skills-watcher.ts`: the chokidar watcher + periodic sweep +
  re-arm pattern (with measured drop rates) that makes a newly written skill reach Claude Code in
  seconds. The model for a dev-link watcher.
- `services/marketplace-mcp/marketplace-capabilities.ts`: marketplace capabilities on the registry;
  `marketplace.uninstall` is the one `destructive` entry, with `approvalDisplayFields`.
- `services/core/capabilities/tier-enforcement.ts`: `destructive` requires a person's approval
  bound to the exact capability and input, whatever the caller's identity.
  `capability-definition.ts`: `area: null` means no permission setting decides it (requires
  `areaNote`).
- `routes/marketplace/held-back.ts`: the operator-only marketplace decision bar:
  `trustedCaller(readCallerAuthority(req, res))`, 403 `operator_only` for an agent, cookie-required
  under login.
- `packages/cli/src/commands/uninstall.ts`: the CLI shape for a gated verb: an agent caller gets
  `approval_required` and retries with `--approval <token>`.
- `packages/cli/src/commands/doctor-checks.ts`: checks return a shared `CheckResult`, also served by
  `GET /api/health/deep`.
- `apps/client/src/layers/features/marketplace/ui/InstalledPackagesView.tsx`,
  `features/extensions/ui/ExtensionCard.tsx` (renders `originProblem`), `widgets/extension-page`
  (the `/x/<extensionId>` host, where the Flow tab lives).
- Sibling tickets in `.temp/`: DOR-2685 (late-registered tools/skills), DOR-2686 (out-of-process
  extensions). Neither changes this design; both reuse the reload seam.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/marketplace/` — new `dev-links/` folder (registry, service,
    watcher); guards in `installer/` (install refuses a dev-linked slot), `flows/uninstall/`,
    `flows/update.ts`; `installed-scanner.ts` (listing field); `consent/global-plugin-consent.ts`
    (link-time yes).
  - `apps/server/src/services/extensions/` — `extension-trusted-origin.ts` (no origin, ever, for a
    dev-linked copy), `extension-load-policy.ts` (approval bound to the dev link), discovery
    (record field).
  - `packages/harness/src/sources/installed.ts` + `plan/installed-projector.ts` — follow a
    registered dev link; label its projections.
  - `apps/server/src/services/marketplace-mcp/` — `marketplace.link` capability.
  - `apps/server/src/routes/marketplace/` — new `dev-links.ts` route group.
  - `packages/cli/src/commands/` — `marketplace-link.ts`, `marketplace-unlink.ts`, doctor check.
  - `apps/client/src/layers/features/marketplace/` + `features/extensions/` +
    `widgets/extension-page/` — badge, link dialog, switch/unlink actions.
- **Shared dependencies:** `@dorkos/marketplace` (manifest schema; new dev-link registry schema so
  server, harness and CLI parse one shape), `@dorkos/shared/marketplace-schemas`
  (`InstalledPackage`, `isInstallSiblingName`), `@dorkos/shared/config-schema`
  (`ExtensionApprovedSourceSchema`), `@dorkos/extension-api` (`ExtensionRecordPublic`), chokidar.
- **Data flow:** person (app / terminal / approved agent card) → `marketplace.link` capability →
  `DevLinkService.link` (validate, park installed copy, create link, write registry, record the
  person's yes) → `onPluginsChanged` (extensions re-scan, global consent refresh, harness
  projection) → watcher on the real path → on change: `reloadExtension` / re-projection /
  plugin refresh → `extension_reloaded` + `marketplace_dev_link_reloaded` SSE → client badge.
- **Feature flags/config:** none. Registry file `{dorkHome}/marketplace/dev-links.json` (new). One
  additive optional field on `extensions.approvedSources[id]` (`devLink`).
- **Potential blast radius:** extension approval matching (security-sensitive), install
  transaction entry guard, harness scan (security-sensitive containment rule), installed listing
  and browse card state, the capability census guards (a new verb reds two claude-code count
  guards by design), OpenAPI docs regeneration.

## 4) Root Cause Analysis

Not a bug fix. One finding behaves like one and shapes the design: the existing hand-built linked
install (DOR-2194) is half-supported. It loads extensions (discovery follows the link) and global
SDK plugins (consent binds the path), but Harness Sync never projects it, an install silently
replaces it, and at project scope an approval given to the installed copy's path would match the
link's files (same path, same plugin name).

## 5) Research

- **Potential solutions:**
  1. **Link in the slot, with a DorkOS-written registry (recommended).** The dev link is a symlink
     (a junction on Windows) at the package's normal install slot (`{dorkHome}/plugins/<name>` or
     `<project>/.dork/plugins/<name>`), plus a record in `{dorkHome}/marketplace/dev-links.json`
     that DorkOS alone writes. An installed copy in that slot is parked beside it under an install
     sibling name, never deleted, and put back on unlink.
     - Pros: every consumer that already handles DOR-2194 links keeps working (scanner, update
       skip, uninstall, global consent, extension discovery). Paths inside the package
       (`${CLAUDE_PLUGIN_ROOT}`, `.dork/plugins/<name>` relDirs) stay what they are. The registry is
       the proof that DorkOS, on a person's word, made this link, which is exactly what the
       harness containment rule needs before it may follow one.
     - Cons: the same path names two different things over time (installed copy, dev link), so
       every approval keyed on a path must also say which one it was given to. Solved by binding
       to the dev link's real path (§6 D4). Parking needs `isInstallSiblingName` to know the new
       marker.
  2. **Separate root, no link in the slot.** The registry is an extra install root every scanner
     reads (installed scanner, harness sources, extension discovery, SDK plugin list, consent).
     - Pros: no path aliasing at all; installed copy untouched in place.
     - Cons: five scanners grow a second source, each a place to forget it; two packages with one
       name visible at once (precedence rules everywhere); `${CLAUDE_PLUGIN_ROOT}` rewriting and
       relDir-based projection need new cases. Larger, riskier, and diverges from DOR-2194.
  3. **Fast reinstall on change** (watch the folder, re-run the install transaction per edit).
     - Pros: no new install kind.
     - Cons: every edit is a new install event, so a new content hash and a new approval: the exact
       pain the ticket names. Slow (staging, npm, digest). Rejected.
- **Recommendation:** option 1. It formalises a shape the code already half-understands, and the
  new work concentrates on four seams: the registry + service, the trust bindings, the harness
  scan, and the watcher.

## 6) Decisions

Resolved during ideation from code evidence (the spec carries the reasoning and the remaining
product decisions for Dorian):

| #   | Decision                                   | Choice                                                                                                 | Rationale                                                                                                                                                           |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the dev link lives                   | Symlink/junction at the normal slot + `{dorkHome}/marketplace/dev-links.json` registry                 | Reuses DOR-2194 handling; registry is the proof harness and trust code need (§5).                                                                                   |
| 2   | Registry home                              | A file under `{dorkHome}/marketplace/`, not `config.json`                                              | Same pattern as `project-installs.json`; no `conf` migration; no `config_patch` path to defend. The real bar is the API door, as `global-plugin-consent.ts` states. |
| 3   | Who may create one                         | `marketplace.link`, tier `destructive`, `area: null`; HTTP route runs the same gate                    | Destructive needs a person's yes bound to this exact input on every call; `area: null` means no Allowed setting or "Always allow" can pre-approve it.               |
| 4   | How trust tells a dev link from an install | Dev-linked copies never have a trusted origin; approvals given to one carry `devLink: <realpath>`      | Same path, different code: an install's approval must not cover the link and vice versa; trusted sources and snapshots never apply.                                 |
| 5   | What hot reload drives                     | `reloadExtension` for extension files; harness re-projection for skills/commands/hooks; plugin refresh | These are the existing seams `reload_extensions` and `skills-watcher.ts` already use.                                                                               |
| 6   | Package types in v1                        | `plugin` and `skill-pack`                                                                              | Covers Flow and every extension-carrying plugin; agents (Mesh) and adapters (Relay loader) need their own design.                                                   |
| 7   | Install/update/uninstall over a dev link   | Refused with a sentence pointing at Unlink                                                             | Today an install deletes a link silently; "never replaced without the explicit switch" applies both ways.                                                           |
| 8   | Hand-built links (DOR-2194)                | Keep working as today; `link` on the same path adopts one                                              | No silent behaviour change for anyone using them now.                                                                                                               |

**Next step:** specify (`02-specification.md`).
