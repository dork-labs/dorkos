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
 *   boundary check, no tier gate, whatever the manifest claims. That holds
 *   even for an extension that asks to run separately (DOR-2686): only its
 *   `server.ts` runs in its own process with limits; the client bundle this
 *   tool activates runs here.
 *
 * The first two start a server entry. For an in-process extension that is
 * `require()` in this process with the server's privileges; for one that
 * asks to run separately it is a child process with only the limits its
 * manifest declares (`isolation/isolated-host.ts`). Either way it is code a
 * person must approve first, which is what this gate decides.
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
 * So the gate is on the ARTIFACT, not the action: **a person approves an extension's
 * files, and from then on those files load freely.** First load asks. Every load
 * of the same files after it is silent. The approval is not spent by use and is
 * not a time window. Since DOR-3068 an EDIT to approved files waits for a person
 * again (the one exception is below), so an agent finishes a batch of edits and
 * asks once, rather than once per compile error.
 *
 * ## Where the record lives, and why it is user config
 *
 * `~/.dork/config.json` at `extensions.approvedToRun`, with the copy each approval
 * was given to at `extensions.approvedSources`, both classified `operator-only` in
 * `core/operator/config-write-policy.ts`.
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
 * - **An agent permission** (`permissions`). Loading an extension is not an
 *   agent action, so no permission area covers it, and an "Always allow" answers
 *   one agent's request to run one action, not a person's choice to trust code.
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
 * itself cannot write an approval, through any surface (the one approval DorkOS
 * writes for it is below) — `config_patch`
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
 * ## The one approval DorkOS writes itself: an extension our agent creates
 *
 * DOR-516's rule that an agent-scaffolded bundle must not approve itself is
 * retired for `create_extension` by ADR 261006-225605 (item 5): our agents are
 * trusted by default. On a Trusted install, `ExtensionManager.createExtension`
 * approves the folder it has just scaffolded, through the same three fields a
 * person's approval writes. The agent still cannot write those fields: DorkOS
 * does, once, for a folder the scaffolder created and that no other copy held
 * (`extension-scaffolder.ts` refuses a name spoken for in either root).
 *
 * Everything else about the approval stays as narrow as a person's. It names
 * this folder, its files (unless it keeps path trust, see above) and the
 * permission set the manifest declares now, so a
 * marketplace or hand-copied extension with the same id at another path, and a
 * later version that asks for more, still wait for a person. On Careful, or for
 * an id the person said "Not now" to, nothing is approved and the copy waits.
 * The external `/mcp` door never approves, since its caller cannot be told from
 * an outsider. `extensions.trustedSources` stays Owner-only.
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
 * It is attached to ONE COPY of the extension: its id plus where that copy lives
 * (`extensions.approvedSources`, DOR-2383) — the directory, and the installed
 * plugin that carries it when it came inside one — AND, since DOR-3068, to that
 * copy's contents: the `digest` of its folder (the whole plugin folder for a
 * plugin-carried copy). Path alone used to be enough, which meant approving
 * `foo` trusted whoever could write `foo`'s files from then on. Now discovery
 * digests every copy, a mismatch refuses the code at every load (server start,
 * reload, `test_extension`, the browser bundle), and approved files run from a
 * verified snapshot (`extension-snapshots.ts`), so an edit cannot land between
 * the check and the run. The approval queue raises one "changed since you
 * approved" row per extension, naming the changed files.
 *
 * Path trust survives in one place (`extension-path-trust.ts`): an extension
 * one of our agents created that runs separately, still declares what it did at
 * the yes, and lives inside that agent's own folder by real path. Its edit →
 * test → reload loop on its server half never asks. Its screen half is still
 * pinned to the exact bundle approved ({@link mayLoadClientHalf}). Approvals given before DOR-3068 named no
 * content; each is pinned once to the files found on the first scan after the
 * upgrade (`extension-approval-upkeep.ts`).
 *
 * The copy half is what an id alone could not say. Extensions also arrive inside
 * installed marketplace plugins (`plugins/<name>/.dork/extensions/<id>`), an agent
 * can install a plugin through the marketplace tools, and nothing stops two
 * plugins carrying the same id. Keyed on the id alone, a second plugin naming an
 * approved id would have run on a decision made about the first. Keyed on the
 * copy, it waits for its own approval. An id listed in `approvedToRun` with no
 * recorded copy counts as not approved; the one exception is an approval given
 * before copies were recorded, which `ExtensionManager.reload` binds on first
 * sight to the extension installed directly under `{dorkHome}/extensions/<id>`,
 * the only copy it could ever have been about.
 *
 * Three ways an id could change hands underneath an approval are closed, because
 * none is the person editing their own extension:
 *
 * - **Another copy claiming the id.** A second plugin, or a directory at another
 *   path, is a different copy, so it asks again (above).
 *
 * - **Replacement by the marketplace.** Uninstalling a package forgets the
 *   approval for every extension it bundled (`flows/uninstall/side-effects.ts`), so
 *   reinstalling asks again. An update from the SAME package keeps the approval
 *   naming each extension the new version still carries (DOR-2383), but since
 *   DOR-3068 its new files wait for a person, like any edit to approved files.
 *   One the new version drops loses its approval, and asks again if it ever
 *   comes back. A different package arriving under a familiar id is a different
 *   copy, so it asks (above).
 * - **Shadowing from the project tree.** A `{cwd}/.dork/extensions/<id>` directory,
 *   or one inside a plugin installed into the project, is ignored when `<id>` is
 *   core or approved for some other copy (`extension-discovery.ts`), so a project
 *   file cannot take the place of the copy a decision was made about.
 *
 * ## An approval covers a declared permission set, not just a copy
 *
 * The in-process statement above — approving `foo` trusts whoever can write
 * its files — holds for an extension that runs INSIDE DorkOS, because no edit
 * can ask for more than the full access it already has. An extension that
 * runs separately (`serverCapabilities.runtime: "subprocess"`, DOR-2686)
 * declares what it may reach instead: hosts, programs, agent access. A person
 * reads those lists on the card, so a same-source update or an edit to an
 * approved folder must not widen them silently. Each approval therefore also
 * records the set it was given for (`extensions.approvedPermissions`), and
 * {@link mayRunExtensionCode} requires what the copy declares now to be
 * covered by it (`isolation/permission-coverage.ts`). Narrowing keeps running;
 * widening waits for a person again, through the same approval queue. A
 * missing entry is the full in-process set, which is exactly what every
 * approval before this existed was for. A copy that runs because its source
 * is trusted outright (§9.3) is not held to a set: that yes was to everything
 * from the source, at full in-process authority, and any declared set is
 * narrower than that.
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
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import type { ExtensionsConfig } from './extension-enable-resolution.js';
import { declaredSet, isCovered } from './isolation/permission-coverage.js';
import { clientPinHolds, keepsPathTrust } from './pin/extension-path-trust.js';

