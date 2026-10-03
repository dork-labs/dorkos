# Tasks: marketplace-dev-link

Generated from `03-tasks.json` (2026-10-03T18:51:21.334Z). Each phase is one PR.

## Phase 1: Registry, service, trust and the gated door

### Task 1.1: Add the dev-link registry schema, reader/writer and parked-sibling marker

- Size: medium; priority: high
- Depends on: none; parallel with: none

Goal: one schema for {dorkHome}/marketplace/dev-links.json that the server, @dorkos/harness and the CLI all parse.

1. packages/shared/src/marketplace-schemas.ts (existing subpath @dorkos/shared/marketplace-schemas; do NOT add a new subpath):
   - DevLinkRecordSchema = z.object({ name: PackageNameSchema, type: z.enum(['plugin','skill-pack']), scope: z.enum(['global','project']), projectPath: z.string().optional() /* required when scope==='project' (refine) _/, slot: z.string() /_ absolute path of the link _/, target: z.string() /_ realpath of the working folder _/, parked: z.string().optional() /_ absolute path of the set-aside installed copy */, restoreApprovals: z.object({ extensions: z.record(z.string(), ExtensionApprovedSourceSchema).optional(), globalActivation: z.array(z.string()).optional() }).optional(), linkedAt: z.string(), linkedVia: z.enum(['app','terminal','agent-card']) }).
   - DevLinksFileSchema = z.object({ version: z.literal(1), links: z.array(DevLinkRecordSchema) }).
   - DevLinkStatus type: { name, type, scope, projectPath?, path, state: 'active'|'folder-missing'|'link-missing'|'link-replaced', parked: { version?: string } | null, linkedAt, lastReloadAt? }.
   - Add MARKETPLACE_DEVLINK_PARKED_MARKER = '.dorkos-devlink-parked' to MARKETPLACE_INSTALL_SIBLING_MARKERS so isInstallSiblingName hides the parked copy from every reader. The name carries no <timestamp>-<uuid> stamp, so recovery and the backup janitor leave it alone.
   - Pure parseDevLinksFile(text): DevLinksFile | 'unreadable' and a pure isActiveDevLink(record, { lstatIsLink, realpathOfSlot }) helper.
     TSDoc on every export (hard rule 4).
2. ExtensionApprovedSourceSchema in packages/shared/src/config-schema.ts gains devLink: z.string().min(1).optional() ("the realpath of the dev link this approval was given to; absent for an installed copy"). Follow the adding-config-fields skill checklist (optional additive field, no default; docs in contributing/configuration.md if it lists the fields).
3. apps/server/src/services/marketplace/dev-links/registry.ts: readDevLinks(dorkHome) (async; returns { links } or { unreadable: reason }), writeDevLinks(dorkHome, file) with in-process serialisation and fsynced atomic rename, modelled exactly on lib/project-install-index.ts. A file that does not parse is refused by readers; the next write moves it aside to dev-links.json.corrupt-<time>.

Acceptance / tests (each with a purpose comment):

- round-trip; corrupt file refused by readers and moved aside on next write; two concurrent writes both land (serialised).
- isInstallSiblingName('flow.dorkos-devlink-parked') is true; installed-scanner, harness scanPluginsRoot, extension discovery and readTrustedInstalls all skip a parked folder; recovery/backup-janitor leave it untouched.
- schema refuses scope 'project' without projectPath.

### Task 1.2: Implement DevLinkService: preview, link, unlink, list, reconcile

- Size: large; priority: high
- Depends on: 1.1; parallel with: none

File: apps/server/src/services/marketplace/dev-links/dev-link-service.ts (+ errors.ts, index.ts barrel).

API: preview({ path, scope, projectPath }), link({ path, scope, projectPath, replaceInstalled, via }), unlink({ name, scope, projectPath }), list(), reconcile().

Validation, in this order, each a typed error with one plain sentence (writing-app-copy: no "we", say what did not happen and what to do):

