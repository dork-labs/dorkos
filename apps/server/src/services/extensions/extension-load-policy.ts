/**
 * Whether one extension's code may EXECUTE inside the DorkOS server process
 * (DOR-516).
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
 * it on the same bar. Turning on Require login closes the residual too, since then
 * every one of those writes needs a real session cookie.
 *
 * Adding this field to `REQUIRES_LOGIN_CONFIG_PATHS` was considered and rejected:
 * that list forbids a write while login is OFF, which in the shipped default would
 * mean nobody could ever approve anything.
 *
 * ## Core extensions are exempt, by origin
 *
 * `origin: 'core'` extensions ship inside the DorkOS the person installed
 * (`ensureCoreExtensions()` stages them; the origin is derived from that staging
 * set, never from a manifest claim). Gating them would make DorkOS ask permission
 * to run itself, and would break the bundled `linear-issues` data proxy on every
 * install. Only `origin: 'user'` extensions — anything an agent scaffolded or the
 * marketplace installed — are gated.
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
 * Whether this extension's code may execute inside the DorkOS server process.
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
 * @param origin - `'core'` (ships with DorkOS, always allowed) or `'user'`.
 * @param approvedToRun - `config.extensions.approvedToRun`, the ids a person
 *   approved.
 * @returns `true` when DorkOS may execute this extension's code in-process.
 */
export function mayRunInServer(
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