/**
 * The fields of an extension record that say which copy of the extension it is,
 * plus where it provably came from when this machine can say (§9.1).
 */
export type ExtensionCopy = Pick<ExtensionRecord, 'id' | 'origin' | 'path' | 'sourcePlugin'> &
  Partial<
    Pick<
      ExtensionRecord,
      | 'trustedOrigin'
      | 'originProblem'
      | 'currentDigest'
      | 'devLink'
      | 'realPath'
      | 'manifest'
      | 'scope'
      | 'clientDigest'
    >
  >;

/**
 * The stored halves of a person's approvals: the ids, the copy each is for,
 * and the code sources they trust outright (spec `flow-multiproject` §9.3).
 */
export type ExtensionApprovals = Pick<ExtensionsConfig, 'approvedToRun' | 'approvedSources'> &
  Partial<Pick<ExtensionsConfig, 'trustedSources' | 'approvedPermissions'>>;

// FAIL-OPEN BY DESIGN, so every writer must spread: an absent
// `approvedPermissions` map (or entry) reads as the full in-process set, which
// is what every approval before DOR-2686 was for. A write to `extensions`
// that rebuilds the object without spreading the stored one drops the map and
// silently widens every approval that runs separately. Pinned by
// `isolation/__tests__/permission-coverage.test.ts`.

/** A copy with the manifest it declares its permission set in. */
export type ExtensionDeclaringCopy = ExtensionCopy & Pick<ExtensionRecord, 'manifest'>;

/**
 * Whether the permission set this copy declares now is covered by the set
 * stored with its approval (DOR-2686). A missing entry is the full in-process
 * set, so it covers anything. Pure.
 *
 * @param copy - The extension record in question.
 * @param approvals - `config.extensions`, or the approval fields of it.
 */