1. path absolute and realpath(path) === path, else dev_link_path_not_real carrying realPath ("That path is a link. Use <real> instead.").
2. a readable directory, inside the configured directory boundary (lib/boundary.ts), not inside {dorkHome} -> dev_link_path_not_allowed.
3. package identity via readInstalledIdentity (installed-scanner.ts) + the package validator from @dorkos/marketplace -> dev_link_not_a_package with the first problem.
4. type is plugin or skill-pack -> dev_link_unsupported_type.
5. project scope: projectPath canonical (the route passes it through ctx's boundary helper).
6. no existing dev link for the same name+scope -> dev_link_exists.
7. slot = {dorkHome}/plugins/<name> or <projectPath>/.dork/plugins/<name>: empty OK; an unregistered link whose realpath === path -> adopt (no parking); an unregistered link elsewhere -> dev_link_slot_is_linked; an installed copy -> dev_link_slot_taken (carry installed version) unless replaceInstalled; an existing <slot>.dorkos-devlink-parked -> dev_link_parked_exists.

preview returns { name, type, version?, path, scope, slot, replaces: { version } | null, effects (disclosedEffectsOf from preview/disclosed-effects.ts), extensions: string[] (ids under .dork/extensions) }.

link, inside withInstallTargetLock(slot) (transaction.ts:348):

1. if replacing: rename(slot, slot + MARKETPLACE_DEVLINK_PARKED_MARKER); capture the parked copy's current extensions.approvedSources entries for the ids it carries and its stored global-activation entries (<name>@global-<digest>) into restoreApprovals.
2. symlink(target, slot, process.platform === 'win32' ? 'junction' : 'dir').
3. write the registry record.
4. record the person's yes for the folder's CURRENT extensions: approvedToRun += id; approvedSources[id] = { path: <slot>/.dork/extensions/<id>, plugin: name, devLink: target } (global consent + hook consent come in task 2.2).
5. notify: onPluginsChanged({ projectPath }) and extensionManager.requestRefresh().
   Any failure after step 1 undoes earlier steps in reverse (remove link, rename parked back) before rethrowing.

unlink, same lock: remove the link with unlink() (symlink) or rmdir() (junction) - NEVER a recursive delete; if parked, rename back and restore restoreApprovals (each extension entry only if the id's current approval still carries this devLink); forget the dev-link approvals; drop the record; notify. Returns { restored: 'installed' | 'removed' }. Works from every reconcile state; never touches a slot that is no longer the recorded link.

reconcile/list: per record state active | folder-missing | link-missing | link-replaced (realpath(slot) !== target or slot is a real folder). Never repairs on its own.

Tests: every refusal; parked copy byte-identical; rollback after a forced failure post-parking; unlink of a junction-shaped link leaves the target's files (test fails if rm -r is used); restoreApprovals round trip; unlink from each state; adoption of a hand-built link.

### Task 1.3: Bind trust: dev-linked copies get no origin and their own approvals

- Size: medium; priority: high
- Depends on: 1.1; parallel with: 1.2

Goal: no approval, origin, digest or source trust ever crosses between an installed copy and a dev link at the same path.

1. apps/server/src/services/extensions/extension-trusted-origin.ts: proveOrigin gains devLinkedRoots: ReadonlySet<string> (install roots of ACTIVE registry records, read once per discovery pass). If installRootOf(copy.path) is in it, return { origin: null, problem: 'dev-link', pinnedDigest: null } BEFORE reading any install record or digest, at both scopes. OriginProblem becomes 'changed' | 'linked' | 'dev-link'.
2. packages/extension-api/src/types.ts: originProblem adds 'dev-link' (both places, lines ~63 and ~164); ExtensionRecord/Public gain devLink?: { path: string }.
3. extension-discovery.ts / extension-manager.ts: pass devLinkedRoots; set record.devLink.
4. extension-load-policy.ts: approvedSourceOf sets source.devLink = copy.devLink.path for a dev-linked copy (no digest). isApprovedByPath additionally requires (source.devLink ?? null) === (copy.devLink?.path ?? null). A dev-linked copy is approved by path alone, so edits never ask.
5. installed-scanner.ts: InstalledPackage gains devLink?: { path, state, parked: boolean } from the registry; a registered dev link does NOT set linked: true. A record whose slot no longer resolves still yields a row built from the registry.
6. Guards (409 package_is_dev_linked, "<Name> runs from a dev link. Unlink it first."): MarketplaceInstaller install into a dev-linked slot; UninstallFlow for a registered dev link. UpdateFlow reports a registered dev link as unknown with note 'Dev link — runs from your folder' and never applies it. Hand-built links keep LINKED_INSTALL_NOTE and today's uninstall.
7. Install telemetry is never emitted for a dev link.

Tests: proveOrigin returns dev-link even with a matching project-installs record carrying source; installed-copy approval does not cover a dev-linked copy at the same path; dev-link approval does not cover the restored installed copy; retargeted link (realpath != target) is not a dev link; trustSource never covers a dev-linked copy; each guard refuses; hand-built link regression pins.

### Task 1.4: Add the marketplace.link capability, MCP tool and /dev-links routes

- Size: medium; priority: high
- Depends on: 1.2, 1.3; parallel with: none

1. apps/server/src/services/marketplace-mcp/tool-link.ts + an entry in marketplace-capabilities.ts:
   id 'marketplace.link', title 'Run a package from a folder', tier 'destructive', area null, areaNote 'Always asks: a dev link runs a folder’s code unreviewed on every edit, so no setting may pre-approve it.', input z.object({ path: z.string(), projectPath: z.string().optional(), replaceInstalled: z.boolean().optional() }), approvalDisplayFields ['path','projectPath','replaceInstalled'], approvalDetailField 'path', surfaces.mcp { toolName: 'marketplace_link', servers: ['in-session','external'] }. Scope = projectPath ? 'project' : 'global'. linkedVia = context.trusted ? (app|terminal from the caller) : 'agent-card'.
   Description (model-facing): 'Run a plugin or skill pack from a folder on this computer, reloading on every edit. A person must approve the exact folder. Pass an absolute path. Use projectPath for one project.'
   Decide always-loaded vs deferred for the claude-code tool census: DEFERRED. Update the two census count guards (see services/runtimes tests) and run them.
2. apps/server/src/routes/marketplace/dev-links.ts mounted from routes/marketplace.ts:
   - POST /dev-links/preview (read-only) -> preview or typed refusal (400/403/409).
   - POST /dev-links -> ctx.gate('marketplace.link', input) (202 approval card / 403 / run) -> 201 DevLinkStatus. Use the existing ctx helper so authorizeCapability gains no new importer (its importers are pinned by a source scan).
   - GET /dev-links -> { links: DevLinkStatus[], registryUnreadable?: string }.
   - POST /dev-links/:name/unlink, body { scope, projectPath? } -> trustedCaller(readCallerAuthority(req,res)) bar copied from routes/marketplace/held-back.ts (403 operator_only for an agent, cookie-required under login) -> { restored }.
     projectPath goes through ctx's boundary helper.
3. openapi-registry.ts entries; regenerate docs/api/openapi.json and commit it.

Tests: agent caller gets approval_required; an approved retry with a different path is refused (input binding); an "Always allow" recorded on a marketplace_link card does not let the next call run; trusted caller links; unlink refuses an agent; routes validate bodies.

## Phase 2: Harness projection and consent

### Task 2.1: Project registered dev links in Harness Sync and label them dev

- Size: medium; priority: high
- Depends on: 1.1; parallel with: 2.2

1. packages/harness/src/sources/dev-links.ts: sync reader of {dorkHome}/marketplace/dev-links.json using parseDevLinksFile from @dorkos/shared/marketplace-schemas. No dorkHome -> no dev links.
2. sources/installed.ts: scanInstalledSources(opts) gains devLinks?: readonly DevLinkRecord[]. scanPluginsRoot accepts a symlinked entry ONLY when a record names that exact slot and realpathSync(slot) === record.target; every other link is skipped as today (containment rule, reproduced 2026-09-07). Inner scans keep followSymlinks: false. InstalledPlugin gains devLink?: { path }.
3. plan/installed-projector.ts: generated command wrappers for a dev-linked plugin get a second marker line '<!-- dorkos:dev-link <target> -->' beside GENERATED_COMMAND_MARKER; managed hook groups carry _dorkosDevLink: '<target>' beside _dorkosHarness; the drop list / --check output and services/harness/status.ts mark the package '(dev link: <path>)'. Skill link names stay <pkg>__<name>.
4. Pass devLinks from every caller: runAutoProjection, services/harness/skills-watcher.ts, project-with-consent.ts, and the dorkos harness sync CLI.
5. Unlink already calls onPluginsChanged; verify the projection run removes (package gone) or rewrites (installed copy restored) the projections with no dev markers left.

Tests: link skipped without record / followed with matching record / skipped when target differs; inner symlink still refused; markers present; re-plan after unlink drops markers and orphans.

### Task 2.2: Record the link-time yes for global activation and project hooks

- Size: small; priority: medium
- Depends on: 1.2; parallel with: 2.1

In DevLinkService.link (after the registry write), using the declarations shown on the card (readRunnableDeclarations / activationEffectsOf):

- global scope: record a global-activation yes via recordApprovedEntry bound to bindingOf({ kind: 'linked', path: target }) and the current declarations (consent/global-plugin-consent.ts). Before that, capture the parked copy's existing <name>@global-<digest> entries into restoreApprovals.globalActivation; unlink restores them verbatim (they bind the parked copy's unchanged content hash).
- project scope: record hook-consent approvals for the plugin's current hooks (services/harness/hook-consent.ts).
  A new declaration later is a different thing and asks through its existing card (held-back card / hook consent). Editing never asks.

Tests: after link, the global dev link loads into a session without a held-back card; adding a hook to the folder holds it back once; unlink restores the installed copy's approval so it is not held back.

## Phase 3: Hot reload

### Task 3.1: Watch each dev link and drive the existing reload seams

- Size: medium; priority: high
- Depends on: 1.4, 2.1; parallel with: none

File: apps/server/src/services/marketplace/dev-links/dev-link-watcher.ts, started at boot for every active record and by link/unlink.

- One chokidar watch per active record on target, ignoreInitial true, ignoring .git/, node_modules/ and isRuntimeStatePath (lib/content-hash.ts).
- Collect events per link; flush after a 300 ms quiet period. Classify by path relative to target:
  - .dork/extensions/<id>/** for a known id -> extensionManager.reloadExtension(id) when enabled and allowed to run;
  - a new/removed .dork/extensions/<id>/ -> extensionManager.requestRefresh();
  - skills/**, .dork/tasks/**, commands/**, hooks/** -> harness re-projection for the link's scope;
  - .dork/manifest.json, .claude-plugin/plugin.json, hooks/**, bin/**, and every other file readRunnableDeclarations reads -> onPluginsChanged({ projectPath }).
- Re-arm + sweep every 60 s, following services/harness/skills-watcher.ts (chokidar drops 13-40% of events right after a watch opens; a missing folder cannot be watched).
- target disappears -> record state folder-missing; the sweep re-arms when it returns.
- After each flush broadcast marketplace_dev_link_reloaded { name, scope, projectPath?, at, actions: ('extension'|'projection'|'plugins')[], errors?: string[] } on the global event stream (add it to the shared event schema); keep lastReloadAt for DevLinkStatus.

Tests: classification table; debounce coalesces a burst into one flush; ignored paths never fire; a reload writes nothing under target (no self-trigger; the compiler writes to the build cache under dorkHome); folder removed and restored is re-armed.
Integration ("Done when"): link a fixture plugin with an extension + a skill; edit the extension source -> extension_reloaded with a new sourceHash and no pending approval; add a skill -> .claude/skills/<pkg>__<new> exists; unlink -> installed copy back with its approval.

## Phase 4: CLI and doctor

### Task 4.1: Add dorkos marketplace link/unlink and the Dev links doctor check

- Size: medium; priority: medium
- Depends on: 1.4; parallel with: 5.1

1. packages/cli/src/commands/marketplace-link.ts: 'dorkos marketplace link <path> [--project <path>] [--replace-installed] [--yes] [--approval <token>] [--json]'. Resolve <path> against the caller's cwd and to its realpath; --project via resolveProjectFlag. Call POST /api/marketplace/dev-links/preview, print name, real path, what it runs, what it replaces; ask 'Run <name> from <path>?' with lib/confirm-prompt.ts on a TTY (--yes skips). Then POST /dev-links. An agent caller gets approval_required: print the approval id and 'Retry with: dorkos marketplace link <path> --approval <token>', exactly like commands/uninstall.ts.
2. marketplace-unlink.ts: 'dorkos marketplace unlink <name> [--project <path>] [--json]' -> POST /dev-links/:name/unlink; prints 'Your installed copy of <name> is back.' or '<name> removed. Your folder was not touched.'
3. marketplace-dispatcher.ts wiring + help text; marketplace-installed.ts marks rows 'dev link -> <path>' and a missing folder.
4. doctor-checks.ts checkDevLinks(dorkHome): reads the registry file directly (no server). ok with none or all active (list each); warn per record not active with the fix 'dorkos marketplace unlink <name>'; warn when the file does not parse. Return the same CheckResult from GET /api/health/deep.

Tests: link prompts and sends the realpath; --yes; agent retry line; unlink messages; doctor states (none, active, folder-missing, unreadable).

## Phase 5: App

### Task 5.1: Show dev links in the app: badge, link dialog, unlink, switch

- Size: large; priority: medium
- Depends on: 1.4; parallel with: 4.1, 3.1

All copy follows writing-app-copy: <=15 words per block (pnpm check:copy-length), no "we", exact-action buttons, no code names; never "integration/connector/adapter/provider". grep apps/e2e for any Installed-row string before changing it.

1. shared/ui DevLinkTag (presentational: 'Dev link' tag + 'Dev link: <path>' line, path wraps with [overflow-wrap:anywhere], muted, no alarm colour). FSD: features and widgets each pass the path they have.
2. entities/marketplace: useDevLinks (GET /dev-links), usePreviewDevLink, useLinkFolder, useUnlinkDevLink; invalidate installed + dev-links queries on marketplace_dev_link_reloaded.
3. features/marketplace:
   - Installed toolbar 'Link a folder' -> LinkFolderDialog: path field (+ Browse via the existing DirectoryPicker in the desktop app), the install dialog's scope choice; preview on blur; inline refusals keep input ('No package found in this folder.', 'That path is a link. Use <real> instead.'); ready card: title 'Run <Name> from this folder?', monospace path, 'Edits here run in DorkOS right away, without asking.', when replacing 'Your installed copy (v<x>) is set aside, not deleted.' + required checkbox 'Use my folder instead of the installed copy', the install dialog's 'It runs:' disclosure; buttons 'Cancel' / 'Link folder'. A 202 approval answer is impossible for the app (trusted caller) but handle it with the standard pending notice.
   - Installed row for devLink: DevLinkTag, status 'Reloaded 4s ago' | 'Couldn’t reload: <extension> has a build error.' (+ Details) | 'Folder missing. Restore it or unlink.'; actions 'Use installed copy' (parked), 'Install published version' (no parked, package found in a marketplace: unlink then open the normal install dialog), 'Unlink'. No Update/Uninstall on these rows.
   - UnlinkDialog: 'Unlink <Name>?' / 'Your installed copy comes back.' or '<Name> is removed. Your folder is not touched.' / 'Cancel' 'Unlink'. Toasts: '<Name> runs from the installed copy.' / '<Name> removed.'
   - Package sheet + browse card: 'Dev link' replaces 'Installed vX'.
4. features/extensions ExtensionCard: render originProblem 'dev-link' as DevLinkTag with links to the Installed row.
5. widgets/extension-page (/x/<extensionId>, the Flow tab): slim strip 'Dev link: <path>' + 'Use installed copy' when the page's extension record has devLink.
6. Dev Playground showcase for the row states (maintaining-dev-playground), mocks in dev/showcases/marketplace-mocks.ts.
7. One Playwright spec (apps/e2e, test-mode server, temp folder): link via dialog, see badge+path on Installed and Settings -> Extensions, unlink.
8. Docs: docs/marketplace guide 'Develop a package with a dev link' (writing-for-humans); contributing/marketplace-installs.md dev-link section; contributing/extension-authoring.md pointer; changelog/unreleased fragment.

Tests (RTL + mock Transport): badge on each surface; dialog states incl. replace checkbox gating 'Link folder'; unlink copy per parked/not; SSE event updates 'Reloaded'.
