/**
 * Whether one extension's code may EXECUTE — inside the DorkOS server process, or
 * inside the cockpit page (DOR-516).
 *
 * ## Both halves, and why the client half is not "just UI"
 *
 * An extension is two bundles: a `server.ts` that DorkOS `require()`s into its own
 * process, and a client bundle the cockpit `import()`s and `activate()`s in the
 * browser. This one answer covers both, because the browser half is not a weaker
 * place to run: it is same-origin JavaScript on the cockpit page, so it carries the
 * person's session with every `fetch` it makes. Gating only the server half left
 * the shorter way round wide open — `create_extension` (tier `act`) scaffolds,
 * enables, compiles and broadcasts a hot reload, the cockpit picks the bundle up
 * with no page refresh, and that browser code can then `POST
 * /api/extensions/<id>/approve` with the operator's own cookie and approve the
 * server half of itself. Worse, the page a person opens *in order to decide* is the
 * page that runs it. So the client bundle is served only for an extension that may
 * run (`ExtensionManager.readBundle`), and the client loader skips the rest.
 *
 * ## What this stops, and why a tier could not stop it
 *
 * Four MCP tools end in DorkOS running extension code in its own process, and all
 * four are tier `act` — gated and always allowed:
 *
 * - `create_extension` scaffolds and enables, which initializes a server entry.
 * - `reload_extensions --id` recompiles and re-initializes a server entry.
 * - `test_extension` `import()`s a data-URI bundle and calls `activate()`
 *   ({@link testClientExtension}). This one is the sharpest: an agent writes
 *   arbitrary TypeScript to `~/.dork/extensions/foo/index.ts`, calls the tool, and
 *   that code runs in Node with the server's own privileges — no sandbox, no
 *   boundary check, no tier gate, whatever the manifest claims.
 * - `relay_reload_adapters` reaches a dynamic `import()` of an adapter plugin.
 *   Deliberately NOT covered here; see "Not covered" below.
 *
 * Promoting any of them to `destructive` was considered and rejected. The dev loop
 * documented in `contributing/extension-authoring.md` is edit → test → reload →
 * repeat, so a per-call approval card would fire once per compile error. That is
 * the routine-card harm this repo already refused on DOR-504 and DOR-506: a card a
 * person learns to dismiss makes every other card weaker. Tiers are also
 * per-capability and never argument-dependent (`mcp-tool-tiers.ts`), and the tier
 * table names the sanctioned alternative outright — a policy on the ARGUMENT,
 * `tasks/task-write-policy.ts` being the model.
 *
 * So the gate is on the ARTIFACT, not the action: **a person approves an extension
 * id once, and from then on that extension's code loads freely.** First load asks.
 * Every load after it, including a compile error and the fix that follows, is
 * silent. The approval is not spent by use and is not a time window.
 *
 * ## Where the record lives, and why it is user config
 *
 * `~/.dork/config.json` at `extensions.approvedToRun`, classified `operator-only`
 * in `core/operator/config-write-policy.ts`.
 *
 * The requirement is that the record of a HUMAN decision must not be writable by
 * the thing the decision is about. Two candidate homes were rejected for reasons
 * this repo has already paid for:
 *
 * - **Anything in the project tree** (`.dork/agent.json`, an extension's own
 *   manifest, a dotfile beside the source). An agent running in `acceptEdits`
 *   writes those with no prompt and no shell — the DOR-511 lesson, and a much
 *   lower bar than the shell-access adversary in `approvals/decision-authority.ts`.
 *   An approval an agent can write is not an approval.
 * - **A standing permission** (`approval_grants`). Verified unusable, twice over: a
 *   grant keys on `requestedByPath`, which only the `destructive` branch of
 *   `tier-enforcement.ts` ever writes (the `act` branch early-returns), and
 *   minting one additionally requires BOTH `auth.enabled` and
 *   `approvals.standingGrants`, which are both off in the shipped default. A gate
 *   that only exists in a non-default posture is not a gate.
 *
 * User config is where this repo already keeps "only a person may change this":
 * the `operator-only` table, its build-failing drift guard, the cookie bar on
 * `PATCH /api/config` under login, and the refusal inside `config_patch` all come
 * for free the moment the field is classified.
 *
 * ## The residual, stated plainly
 *
 * Under the default posture (`auth.enabled: false`) a caller that simply omits the
 * `X-DorkOS-Agent` header is treated as the local operator by
 * `resolveDecisionAuthority`, because with no accounts there is nothing to check a
 * cookie against. Such a caller can write this field through `PATCH /api/config`.
 * That is DOR-505's documented residual and it reaches this field exactly as it
 * reaches `auth.enabled` — no better, no worse.
 *
 * What this field DOES buy, in the default posture: an agent that identifies
 * itself cannot approve its own extension, through any surface — `config_patch`
 * refuses `operator-only` paths unconditionally, `PATCH /api/config` refuses a
 * caller carrying agent identity, and `POST /api/extensions/:id/approve` refuses
 * it on the same bar. Turning on Require login closes the header residual, since
 * then every one of those writes needs a real session cookie.
 *
 * "Needs a cookie" is only worth something if the cookie cannot be spent by code
 * the person did not run, which is why two things sit alongside it. The client
 * bundle of an unapproved extension is never served, so agent-authored JavaScript
 * does not get to run on the cockpit page and spend the session it finds there.
 * And both approval routes require a trusted `Origin` when the browser sends one,
 * so a page on another site cannot post the approval through a visitor's browser —
 * a cross-site POST needs no cookie at all while login is off, so CORS (which only
 * withholds the response) does not cover it.
 *
 * Adding this field to `REQUIRES_LOGIN_CONFIG_PATHS` was considered and rejected:
 * that list forbids a write while login is OFF, which in the shipped default would
 * mean nobody could ever approve anything.
 *
 * ## Core extensions are exempt, by origin — which is a PATH, not an id
 *
 * `origin: 'core'` extensions ship inside the DorkOS the person installed
 * (`ensureCoreExtensions()` stages them). Gating them would make DorkOS ask
 * permission to run itself, and would break the bundled `linear-issues` data proxy
 * on every install. Only `origin: 'user'` extensions — anything an agent
 * scaffolded or the marketplace installed — are gated.
 *
 * That exemption is only as good as what `origin` is derived from, and it must be
 * the record's resolved PATH: `core` means "this is the copy `ensureCoreExtensions`
 * staged under `{dorkHome}/extensions/<id>`" (`extension-discovery.ts`). Deriving
 * it from id membership instead handed the exemption to anything that reused a
 * bundled id, and the cheapest way to reuse one is a file in the project tree —
 * `{cwd}/.dork/extensions/marketplace/server.ts`, written with no prompt and no
 * shell, which won the local-over-global merge and ran as core at the next boot.
 * The staging copy is rewritten from the bundle on every boot for the same reason
 * (`ensure-core-extensions.ts`), so a "core" directory always holds DorkOS's code.
 *
 * ## What the approval is attached to, and what it is not
 *
 * It is attached to the extension id, so the edit → test → reload loop is asked
 * once and never again. The consequence is stated plainly rather than hidden:
 * approving `foo` trusts whoever can write `foo`'s files from then on, and editing
 * those files never re-asks. That is the deliberate trade named above.
 *
 * Two ways an id could change hands underneath an approval are closed, because
 * neither is the person editing their own extension:
 *
 * - **Replacement by the marketplace.** Uninstalling a package forgets the
 *   approval for every extension it bundled (`flows/uninstall.ts`), and an update
 *   is an uninstall followed by an install, so different code arriving under a
 *   familiar name is asked about again.
 * - **Shadowing from the project tree.** A `{cwd}/.dork/extensions/<id>` directory
 *   is ignored when `<id>` is core or already approved (`extension-discovery.ts`),
 *   so a project file cannot inherit a decision made about the installed copy.
 *
 * ## Not covered, deliberately
 *
 * Relay adapter plugins. `loadAdapters` in `packages/relay/src/adapter-plugin-loader.ts`
 * dynamically imports `plugin.package` (any npm name) or `plugin.path` (any path)
 * from `~/.dork/relay/adapters.json`. That is a real second code-load path, but it
 * is a different artifact in a different file needing its own list and its own
 * consent UI, and — decisively — gating the `relay_reload_adapters` tool would be
 * theater: `adapters.json` is watched, and a write to it reaches the same
 * `AdapterManager.reload()` with no tool call at all. The gate there has to sit
 * inside the loader, not on the tool, which is its own change.
 *
 * @module services/extensions/extension-load-policy
 */