export function isWithinApprovedPermissions(
  copy: ExtensionDeclaringCopy,
  approvals: ExtensionApprovals
): boolean {
  return isCovered(declaredSet(copy.manifest), approvals.approvedPermissions?.[copy.id]);
}

/**
 * The machine-readable code every refusal to run unapproved extension code
 * carries.
 */
export const EXTENSION_NOT_APPROVED_CODE = 'extension_not_approved_to_run';

/** The short `error` field every refusal to run unapproved extension code carries. */
export const EXTENSION_NOT_APPROVED_ERROR =
  'Only a person can approve an extension to run inside DorkOS';

/**
 * The source an approval of this copy records: its directory, and the plugin
 * that carries it when it came inside one.
 *
 * @param copy - The extension record being approved.
 * @returns The value to store under `extensions.approvedSources[copy.id]`.
 */
export function approvedSourceOf(copy: ExtensionCopy): ExtensionApprovedSource {
  const source: ExtensionApprovedSource = { path: path.resolve(copy.path) };
  if (copy.sourcePlugin) source.plugin = copy.sourcePlugin;
  if (copy.trustedOrigin) source.origin = { ...copy.trustedOrigin };
  // A copy that changed after DorkOS installed it is approved as its files
  // are now, and any further change asks again (security review, DOR-2527).
  if (copy.originProblem === 'changed' && copy.currentDigest) source.digest = copy.currentDigest;
  // A copy running from a dev link is approved as that dev link, by path
  // alone, so editing its folder never asks again (DOR-2696).
  if (copy.devLink) source.devLink = copy.devLink.path;
  return source;
}

/**
 * Whether the approval stored for this id names THIS copy by path: the same
 * directory and the same carrying plugin. Pure.
 *
 * @param copy - The extension record in question.
 * @param approvals - `config.extensions`, or the approval fields of it.
 */
export function isApprovedByPath(copy: ExtensionCopy, approvals: ExtensionApprovals): boolean {
  if (!namesThisCopy(copy, approvals)) return false;
  const source = approvals.approvedSources![copy.id]!;
  // A project copy whose plugin changed after DorkOS installed it never keeps
  // running silently on a path approval: the yes must name its files as they
  // are now (security review of DOR-2527).
  if (copy.originProblem === 'changed') {
    return !!source.digest && source.digest === copy.currentDigest;
  }
  // An approval pinned to a digest covers those files only: any change asks
  // again (DOR-3068).
  if (source.digest) return source.digest === copy.currentDigest;
  // A dev link is approved by path alone, so editing its folder never asks
  // again (DOR-2696); the check above already matched it.
  if (source.devLink) return true;
  // Otherwise path trust holds only for an agent's own extension that runs
  // separately, declares what it did at the yes, and stays in its author's
  // folder (`extension-path-trust.ts`).
  return !!copy.manifest && keepsPathTrust({ ...copy, manifest: copy.manifest }, source);
}

/**
 * Whether the approval stored for this id was given to a copy with a trusted
 * origin, and this copy provably shares it (spec `flow-multiproject` §9.1):
 * the same plugin, installed by this machine's installer from the same
 * `owner/repo`. A copy whose files merely claim that origin has no trusted
 * origin at all, so it never matches. Pure.
 *
 * @param copy - The extension record in question.
 * @param approvals - `config.extensions`, or the approval fields of it.
 */
export function isApprovedByOrigin(copy: ExtensionCopy, approvals: ExtensionApprovals): boolean {
  if (!approvals.approvedToRun.includes(copy.id)) return false;
  const source = approvals.approvedSources?.[copy.id];
  // The very copy the person approved is held to the files they approved
  // (DOR-3068), by {@link isApprovedByPath}; its origin does not let an edit
  // or an update past that. Other copies from the same origin are held to
  // what the installer staged (`extension-trusted-origin.ts`).
  if (source && isSameStoredCopy(copy, source)) return false;
  const stored = source?.origin;
  const own = copy.trustedOrigin;
  return !!stored && !!own && stored.plugin === own.plugin && stored.source === own.source;
}

/**
 * Whether a stored approval names this copy's folder and carrying plugin.
 *
 * @param copy - The extension record in question.
 * @param source - The approval stored for its id.
 */
export function isSameStoredCopy(copy: ExtensionCopy, source: ExtensionApprovedSource): boolean {
  return (
    path.resolve(source.path) === path.resolve(copy.path) &&
    (source.plugin ?? null) === (copy.sourcePlugin ?? null)
  );
}

/**
 * Whether the stored approval for this id was given to THIS copy: the same
 * folder, the same carrying plugin, and the same dev link or none. Says
 * nothing about whether its files still match; {@link isApprovedByPath}
 * does. Pure.
 *
 * @param copy - The extension record in question.
 * @param approvals - `config.extensions`, or the approval fields of it.
 */
export function namesThisCopy(copy: ExtensionCopy, approvals: ExtensionApprovals): boolean {
  if (!approvals.approvedToRun.includes(copy.id)) return false;
  const source = approvals.approvedSources?.[copy.id];
  if (!source || !isSameStoredCopy(copy, source)) return false;
  // A dev link sits at its package's normal folder, so the path alone cannot
  // tell it from the installed copy. An approval covers only the kind it was
  // given to: an installed copy's never covers a dev link, a dev link's never
  // covers the installed copy put back after unlink, and one dev link's never
  // covers a link to another folder (DOR-2696).
  return (source.devLink ?? null) === (copy.devLink?.path ?? null);
}

/**
 * Whether the stored approval for this copy is pinned to a folder digest: the
 * copy then runs from a verified snapshot of exactly those files
 * (`extension-snapshots.ts`), never from its live folder.
 *
 * @param copy - The extension record in question.
 * @param approvals - `config.extensions`, or the approval fields of it.
 */
export function isApprovedByDigest(copy: ExtensionCopy, approvals: ExtensionApprovals): boolean {
  const digest = approvals.approvedSources?.[copy.id]?.digest;
  return !!digest && digest === copy.currentDigest && isApprovedByPath(copy, approvals);
}

/**
 * Whether a person approved THIS copy of the extension: its id is in
 * `approvedToRun`, and the source recorded for that id is this copy's
 * directory and carrying plugin, or a trusted origin this copy provably
 * shares (spec `flow-multiproject` §9.1, invariant 8).
 *
 * An id with no recorded source is not approved. Pure, like
 * {@link mayRunExtensionCode}.
 *
 * @param copy - The extension record in question.
 * @param approvals - `config.extensions`, or the approval fields of it.
 * @returns `true` when the stored approval covers this very copy.
 */
export function isApprovedCopy(copy: ExtensionCopy, approvals: ExtensionApprovals): boolean {
  return isApprovedByPath(copy, approvals) || isApprovedByOrigin(copy, approvals);
}

/**
 * Whether this copy provably came from a code source the person trusts
 * outright (`extensions.trustedSources`, spec `flow-multiproject` §9.3). Only
 * a trusted origin counts, so a copy DorkOS did not install is never covered,
 * whatever its files claim. Pure.
 *
 * @param copy - The extension record in question.
 * @param approvals - `config.extensions`, or the trusted sources of it.
 */
export function isFromTrustedSource(
  copy: Partial<Pick<ExtensionRecord, 'trustedOrigin'>>,
  approvals: Partial<Pick<ExtensionsConfig, 'trustedSources'>>
): boolean {
  const source = copy.trustedOrigin?.source;
  if (!source) return false;
  return (approvals.trustedSources ?? []).some((trusted) => trusted.source === source);
}

/** The fields of an extension record that say which copy AND which version it is. */
export type ExtensionVersionedCopy = ExtensionCopy & Pick<ExtensionRecord, 'manifest'>;

/**
 * Whether a person said "Not now" to THIS copy at THIS version in the Activity
 * inbox (DOR-2517).
 *
 * The same identity {@link isApprovedCopy} compares, plus the manifest version:
 * a decline is about what the person was shown, and an update is something new
 * to decide about, so it asks again. Being dismissed changes nothing about
 * whether the code may run; it only stops the inbox asking. Pure.
 *
 * @param copy - The extension record in question.
 * @param extensions - `config.extensions`, or the dismissal map of it. Absent
 *   reads as empty, because opening the store does not merge nested defaults
 *   into an existing `extensions` section.
 * @returns `true` when the recorded dismissal is for this very copy and version.
 */