/**
 * The machine-readable code every refusal to run unapproved extension code
 * carries.
 */
export const EXTENSION_NOT_APPROVED_CODE = 'extension_not_approved_to_run';

/** The short `error` field every refusal to run unapproved extension code carries. */
export const EXTENSION_NOT_APPROVED_ERROR =
  'Only a person can approve an extension to run inside DorkOS';

/**
 * Whether this extension's code may execute at all — in the DorkOS server process
 * or in the cockpit page.
 *
 * One answer for both halves on purpose. There are three call sites and they are
 * the three places extension-authored code starts running:
 * {@link ExtensionServerLifecycle.initialize} (`require()` of a server bundle),
 * {@link testClientExtension} (`import()` of a data URI), and
 * {@link ExtensionManager.readBundle} (the client bundle the browser `import()`s
 * and `activate()`s). A fourth, {@link toPublic}, only reports the answer to the
 * cockpit so it can render the card.
 *
 * Pure: no I/O and no `config-manager` import, matching
 * {@link module:services/extensions/extension-enable-resolution}. Callers pass the
 * stored list so the decision is testable without a config store.
 *
 * Note what is NOT consulted: whether the extension is enabled, whether it
 * compiled, and whether it has a server entry. Approval is about the code, so it
 * outlives every one of those. An extension toggled off and on again is still
 * approved, and one that fails to compile is still approved once it builds.
 *
 * @param id - Extension id.
 * @param origin - `'core'` (staged by DorkOS itself, always allowed) or `'user'`.
 *   Derived from the record's path in `extension-discovery.ts`, never from its id
 *   or its manifest.
 * @param approvedToRun - `config.extensions.approvedToRun`, the ids a person
 *   approved.
 * @returns `true` when DorkOS may execute this extension's code.
 */
export function mayRunExtensionCode(
  id: string,
  origin: 'core' | 'user',
  approvedToRun: readonly string[]
): boolean {
  if (origin === 'core') return true;
  return approvedToRun.includes(id);
}

/**
 * The refusal an agent reads.
 *
 * Names the extension, says in one plain sentence why DorkOS stopped, and gives
 * the ONE action that unblocks it. This text lands in a model's context, and a
 * model that is only told "no" retries: it has to be obvious that retrying the
 * same call cannot work and that a person has to click something.
 *
 * @param id - The extension id that was refused.
 * @returns One paragraph written for the model.
 */
export function describeExtensionLoadRefusal(id: string): string {
  return (
    `DorkOS did not run any of '${id}'. Extension code runs inside the DorkOS server ` +
    `itself, with the server's own access to this machine, so a person has to approve ` +
    `each extension once before that can happen. Retrying will be refused the same way. ` +
    `Ask the person to open Settings > Extensions in DorkOS and approve '${id}'. They ` +
    `only ever do this once for this extension — after that, editing, testing, and ` +
    `reloading it all work with nothing further to click. Everything else about '${id}' ` +
    `still works in the meantime: you can create and edit its files, and compiling it ` +
    `reports real errors.`
  );
}