export function isDismissedCopy(
  copy: ExtensionVersionedCopy,
  extensions: Pick<ExtensionsConfig, 'dismissedApprovals'>
): boolean {
  const dismissed = extensions.dismissedApprovals?.[copy.id];
  if (!dismissed) return false;
  return (
    path.resolve(dismissed.path) === path.resolve(copy.path) &&
    (dismissed.plugin ?? null) === (copy.sourcePlugin ?? null) &&
    dismissed.version === copy.manifest.version
  );
}

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
 * stored approvals so the decision is testable without a config store.
 *
 * Note what is NOT consulted: whether the extension is enabled, whether it
 * compiled, and whether it has a server entry. Approval is about one copy of
 * the code and, unless it keeps path trust, its files (`copy.currentDigest`,
 * DOR-3068), so it outlives every one of those. An extension toggled off and on
 * again is still approved, and one that fails to compile is still approved once
 * it builds from the same files.
 *
 * @param copy - The extension record. `origin` is `'core'` (staged by DorkOS
 *   itself, always allowed) or `'user'`, derived from the record's path in
 *   `extension-discovery.ts`, never from its id or its manifest.
 * A copy that provably came from a source in `extensions.trustedSources` may
 * run too (spec `flow-multiproject` §9.3): the person already said yes to
 * everything from there, once. A copy approved on its own runs only while
 * the permission set it declares is covered by the one recorded with that
 * approval ({@link isWithinApprovedPermissions}, DOR-2686).
 *
 * @param approvals - `config.extensions`: the approved ids, the copy each
 *   approval was given to, and the trusted sources.
 * @returns `true` when DorkOS may execute this extension's code.
 */
export function mayRunExtensionCode(
  copy: ExtensionDeclaringCopy,
  approvals: ExtensionApprovals
): boolean {
  if (copy.origin === 'core') return true;
  if (isFromTrustedSource(copy, approvals)) return true;
  // The approval names this copy AND what it declares now fits inside the set
  // the person approved: a widened manifest waits for them again (DOR-2686).
  return isApprovedCopy(copy, approvals) && isWithinApprovedPermissions(copy, approvals);
}

/**
 * Whether this extension's SCREEN half (the client bundle the app loads into
 * its own page, and `test_extension` runs in this process) may load: it may
 * run at all ({@link mayRunExtensionCode}), and, for a copy that keeps path
 * trust, the bundle is exactly the one a person approved (DOR-3068). Path
 * trust lets an agent's edits to its server half keep running; it never
 * lets new screen code reach the person's page unseen. Pure.
 *
 * @param copy - The extension record.
 * @param approvals - `config.extensions`.
 * @param bundleDigest - The digest of the bundle about to load; defaults to
 *   the one the last compile produced (`copy.clientDigest`).
 */
export function mayLoadClientHalf(
  copy: ExtensionDeclaringCopy,
  approvals: ExtensionApprovals,
  bundleDigest: string | undefined = copy.clientDigest
): boolean {
  if (!mayRunExtensionCode(copy, approvals)) return false;
  if (copy.origin === 'core' || isFromTrustedSource(copy, approvals)) return true;
  const source = approvals.approvedSources?.[copy.id];
  if (!source || !isSameStoredCopy(copy, source)) return true;
  return clientPinHolds(bundleDigest, source);
}

/**
 * Whether this copy may run but its screen half is held back: its server half
 * keeps path trust while its client bundle is not the one approved
 * (DOR-3068). A copy that may not run at all is not "withheld" here; that is
 * the plain approval wait, reported by `approvedToRun`. Pure.
 *
 * @param copy - The extension record.
 * @param approvals - `config.extensions`.
 */
export function isScreenHalfWithheld(
  copy: ExtensionDeclaringCopy,
  approvals: ExtensionApprovals
): boolean {
  return mayRunExtensionCode(copy, approvals) && !mayLoadClientHalf(copy, approvals);
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
    `DorkOS did not run any of '${id}'. Extension code runs with access to this ` +
    `machine, so a person approves the exact files that run, and an edit to an ` +
    `approved extension waits for them again. Retrying will be refused the same way. ` +
    `Finish the whole batch of edits first, then ask the person once to open the ` +
    `Activity inbox or Settings > Extensions in DorkOS and approve '${id}'. Everything ` +
    `else about '${id}' still works in the meantime: you can create and edit its ` +
    `files, and compiling it reports real errors. An extension you create runs from ` +
    `your own folder (.dork/extensions/<id>); if it runs separately ("runtime": ` +
    `"subprocess"), edits to its server code keep running until its declared ` +
    `permissions change, but edits to its screen code still wait for the person.`
  );
}
