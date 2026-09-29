---
slug: flow-multiproject
id: 260928-190705
created: 2026-09-28
status: specified
tracker: DOR-2517 (phase 1); phases 2-4 open their own DOR issues under the project "Flow across many projects"
project: Flow across many projects
ideation: specs/flow-multiproject/01-ideation.md
design: specs/flow-multiproject/design-decisions.md (binding) and converged-design.md; mockups in design/*.html
companion: dork-labs/marketplace specs/flow-multiproject/ (the flow extension; builds against §11 of this file)
---

# Flow across many projects: core seams

**Status:** Specified. The visual design (V1-V10, including Round 2) is the operator's; the non-visual decisions (N1-N12) are the orchestrator's. Both are final and are not re-argued here. Where the code disagrees with an assumption in `design-decisions.md`, §2 says so and records the decision. Everything else this spec had to decide is marked **Decided in spec** where it is made.

**Scope:** DorkOS core only: `apps/server`, `apps/client`, `packages/shared`, `packages/db`, `packages/extension-api`, docs. The flow extension (its tab, home, run chip component and settings component) is specified in the marketplace repo and consumes the contracts in §11.

## 1. Overview

Four problems, four phases:

| Phase | What ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Decisions                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1     | **DOR-2517.** An extension waiting to run asks in the Activity inbox with one short row ("Turn on Flow?", a why line, ⓘ 👎 👍).                                                                                                                                                                                                                                                                                                                                                                                                  | V1, V8, N2 (approval half), N3                                                                  |
| 2     | **Projects and extension seams.** A core project registry with one shared `resolveProjectRoot`; inbox decisions for extensions (`ctx.inbox`, `extension_decisions`) with a required why, questions with an agent's pick and a deadline, one-time follow-up offers, and who-decided history; inbox grouping by project; extension pages at `/x/<id>/<path>`; a status-bar slot; a tab marker; `currentProject`; `ctx.projects`; starting work in a new chat (`ctx.sessions.start`, `api.startWork`); many tracker items per chat. | V2, V3 (marker), V4 (route), V5 (slot), V7, V8, V9, V10 (history), N1, N2, N4, N8, N9, N11, N12 |
| 3     | **Account eligibility.** Two rules in config, enforced at every place an account is picked, with a plain refusal.                                                                                                                                                                                                                                                                                                                                                                                                                | V6 (core half), N6                                                                              |
| 4     | **Extensions across many projects, and trusted sources.** Discovery scans every known project; copies from one trusted source collapse to the newest; "Next time, trust everything from <source>?" and `extensions.trustedSources`.                                                                                                                                                                                                                                                                                              | N5, V9 (approval half), N11                                                                     |

Phase 1 depends on nothing else. Phase 2's registry is a prerequisite for phases 3 and 4. Phases 3 and 4 are independent of each other.

## 2. Where the code disagrees with the decisions doc, and what this spec decides

| #   | Decisions doc assumed                                                             | The code today                                                                                                                                                                                                                                                                                                                                   | Decided in spec                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | V1: after an answer the row "moves to Earlier".                                   | The bell (`apps/client/src/layers/widgets/inbox-bell/ui/InboxBell.tsx`) has two sections, "Needs You" and "Activity". There is no "Earlier".                                                                                                                                                                                                     | The history row lands in the bell's existing **Activity** list, which is the bell's history. No new "Earlier" heading. Same row, same copy, same "Allow it" link.                                                                                                                                                                                                                                         |
| D2  | N2: standing kinds are fed by "a store" and the bell count follows them.          | "Needs You" is not built from notification rows at all. It renders client-side live queues from `useWaitingQueue()` (`apps/client/src/layers/entities/attention/model/use-waiting-queue.ts`), and the pill counts those queues.                                                                                                                  | Both new kinds get a **live queue** in `useWaitingQueue` (like asks, capability approvals and parked schedules) and a registry entry in `notification-registry.ts` for the standing events and the one history row. That is how they reach "Needs you" and the bell count.                                                                                                                                |
| D3  | N3: dismissal "bound to the current source and version".                          | Approvals store only `{ path, plugin? }` (`ExtensionApprovedSourceSchema`, `packages/shared/src/config-schema.ts`). No version is stored anywhere, and nothing records a decline.                                                                                                                                                                | A new config leaf `extensions.dismissedApprovals` stores `{ path, plugin?, version }` per id (§5.2).                                                                                                                                                                                                                                                                                                      |
| D4  | N1: "`api.navigate` accepts" pages.                                               | `api.navigate` is a no-op in production: `apps/client/src/main.tsx` wires `extensionDeps.navigate` to a stub that only warns, and nothing replaces it. `internalRoutePath` (`apps/client/src/layers/shared/lib/link-navigation.ts`) accepts only exact paths from `APP_ROUTE_PATHS`.                                                             | Phase 2 wires `navigate` to the real router and teaches `internalRoutePath` the `/x/<id>/...` prefix (§6.5). This fixes a live bug for every extension, not just flow.                                                                                                                                                                                                                                    |
| D5  | N4: `worktree-scan.ts` is "a test-only helper".                                   | It is production code serving `GET /api/workspaces` scans (`apps/server/src/routes/workspaces.ts`). Three places derive a main checkout from `--git-common-dir`, and they disagree: `flow-run-link.ts` always takes `dirname`, `worktree-scan.ts` strips only a trailing `.git`, `room-repo-git.ts` resolves a relative dir. None canonicalizes. | One helper, `resolveProjectRoot`, with the `worktree-scan.ts` rule (a bare repo's common dir is its own root) and `canonicalDirectory`. `flow-run-link.ts` and `worktree-scan.ts` move to it. `room-repo-git.ts` keeps its own ceiling-bounded call: it answers a different question (a room's private repo, with a ceiling so git cannot climb out) and is recorded as out of scope, not as a duplicate. |
| D6  | N6: "a one-time migration of `fleet.json`" into core.                             | `apps/server/src/services/core/usage/__tests__/no-fleet-policy-read.test.ts` forbids any core source from naming `fleet.json` (invariant 4 of `claude-account-ui`). Also, fleet.json's rule is `scope.repos: ["owner/name"]` read only for kept-out accounts, not project roots.                                                                 | Core never reads `fleet.json`; the invariant stands. **Flow** does the migration, through a core write API (§8.6), mapping `owner/name` to project roots with `ProjectInfo.originRepo` (§6.1).                                                                                                                                                                                                            |
| D7  | N6: enforce at "every automatic pick site".                                       | A person's own pick (the first-message account in the status-bar picker, and a same-runtime "Continue on another account") is deliberately never checked today.                                                                                                                                                                                  | Eligibility is the person's own rule, so it binds **every** pick, including their own. The pickers show an ineligible account disabled with its reason, and the server refuses it. The V6 checkbox already asks before widening a rule, so a person who wants the exception makes it there, once.                                                                                                         |
| D8  | N1: "a new `status-bar` slot ... follows the status bar's existing item pattern". | The status line is a closed registry (`STATUS_BAR_REGISTRY`, closed `StatusBarItemKey` union) with promote and severity rules and a width budget. Pins persist in config against a closed enum, and a new pin value makes an older build discard the config file.                                                                                | One new registry entry, key `extensions`, unpinnable (`group: null`, the same reason the `account` item gives). Each extension item declares a pure `when(ctx)` so core can promote without mounting it (§6.6).                                                                                                                                                                                           |
| D9  | N5: "copies from the same approved source collapse".                              | An approval is bound to a copy's **path**. Four repos hold four paths, so "same source" never matches. A file inside a repo (`.dork/install-metadata.json`) cannot be trusted as proof of origin: anyone can commit one.                                                                                                                         | A copy has a trusted **origin** only when this machine's installer recorded it in `{dorkHome}/marketplace/project-installs.json` (or it sits under `{dorkHome}/plugins`, which only DorkOS writes). Approval gains an optional origin; copies with the approved trusted origin count as approved (§9).                                                                                                    |
| D10 | N9: `Session` gains a list.                                                       | `trackerItem` reaches only `GET /api/sessions` and `GET /api/sessions/:id`; the session-list broadcaster never applies the fleet overlay, so live updates never carry it. Flow's CLI reads `trackerItem` (marketplace `plugins/flow/scripts/fleet/sessions.ts`).                                                                                 | `trackerItems` is added beside `trackerItem`, which stays (the newest item) for a deprecation window with a named removal condition, and the broadcaster applies the same overlay to both (§6.8).                                                                                                                                                                                                         |
| D11 | N1: extension server routes can be kept to a person.                              | `/api/ext/:id/*` (`apps/server/src/middleware/extension-routes.ts`) delegates straight to the extension's router with no person check, so any agent can call flow's settings or pause routes.                                                                                                                                                    | A core seam `ctx.requirePerson` (§7.6) that extension routers put in front of any route that changes state on a person's behalf.                                                                                                                                                                                                                                                                          |
| D13 | N12: `startedBy` is "shown as the chat's first line".                             | Sessions carry `origin` (`SessionOriginSchema`: user, agent, channel, room, task, external) filled by overlays in `apps/server/src/services/session/origin/session-origin-overlays.ts`; nothing records which extension or chat started a session, and a chat's title is set through `runtime.renameSession` (`PATCH /api/sessions/:id`).        | A new `session_started_by` table and a third origin overlay step fill `Session.startedBy`; the title goes through `renameSession` at start (§7.7).                                                                                                                                                                                                                                                        |
| D14 | V9/N11: "trust everything from dork-labs".                                        | A source is only provable through the trusted origin of §9.1 (a repo file cannot prove it), which lands in phase 4.                                                                                                                                                                                                                              | `extensions.trustedSources` and core's approval follow-up offer ship in phase 4, keyed on the trusted origin's `source`: the install's `sourceRepo` normalized to `owner/repo` (e.g. `dork-labs/marketplace`; never `installedFrom`, a name the person chose), and the copy names that `owner/repo`. Phase 1 ships without the offer.                                                                     |
| D12 | N2: only `blocking` kinds push.                                                   | `raiseStanding` calls `armEscalation` for every standing kind (`standing-events.ts`), and `EscalationService.arm` has no tier check (`escalation-service.ts`). Every standing kind today happens to be `blocking`.                                                                                                                               | Phase 1 adds the tier gate in `armEscalation` and in `EscalationService.arm`: a kind whose registry tier is not `blocking` never arms (§5.4).                                                                                                                                                                                                                                                             |

## 3. Goals and non-goals

**Goals**

- An extension waiting for approval is one click away from running, from the inbox, with no reload (phase 1).
- Every capability flow needs is a documented, typed, tested extension seam that any extension can use.
- One definition of "project", computed once, cached, shared by every caller.
- A restricted account never runs work in a project its rules exclude, whoever or whatever picks it.
- Which copy of an extension loads no longer depends on the server's working folder.

**Non-goals**

- The flow extension's UI (marketplace spec).
- Moving the account pool; it is already core (`runtimes.claudeCode.accounts[]`, the usage store, the advisor).
- Eligibility for Codex and OpenCode accounts. Only Claude Code has a multi-account registry today; the eligibility module is written runtime-keyed so a second runtime is a data change.
- A sidebar entry for extension pages (N10: no new app chrome for a plugin).
- Exact escalation time limits (N7; flow owns them).

## 4. Invariants (each needs its evidence in a test)

1. **Declining is never destructive.** 👎 on an approval row uninstalls, disables and revokes nothing (N3).
2. **One live row per (extension, key).** Raising an open key updates it in place; it never adds a second row and never re-pushes (N2, V2).
3. **An approval never pushes to a phone** (`extension.approval` is `notable`). A decision may (`extension.decision` is `blocking`).
4. **Extension keys are namespaced by core.** Extension A cannot read, resolve or answer extension B's decisions.
5. **One root rule.** No server file other than `services/projects/resolve-project-root.ts` runs `--git-common-dir` to find a main checkout, except the rooms carve-out in D5. `worktree-scan.ts` calls that module's exported uncached reader. A grep test enforces it.
6. **No launch falls back to an ineligible account.** Every pick site listed in §8.4 either picks an eligible account or refuses with the plain message.
7. **Core never reads `fleet.json`** (the existing guard stays green).
8. **Approval stays source-bound.** A copy runs only if a person approved that path, or approved a trusted origin that this copy provably shares.
9. **Extensions cannot widen account access from their server half.** No `ctx` member writes eligibility rules; only the two person-bar routes in §8.6 do. The person bar (`refuseIfNotAPerson`, `apps/server/src/routes/extensions-person-bar.ts`) has a documented residual: with login off, a local caller that omits its `X-DorkOS-Agent` header is trusted, exactly as on `PATCH /api/config`. So the honest guarantee with login off is "an agent that names itself cannot widen account access"; with Require login on, an agent or a local script cannot. **Neither posture can tell a person from an approved extension's own browser code**: extension bundles are loaded into the app page by `import()` (`apps/client/src/layers/features/extensions/model/extension-loader.ts`), so they share its origin and, with login on, its cookie. That is the trust a person grants when they turn an extension on (the consent copy already says it "can do anything you can do in DorkOS"). This spec does not close either residual; it states them beside every route that relies on the bar (§7.3, §7.6, §7.7, §7.8, §7.10, §8.6, §9.3).
10. **State-changing extension routes can be kept away from agents.** `ctx.requirePerson` applies the same bar to `/api/ext/:id/*` routes (§7.6), with the same residuals as invariant 9. Only answers given in core-drawn UI are attributed to a person; anything that arrives through an extension path is attributed to the extension (§7.3).
11. **Links are in-app and scoped.** Every `link`, `href` and `navigate` an extension hands core is a core route or `/x/<that extension's own id>/…`; the server refuses anything else (§7.1).

12. **Every ask says why.** No row core draws has only a title: `extension.approval` derives its why line from the manifest, and `extension.decision` refuses a raise without `why` (N11).
13. **A person is never the bottleneck on a question that has a deadline.** A `choice` decision with `decideBy` resolves at the deadline with the agent's pick, unless the extension keeps it open (it then resolves it later itself) or applying it fails, in which case it stays with the person and says so.
14. **"A person or a checked agent decided" is a full guarantee only with Require login on**, and even then an approved extension's browser code is trusted as the person (invariant 9). The autonomy UI says so when login is off (§7.10).
15. **Trust is granted only by a person, once per proven source.** `extensions.trustedSources` is written only through the person bar, and covers only copies with a trusted origin (§9.1).

## 5. Phase 1: DOR-2517, an extension waiting to run asks in the inbox

### 5.1 The live source (server)

New module `apps/server/src/services/extensions/extension-approval-queue.ts`:

```ts
/** One extension waiting for a person to allow it to run. */
export interface PendingExtensionApproval {
  /** Extension id. */
  id: string;
  /** Manifest name, e.g. "Flow". */
  name: string;
  /** Manifest version of the copy that would run. */
  version: string;
  /** Resolved path of that copy; part of the source it would be bound to. */
  path: string;
  /** Plugin folder it came inside, when plugin-carried. */
  plugin: string | null;
  /** The mono source line, e.g. "flow plugin · dork-labs/marketplace". */
  sourceLabel: string;
  /** Whether it has a server half, which picks the consent copy variant. */
  runsInServer: boolean;
  /** Plain one-liner of what it adds, or null (see below). */
  adds: string | null;
  /** When this copy was first seen waiting (stable across restarts; see below). */
  since: string;
  /** The second line (V8): what happens and why, derived from the manifest (see below). */
  why: string;
}

/** Every extension that is waiting, oldest first. */
export function listPendingExtensionApprovals(
  manager: ExtensionManager
): PendingExtensionApproval[];
```

An extension is pending when **all** hold:

- `origin === 'user'` (core extensions never ask),
- `approvedToRun === false` (computed today by `mayRunExtensionCode` in `extension-load-policy.ts`),
- status is not `disabled`, `invalid` or `incompatible` (someone who turned it off is not asked),
- it is not dismissed for its current `(path, plugin, version)` (§5.2).

This covers all three raise cases of N3 with one rule: a new install or update brings a copy that is not approved; a source change drops the path-bound approval; an enabled-but-never-approved extension is simply not approved. An update from the **same** approved source keeps `approvedToRun` true, so it is not pending.

- `sourceLabel`: plugin-carried: `"<plugin> plugin · <sourceRepo ?? installedFrom ?? 'installed locally'>"`, read from the install's `.dork/install-metadata.json` (`readInstallMetadata`, `apps/server/src/services/marketplace/installed-metadata.ts`). This label is display only and never used for trust (D9). Direct install: `"installed in <path with ~ for home>"`.
- `adds` (V1 "one line on what it adds when the manifest says so"): **Decided in spec.** The manifest's `contributions` map (`manifest-schema.ts`, informational today) is the only honest source. When it lists `right-panel` and/or `settings.tabs` (and, from phase 2, `pages`), core writes "It adds a <Name> tab", "a <Name> settings page", joined plainly ("It adds a Flow tab and a Flow settings page"). Absent or empty: `null`, and the line is omitted. It never guesses.
- `since`: the first time the manager saw this `(id, path, version)` pending, kept in memory and seeded at boot from discovery time. It only orders rows.
- `why` (V8, **Decided in spec**): the second line of the row, built by core from the manifest, never free text an extension can make longer:
  - "You installed the <plugin> plugin." (plugin-carried) or "You installed <Name>." (direct install);
  - then, when `adds` is known: "This adds " + the parts ("a Flow tab", "a Flow settings page") + (` that <purpose>` when the manifest has `purpose`) + ".";
  - else, when the manifest has `description`: that description;
  - then "It runs as you."
  - For flow: "You installed the flow plugin. This adds a Flow tab that shows what your agents are working on. It runs as you."
  - The manifest gains an optional `purpose: z.string().max(120)` in `packages/extension-api/src/manifest-schema.ts` ("what it does, finishing the sentence 'This adds a Flow tab that …'"). The whole line is cut at 300 characters. ExtensionCard's consent copy moves behind ⓘ.

The manager emits a change whenever the pending set changes (after `reload()`, `updateCwd()`, approve, revoke, dismiss). A small emitter in `extension-approval-queue.ts` diffs the set and calls the standing events:

- new pending id: `raiseStanding('extension.approval', payload)` (`apps/server/src/services/notifications/standing-events.ts`),
- id leaves the set: `resolveStanding('extension.approval', payload, { outcome })` with `approved` (approved), `dismissed` (dismissed), or `cancelled` (uninstalled, disabled or became invalid, **no history row** for `cancelled`; see §5.4).

### 5.2 Dismissal ("Not now")

Config, `packages/shared/src/config-schema.ts`, beside `approvedSources`:

```ts
/** A copy a person said "Not now" to. Re-asks when path, plugin or version changes. */
export const ExtensionDismissedApprovalSchema = z.object({
  path: z.string().min(1),
  plugin: z.string().min(1).optional(),
  version: z.string().min(1),
  dismissedAt: z.string(),
});
// extensions.dismissedApprovals: z.record(z.string(), ExtensionDismissedApprovalSchema).default({})
```

- `isDismissedCopy(copy, config)` in `extension-load-policy.ts` compares the resolved path, plugin and manifest version.
- Written by `ExtensionManager.dismissApproval(id, expected: { path; version })`. It refuses with `409 stale_approval` when the current copy no longer matches `expected` (the row the person saw is out of date).
- Cleared for an id when that id is approved (so a later revoke plus reinstall asks again).
- Config lifecycle (per `contributing/configuration.md`): Zod default `{}`; a migration under the next free key at merge time (`0.92.0` at the time of writing; the newest tag is `v0.89.0`, and `0.90.0`/`0.91.0` have merged) that seeds `extensions.dismissedApprovals = {}` when absent, guarded by `store.has`, pinned in `merged-migration-hashes.ts`; `CONFIG_WRITE_POLICY` `operator-only` (it is consent state, like `approvedSources`); `CONFIG_DISCLOSURE` `withhold`; `default-verdicts.ts` `no-risk`; no protective carry-over (losing it only means being asked again). Readers tolerate absence (`?? {}`), because opening the store does not merge nested defaults into an existing `extensions` section.

### 5.3 Routes

In `apps/server/src/routes/extensions-approval.ts` (beside the existing approve/revoke):

| Route                                       | Bar                                                   | Body                                | Result                                                                         |
| ------------------------------------------- | ----------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/extensions/pending-approvals`     | normal API auth                                       | none                                | `{ approvals: PendingExtensionApproval[] }`                                    |
| `POST /api/extensions/:id/approve`          | **existing**, `refuseIfNotAPerson(..., APPROVAL_BAR)` | unchanged                           | unchanged; also clears any dismissal and resolves the standing item `approved` |
| `POST /api/extensions/:id/dismiss-approval` | `refuseIfNotAPerson(..., APPROVAL_BAR)`               | `{ path: string; version: string }` | `204`; `409 stale_approval`; `409` for a core extension; `404` unknown id      |

The shared request/response schemas live in `packages/shared/src/extension-approval-schemas.ts` (new subpath `@dorkos/shared/extension-approval-schemas`, added to the `exports` map) and are registered in `apps/server/src/services/core/openapi-registry.ts`; regenerate and commit the API docs in the same PR.

There is still no MCP tool that approves or dismisses (the existing rule).

### 5.4 Notification kinds

`packages/shared/src/notification-schemas.ts`:

- `NOTIFICATION_KINDS` gains `'extension.approval'` (phase 1) and `'extension.decision'` (phase 2).
- `NOTIFICATION_OUTCOMES` gains `'dismissed'` (phase 1). The outcome column is a type-level enum, so no DDL.

`apps/server/src/services/notifications/notification-registry.ts`:

```ts
'extension.approval': {
  kind: 'extension.approval', tier: 'notable', storage: 'standing', subjectType: 'system',
  title: (p) => `Turn on ${p.name}?`,
  body: (p) => p.why,
  dedupeKey: (p) => `ext-approval:${p.id}:${p.path}:${p.version}`,
  relay: 'never',
}
```

- Payload: `{ id, name, version, path, plugin, sourceLabel, why, runsInServer, adds }`.
- `StandingNotificationKind` gains it. Tier `notable`: it counts in "Needs you" and badges the bell, and never pushes (invariant 3).
- **The tier gate (D12).** Today nothing enforces "only `blocking` escalates": `raiseStanding` (`apps/server/src/services/notifications/standing-events.ts`) calls `armEscalation` for every standing kind, and `EscalationService.arm` (`escalation-service.ts`) arms whatever it is given. Phase 1 adds `if (notificationEntry(kind).tier !== 'blocking') return;` at the top of both `armEscalation` and `EscalationService.arm` (and `rearmFromStandingState` skips such kinds at boot). Two gates on purpose: the module function is what callers use, the method is what a test or a future caller may reach directly.
- History row on resolution only for `approved` and `dismissed`. `cancelled` (the copy vanished) writes nothing: there was no answer to record.
- Arrival path: `standing_pending` / `standing_resolved` (not `interaction_pending`, which is for asks).
- `standingDeepLink('extension.approval')` is `/?settings=extensions`.
- `NOTIFICATION_ICONS['extension.approval']` is lucide `Puzzle` (the icon the right-panel header already uses for extensions).

### 5.5 Client

**The row component (V1).** `apps/client/src/layers/features/inbox/ui/InboxDecisionRow.tsx`, exported from `features/inbox/index.ts`. It is **presentational**: it takes data and callbacks and owns only the ⓘ expanded state. That is what lets it sit in `features/inbox` while the bell widget wires data from entities (FSD: widgets may compose features and entities; the row imports nothing from other features).

```ts
export interface InboxDecisionRowProps {
  icon: LucideIcon;
  title: string; // "Turn on Flow?" (a question or an outcome, V8)
  why: string; // second line: what happens, why now, what "no" means (V8)
  sourceLine?: string; // mono line: "flow plugin · dork-labs/marketplace"
  meta?: string; // "Can't reach it since 09:14 · asked after 1h" (phase 2)
  more?: ReactNode; // the ⓘ panel's content; no ⓘ button when absent
  actions:
    | {
        kind: 'yes-no';
        approveLabel: string;
        rejectLabel: string;
        onApprove(): void;
        onReject(): void;
      }
    | { kind: 'word'; label: string; onClick(): void }
    | {
        kind: 'choice';
        choices: { id: string; label: string }[];
        defaultChoiceId: string;
        deadlineLine: string;
        allowReply: boolean;
        onChoose(id: string): void;
        onReply(text: string): void;
      }; // phase 2
  pending?: 'approve' | 'reject' | 'word' | 'choice' | null; // disables buttons while a request is in flight
  onOpen?: () => void; // title click, when the item links somewhere
  followUp?: { text: string; onAccept(): void; onDismiss(): void } | null; // V9 green line (phase 2)
}
```

- Layout exactly per V1: icon tile, bold title, muted mono source line, then on the right three 26px outlined icon buttons (`Info`, `ThumbsDown`, `ThumbsUp` from lucide) using the shared `Button` (`variant="outline"`, `size="icon"`) with `Tooltip` from `layers/shared/ui/tooltip.tsx`. Accessible names: "More about this", then the reject label, then the approve label. For the approval row they are "Not now" and "Turn it on" (V8: buttons read as outcomes). Order is ⓘ, 👎, 👍. The `why` line sits under the title in the row's normal text colour, never truncated below two lines; the mono source line follows it.
- ⓘ toggles an in-place panel below the row (`aria-expanded`, `aria-controls`; the button shows pressed with `aria-pressed`). No popover. The same on a phone. Focus stays on ⓘ.
- The `word` variant draws one small outlined text button (V2).
- Motion: the expand uses `motion`'s height animation already used for inbox groups; reduced motion shows it instantly.

**The ⓘ content for approvals.** The two consent strings move out of `apps/client/src/layers/features/extensions/ui/ExtensionCard.tsx` into a new foundational entity slice `apps/client/src/layers/entities/extension/` (`lib/consent-copy.ts`, `extensionConsentCopy(runsInServer: boolean): string`), so the card and the inbox render one source. The panel shows that copy (the fuller "None of it has run yet…" wording; the `why` line already said what it adds), then the link "See it in Settings → Extensions" (`/?settings=extensions`). The card's own button label becomes "Turn it on" to match.

**The live queue.** `apps/client/src/layers/entities/extension/model/use-pending-extension-approvals.ts` (TanStack Query on `GET /api/extensions/pending-approvals`, invalidated by `standing_pending`/`standing_resolved` events of this kind and by `extension_reloaded`). `useWaitingQueue` gains `extensionApprovals` and `deriveWaitingItems` gains one `WaitingItem` per approval with a new `AttentionSignalKind` `'extension-approval'` (`apps/client/src/layers/entities/attention/model/attention-signal.ts`). The `attention` composite now consumes the `extension` foundation, which is the DAG direction the FSD rule wants.

Mutations in `entities/extension/model/use-extension-approval-actions.ts`: `approve(id)` (existing endpoint) and `dismiss(id, { path, version })`. Optimistic removal from the queue; on error the row returns with a toast in plain words ("Couldn't allow Flow. Try again.").

**The bell.** `InboxBell.tsx` renders, in "Needs You", an `ExtensionApprovalList` (a small widget-local component in `widgets/inbox-bell/ui/`) above the existing `AskList`. `waitingLabel()` and `waitingSummary()` count approvals like any other waiting item.

**After an answer (V1, D1).** The history row is an ordinary `notifications` row. `InboxList` renders kinds `extension.approval` and `extension.decision` with `InboxDecisionRow` in a compact history form (no buttons) instead of `InboxRow`:

- `approved`: "You turned on Flow · 2:14pm · Flow tab added". The trailing clause is `adds` restated in past tense, or omitted.
- `dismissed`: "Flow is off for now · 2:14pm · Turn it on". "Turn it on" calls `approve(id)` when that copy is still the one pending (the queue has the id with the same path and version); otherwise it opens Settings → Extensions.
- From phase 4, an `approved` row may carry core's own one-time follow-up (§9.3).

**The live activation.** Unchanged and already true: approving broadcasts `extension_reloaded`, `extension-context.tsx` reloads, and a right-panel tab the extension registers appears with no page reload.

### 5.6 Tests (the DOR-2517 "Done when")

Server (`apps/server/src/services/extensions/__tests__/extension-approval-queue.test.ts`, using the plugin fixture `apps/server/src/services/marketplace/fixtures/valid-plugin/`):

1. **Install produces one item.** Install a plugin carrying an extension into a temp dork home; assert `GET /api/extensions/pending-approvals` returns exactly one item and exactly one `standing_pending` of kind `extension.approval` was broadcast.
2. **Allowing it there flips `approvedToRun` and the panel mounts.** `POST /api/extensions/:id/approve` as a person; assert the record's `approvedToRun` is true, the queue is empty, one history row with outcome `approved` exists, and `extension_reloaded` fired. The client half is asserted in (6).
3. **Same-source update produces no new item.** Approve, then replace the plugin copy in place with a higher version (same path, same plugin); assert no pending item and no new standing event.
4. **Source change produces one.** Approve, then move the extension to another plugin folder (different path); assert exactly one pending item.
5. **Dismissal is bound to source and version.** Dismiss; assert empty queue, one `dismissed` history row, extension still installed and enabled. Bump the version: one new item. Dismiss with a stale `{ path, version }`: `409 stale_approval`.
6. Client (`apps/client/src/layers/features/inbox/__tests__/InboxDecisionRow.test.tsx`, `widgets/inbox-bell/__tests__/`): the title "Turn on Flow?" and the derived why line (plugin-carried, direct, with and without `adds`, `purpose` and `description`, cut at 300); accessible names; ⓘ expands in place with `aria-expanded`; 👍 calls approve and the row leaves; 👎 calls dismiss; the history rows' copy; "Allow it" re-approves.
7. Registry drift: `WIRED_NOTIFICATION_KINDS` and the icon map cover the new kind (existing guards fail until they do).
8. Escalation: raising `extension.approval` arms no timer and makes no push call, through both `raiseStanding` and a direct `EscalationService.arm`. The test must go red with the tier gate removed (check by deleting the gate once while writing it).

**Real browser** (`apps/e2e/tests/extensions/approval-inbox.spec.ts`): the e2e global setup installs a fixture plugin carrying an extension named "Flow" that registers a right-panel tab titled "Flow" (fixture under `apps/e2e/fixtures/extensions/flow-fixture/`, id `flow-fixture`, so it never collides with the real plugin). Open the bell, see "Turn on Flow?" with its why line, click "Turn it on" once, and assert the "Flow" tab appears in the right panel with no reload. Run with `/browsertest`; grep `apps/e2e` for any copy this phase changes.

### 5.7 Docs and changelog (phase 1)

- `contributing/extension-authoring.md` §"Step 4: the one-time approval": the inbox row, "Not now" semantics.
- `docs/integrations/extensions.mdx` "Testing locally": a newly installed extension shows up in the Activity inbox.
- Fragment `changelog/unreleased/<id>-extension-approval-inbox.md`, `### Added`: "When you install a plugin that brings an extension, the Activity inbox now asks once whether to turn it on, and says what it adds. One click turns it on, and its tab appears right away. 'Not now' removes nothing. (DOR-2517)"

## 6. Phase 2a: the project registry and the client seams

### 6.1 `resolveProjectRoot` and the registry (server)

New domain directory `apps/server/src/services/projects/` (add `projects` to the service-domain census in `AGENTS.md` and `scripts/__tests__/agents-service-census.test.ts`):

```ts
// resolve-project-root.ts
/**
 * The git main checkout a folder belongs to, or null when it is in no repo.
 * Worktrees and subfolders map to their main checkout. Cached per canonical cwd.
 */
export async function resolveProjectRoot(cwd: string): Promise<string | null>;
```

- Runs `git rev-parse --path-format=absolute --git-common-dir` via `runGit` (`apps/server/src/services/workspace/providers/git.ts`), 5s timeout.
- The root is the parent of the common dir when its basename is `.git`; otherwise (a bare repo) the common dir itself. This is `worktree-scan.ts`'s `repoPathFromCommonDir` rule, which moves here.
- Input and output go through `canonicalDirectory` (`packages/shared/src/canonical-directory.ts`), so `/Users/x/Dev` and a symlink to it are one project.
- Cache: positive for the process life, negative for 60s (today's `flow-run-link.ts` numbers, `NEGATIVE_CWD_TTL_MS`).
- A folder that holds several repos but is in none is "no project" by construction (git answers "not a repository").

```ts
// project-registry.ts
export interface ProjectRef {
  root: string;
  name: string;
}
export interface ProjectInfo extends ProjectRef {
  /** "owner/name" parsed from the `origin` remote, or null. */
  originRepo: string | null;
  lastSeenAt: string;
}
export class ProjectRegistry {
  resolve(cwd: string): Promise<ProjectRef | null>; // resolveProjectRoot + remember
  list(): Promise<ProjectInfo[]>; // roots that still exist, by name
  report(path: string, extensionId: string): Promise<ProjectRef | null>; // an extension's hint
  onChange(listener: () => void): () => void;
}
export const projectRegistry: ProjectRegistry;
```

- **What feeds it** (N4): every session cwd the server resolves (session launch, `resolveSessionCwdOrNull`, the session-state projector), every agent `projectPath` (`MeshCore.listWithPaths()`), every workspace `source` (`WorkspaceStore.list()`), every project install root's project in `project-installs.json` (`readProjectInstalls`), and `ctx.projects.report`. Boot seeds from agents, workspaces and installs.
- **Reported roots are second-class.** `report(path, extensionId)` first applies the boundary check (`lib/boundary.ts`), then requires `resolveProjectRoot` to find a git repo; otherwise it returns null and records nothing. A root known **only** through `report` is stored with `source = 'reported'` and the reporting extension's id, and it does **not** feed phase 4's extension scan (§9.2): an extension cannot widen where core looks for code to run.
- **Persistence.** New Drizzle table `known_projects` (`packages/db/src/schema/projects.ts`; add it to the explicit list in `packages/db/drizzle.config.ts` and the barrel; generate the next numbered migration, `0122_known_projects.sql` at the time of writing): `root TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, origin_repo TEXT NULL, source TEXT NOT NULL ('seen' | 'reported'), reported_by TEXT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL`. A root reported first and later seen as a session, agent, workspace or install folder is upgraded to `seen`. **Decided in spec:** named `known_projects` because "project" already means several things here (mesh `projectPath`, workspace `projectKey`, project rooms). Roots whose folder no longer exists are hidden from `list()` and kept (a drive may be unplugged).
- **Names are URL-safe and stable.** A name is assigned once, when the root is first recorded, and persisted in `known_projects.name`; it never changes afterwards, so a bookmark such as `/x/flow/p/dorkos` or `?project=dorkos` keeps meaning the same project. The name is the root's basename with every character outside `[A-Za-z0-9._-]` replaced by `-`. If that name is taken, the newcomer gets `basename~parent` (the parent folder's basename, same character rule), then `basename~parent-2`, `-3` and so on. The project that had the name first keeps it. Flow and every other reader use names unchanged.
- `originRepo`: `git remote get-url origin`, parsed for `github.com`-style `owner/name` (https and ssh forms), else null.
- **What `ctx.projects.list()` returns.** Only projects that hold a copy of the calling extension (a `.dork/extensions/<id>` or `.dork/plugins/*/.dork/extensions/<id>` folder under the root, checked with a stat per known root and cached until the registry or discovery changes) or that the extension reported itself. An extension does not learn every folder the person works in. The browser route `GET /api/projects` returns the full list, since it answers the person.

**Callers moved (N4):**

- `apps/server/src/services/session/fleet/flow-run-link.ts` `lookUpStateFile` uses `resolveProjectRoot` and drops its own git call and cwd cache.
- `apps/server/src/services/workspace/worktree-scan.ts` `inspectCheckout` calls `readProjectRootUncached(dir)`, a second export of `resolve-project-root.ts` that runs the same git call and rule without the cache (the scan walks folders that are not session cwds, and it keeps its own concurrency cap). Its `repoPathFromCommonDir` moves into that module.
- Invariant 5's grep test: `apps/server/src/services/projects/__tests__/single-root-rule.test.ts` fails if any non-test server file other than `resolve-project-root.ts` and `rooms/repo/room-repo-git.ts` contains `--git-common-dir` (after the move, `worktree-scan.ts` no longer does).

**Routes** (`apps/server/src/routes/projects.ts`, mounted at `/api/projects`):

| Route                                  | Result                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`                    | `{ projects: ProjectInfo[] }`                                                                                    |
| `GET /api/projects/resolve?cwd=<path>` | `{ project: ProjectRef \| null }`; the cwd must pass the existing boundary check (`lib/boundary.ts`), else `403` |

Schemas in `packages/shared/src/project-schemas.ts` (new subpath `@dorkos/shared/project-schemas`).

### 6.2 `project` on things the inbox already shows (V2, N2)

**Decided in spec:** the client cannot run git, so the server stamps `project: ProjectRef | null` onto the wire shapes of every waiting kind that knows its folder:

| Kind                             | Wire shape                                                                    | Folder used                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Asks (tool approvals, questions) | `InteractionPendingEventSchema` (`packages/shared/src/interaction-events.ts`) | its `cwd`                                                                     |
| Capability approvals             | `PendingApprovalSchema` (`packages/shared/src/approval-schemas.ts`)           | the `approvals.requesting_cwd` column                                         |
| Parked schedules                 | `TaskSchema` (`packages/shared/src/schemas.ts`), as a response-only field     | the run directory `resolve-run-execution.ts` resolves (the task's agent path) |
| Extension decisions              | `ExtensionDecisionDTO` (§7.2)                                                 | the decision's `project`                                                      |
| Extension approvals              | none                                                                          | global by nature; never grouped                                               |

Fields are optional on the wire so an older client ignores them.

### 6.3 Grouping in the inbox (V2)

`apps/client/src/layers/features/inbox/lib/group-by-project.ts`:

```ts
export function groupByProject<T>(
  items: readonly T[],
  projectOf: (item: T) => ProjectRef | null
): { project: ProjectRef | null; items: T[] }[];
```

- Groups keep first-seen order of their most urgent item. Items with `project: null` form one trailing group with no heading.
- **With fewer than two distinct projects, it returns one group with no heading** (V2: the heading hides).
- The heading (`InboxProjectHeading.tsx`): project name left; right side muted with a tracker label when one is known. **Decided in spec:** core does not know trackers. The heading's right side shows the label an extension attached to that project through `ctx.inbox` (`DecisionInput.projectLabel`, e.g. "Linear DOR"; the latest one raised for that project wins), else nothing.
- "Needs You" renders every waiting kind through the grouping, so tool approvals, asks, schedules and flow decisions under one project sit together. Non-flow items keep today's row components (V2).

### 6.4 `currentProject` (client seam)

- New entity slice `apps/client/src/layers/entities/project/` with `useProjectForCwd(cwd)` (TanStack Query, `GET /api/projects/resolve`, `staleTime: Infinity` per cwd) and `useProjects()`.
- App store gains `currentProject: ProjectRef | null` (`apps/client/src/layers/shared/model/app-store/app-store-types.ts`), written by `useCurrentProjectSync()` mounted in `features/extensions/model/extension-context.tsx` from `selectedCwd`.
- `projectState()` in `extension-api-factory.ts` adds `currentProject`, so `api.getState()` and `api.subscribe(s => s.currentProject, ...)` work like `currentCwd`. It is `null` while resolving and for no project.

### 6.5 Pages at `/x/<extensionId>/<path>` (N1, N8)

**API:**

```ts
registerPage(path: string, component: ComponentType<ExtensionPageProps>, options: ExtensionPageOptions): () => void;
```

- `path`: `''` for the extension's home, or segments with `:param` placeholders (`'p/:name'`). Validated `/^(?:[a-z0-9-]+|:[a-z][a-zA-Z0-9]*)(?:\/(?:[a-z0-9-]+|:[a-z][a-zA-Z0-9]*))*$|^$/`. A duplicate path from one extension replaces the earlier one with a console warning.
- Pages are stored in a new registry slot `pages` in `apps/client/src/layers/shared/model/extension-registry.ts`, keyed by `<extensionId>:<path>`.

**Router** (`apps/client/src/router.tsx`): one route under `appShellRoute`, `path: '/x/$extensionId/$'` (plus `'/x/$extensionId'` for the home), `staticData: { header: ExtensionPageBar }`, `validateSearch` passing through a flat `Record<string, string>`. The component `ExtensionPageRoute` (in `apps/client/src/layers/widgets/extension-page/`) matches the splat against that extension's registered paths (literal segments before params, then longest match) and renders:

- the page, with `params`, `search`, and `setSearch(next)` (writes the URL, so V4's `?project=<name>` is bookmarkable);
- while the extension is still loading: a skeleton, never a 404 (a deep link on reload arrives before activation);
- when the extension is missing, not allowed to run, or has no such page: a plain empty state: "This page isn't available. <Name> isn't installed." / "<Name> isn't allowed to run yet. Allow it" (link to Settings → Extensions) / "<Name> doesn't have this page."

`ExtensionPageBar` shows the page's `title` and icon; `features/app-tabs/lib/tab-target.ts` derives tab titles and icons for `/x/` paths from the registry.

**Navigation (D4):** `internalRoutePath` accepts any `/x/<id>[/<segments>][?query]` where `<id>` matches `EXTENSION_ID_REGEX`, and `apps/client/src/__tests__/app-route-paths.test.ts` gains the prefix case. `main.tsx` replaces the stub with the router's `navigate` once the router exists (the factory reads `deps.navigate` at call time, so late binding works). Covered by a test that `api.navigate('/x/hello/p/one?x=1')` reaches the router.

**Listing (N1):**

- Command palette: `use-palette-items.ts` adds a group "Add-ons" with one item per page whose `options.menu !== false` and whose path has no params, labelled `options.title`. Selecting navigates.
- Phone: `apps/client/src/layers/widgets/mobile-tabs/ui/MobileTabsLayout.tsx`'s "You" panel shows an "Add-ons" list under `SidebarFooterStrip`, same items, only when at least one exists. `SidebarFooterStrip`'s `DESTINATIONS` stays closed: no sidebar entry (N10).

### 6.6 The status-bar slot (V5, D8)

**API:**

```ts
registerStatusBarItem(id: string, component: ComponentType<StatusBarSlotContext>, options: StatusBarItemOptions): () => void;
```

`ExtensionPointId` gains `'status-bar'` (for `isSlotAvailable`), and the host's `SLOT_IDS` gains it.

**Host:**

- `STATUS_BAR_REGISTRY` (`apps/client/src/layers/features/status/model/status-bar-registry.ts`) gains one entry: key `'extensions'`, label "Add-ons", cluster `right`, placed directly after `account`, `group: null` (not pinnable, for the same reason `account` gives), icon `Puzzle`, `promote: (ctx) => ctx.extensionItems.some((i) => i.visible)`, `severity: (ctx) => ctx.extensionItems.some((i) => i.urgent) ? SEVERITY.ACCOUNT_ATTENTION : SEVERITY.EXTENSION_ITEM`, where `EXTENSION_ITEM` is a new level at 35 beside `SUBAGENTS_RUNNING` (live work, the same weight).
- `StatusPromotionContext` gains `extensionItems: { id: string; visible: boolean; urgent: boolean }[]`, computed by calling each contribution's `when` and `urgent` with the slot context, each wrapped in try/catch (a throw means not visible, logged once per id). **`when` and `urgent` must read only their `ctx` argument**: they run inside the status bar's render and budget pass, so they may not fetch, read extension state or subscribe. Anything else an item needs to decide belongs in `ctx`, which is why `trackerItems` is on it. This is documented on the TSDoc and in the authoring guide; core cannot enforce it beyond calling them synchronously.
- `buildStatusItemNodes` (`apps/client/src/layers/features/chat/ui/status/status-item-nodes.tsx`) sets `nodes.extensions` to `<ExtensionStatusItems ctx={...} />`, which renders each visible contribution inside an error boundary, in `priority` order (lower first), separated like other items.
- The slot context comes from the session the status bar already reads: `sessionId`, `cwd`, `currentProject` for that cwd, and `trackerItems` (§6.8).
- Budget: the whole `extensions` item is one slot for `status-budget.ts`. On a phone it follows the same budget; the component decides its own compact form by reading a `compact` flag (`StatusBarSlotContext.compact`, true under the `sm` breakpoint), which is how V5's "id and state only" is done.

### 6.7 The tab marker (V3, N1)

**API:** `setTabMarker(tabId: string, marker: 'attention' | null): void`, where `tabId` is the id the extension passed to `registerComponent('right-panel', tabId, ...)`.

- Stored in the extension registry as `tabMarkers: Record<string /* namespaced */, 'attention'>`, cleared when the extension deactivates.
- `TabUnreadDot` (`apps/client/src/layers/features/right-panel/ui/TabUnreadDot.tsx`) becomes one component with two sources: the built-in `VIEW_BY_TAB` table for canvas/browser (unchanged) and `tabMarkers` for extension tabs. Core draws the dot, and an extension cannot style it. The built-in canvas/browser dot keeps `bg-primary` (unread content); the extension marker uses `bg-status-warning-dot`, the amber V3 asks for, because it means "needs you", not "unread". The tab's accessible name becomes "<Label>, something needs you" while marked.
- Setting a marker on a tab the extension did not register is a no-op with a console warning.

### 6.8 One chat, many items (N9, D10)

- `packages/shared/src/schemas.ts` `SessionSchema` gains, **beside** the existing `trackerItem`:

  ```ts
  trackerItems: z.array(z.object({
    id: z.string(),
    stage: z.string().nullable(),
    runStatus: z.string().nullable(),
    startedAt: z.string(),
    via: z.enum(['this-chat', 'own-chat']),
    ownChatSessionId: z.string().nullable(),
  })).optional(), // newest first
  ```

  `trackerItem` stays, set to the newest element of the list (the same `{ id, stage, runStatus }` it has today), and is marked `@deprecated` in TSDoc and the OpenAPI description.

- `flow-run-link.ts`: `indexBySession` keeps every record per session (a list, newest `startedAt` first, compared as parsed dates, ties broken by file order), replacing the single winner. A record belongs to a session when `record.sessionId === session.id` (`via: 'this-chat'`, `ownChatSessionId: null`) **or** `record.dispatchedBy === session.id` (`via: 'own-chat'`: work this chat started that runs in its own chat; `ownChatSessionId` is the record's own `sessionId` when that chat is a DorkOS chat, else null). A record matching both ways counts once, as `this-chat`. `ownChatSessionId` is the target of V7's "Open its chat"; when it is null the row has no such link. The word "helper" appears on no surface. `FlowRunSchema` gains `dispatchedBy: z.string().optional()`; it is a fleet-contract addition in flow (its `flow-run.cases.json` gains the case), and core's fleet conformance test runs that case only from phase 3's re-vendoring (§8.7). Phase 2 covers `dispatchedBy` with core's own unit tests. `applyTrackerItems` writes both fields. `FlowRunLink` becomes the element type.
- **Removal condition for `trackerItem`:** it is removed in the first DorkOS minor release that comes out at least 60 days after a published flow release whose `scripts/fleet/sessions.ts` and advisor read only `trackerItems`, and only when the extension-seam contract fixture (§10.5) has been bumped to record the removal. Until both hold, core writes both fields.
- `apps/server/src/services/session/session-list-broadcaster.ts` applies the same overlay, so live session updates carry both fields.
- Readers updated: `apps/client/src/layers/features/status/model/use-session-account.ts` (`trackerItems`, the popover shows the newest: "Working on DOR-2387", or "Working on 3 items"), `AccountPopover.tsx`, `ContinueOnAccountDialog.tsx`, `AccountLimitBanner.tsx` / `use-limit-banner.ts` (non-empty list), `limit-plans.ts` `trackerItemOf` becomes `trackerItemsOf`, and `packages/extension-api/src/server-extension-api.ts` `SessionInfo` / `LimitedSessionInfo` gain `trackerItems: { id: string; via: 'this-chat' | 'own-chat' }[]` beside the existing, now deprecated, `trackerItem?: { id }` (same removal condition). The OpenAPI description in `openapi-registry.ts` follows.

## 7. Phase 2b: extension decisions in the inbox

### 7.1 Server API (`ctx.inbox`)

See §11 for the exact types. Behaviour:

- **Namespacing (invariant 4).** Core stores `extension_id` and the extension's `key` separately and every call is scoped to the calling extension's id. Keys match `/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/`.
- **raise.** If an open row exists for `(extension_id, key)`, update `title`, `detail`, `project`, `projectLabel`, `since`, `actions`, `link` in place and bump `updated_at`; no new standing event if only text changed (a `standing_pending` update is sent so open clients refresh, but escalation is not re-armed). Otherwise insert, broadcast `standing_pending` of kind `extension.decision`, and arm escalation (it is `blocking`). Limits: title ≤ 120, detail ≤ 500 (plain text, no markdown), at most 50 open decisions per extension (the 51st throws `InboxLimitError`; see Limits below).
- **resolve(key, { outcome })**: `cleared` is "resolved on its own"; `cancelled` is "no longer needed" (the extension withdrew it, e.g. the item was closed elsewhere); `approved` / `rejected` / `answered` when the extension settled it elsewhere. Writes `resolved_at`, `outcome`, `resolved_by = 'extension'`, cancels escalation, broadcasts `standing_resolved`, writes the one history row. Returns false when nothing was open.
- **onAction(handler)**: one handler per extension (a second replaces the first, like the advisor). Bounded at 5 seconds.
- **Project.** `project` may be any path inside the project; core runs `projectRegistry.report` (boundary check and git repo required, §6.1) and stores the root, or null. The heading label comes only from `DecisionInput.projectLabel`; `ctx.projects.report` carries no label.
- **Links (invariant 11).** `link`, a `word` action's `href`, and a handler's `navigate` must pass `isAllowedExtensionLink(url, extensionId)` in `apps/server/src/services/extensions/extension-links.ts`: a path that the client's `internalRoutePath` accepts as a core route (the server imports the same `APP_ROUTE_PATHS` list from `@dorkos/shared`, which moves there from `link-navigation.ts` so both sides share one list), or `/x/<the raising extension's own id>` optionally followed by `/…` and `?…`. Absolute URLs, protocol-relative `//…`, `javascript:`, `data:` and another extension's `/x/<other>/…` are refused: `raise` throws `InboxLinkError`, and a handler result with a bad `navigate` is treated as a handler error (the row stays). The push deep link is `link` only when it passed this check, else `/`.
- **Why is required (N11, V8).** `why` (plain text, 1 to 300 characters after trimming) is the row's second line: what happens, why now, what a "no" means. `raise` without it throws `InboxLimitError` with `limit: 'why'` and writes nothing. Core does not judge the words; the flow spec owns its copy, and the authoring guide states V8's three rules.
- **Questions (N11, V8).** `actions.kind === 'choice'` carries 2 to 5 `choices` (`{ id, label }`, label ≤ 40), an optional `defaultChoice` (one of the ids: the agent's pick), an optional `decideBy` (ISO time), and optional `allowReply`. `decideBy` requires `defaultChoice`. A `decideBy` earlier than raise time + 5 minutes (including one already past) is **clamped** to raise time + 5 minutes; one more than 7 days ahead throws `InboxLimitError` `limit: 'decideBy'`. Core draws the chips with "agent's pick" on the default (when there is one) and, only when `decideBy` is set, a deadline line: "If you don't answer by 5pm, the agent picks “Keep it”." (time in the viewer's zone; a date when it is not today). Without `decideBy` there is no deadline line and no timer.
- **The deadline fires in core.** A timer per open `choice` decision that has `decideBy`, persisted through `decide_by`. At the deadline core calls the action handler with `{ action: 'choice', choiceId: defaultChoice, decidedBy: 'deadline' }` and acts on the result:
  - `{ resolve }`: core resolves the row `answered` with `resolved_by = 'deadline'` and the chosen id; history reads "Decided by the agent at 5pm: Keep it".
  - `{ keepOpen }`: **honoured.** The timer is cancelled, nothing is retried, and the row stays open (the deadline line goes away). The extension settles it later with `resolve(key, { outcome, by })`, e.g. once its reviewer agent has looked.
  - `{ settled: true }`: the extension already settled it (or it is moot). Valid, not an error: core cancels the timer and does nothing else; if the row is still open, it waits for the extension's own `resolve`.
  - a throw or a timeout: core retries twice, one and five minutes later; after that the row stays open, marked "The agent couldn't go ahead. It needs you.", and escalates like any blocking decision.
  - A person answering first cancels the timer.
- **Deadlines wait for the extension.** A deadline fires only while the extension is running **and** has registered `onAction`. Deadlines passed while the server was down, or while the extension was still activating, fire once both hold, never at boot before activation. No handler registered is not a failure: the timer waits and nothing is retried. While the extension is disabled or revoked, its deadline timers are paused with its escalation (Lifecycle below).
- **Limits.** Title ≤ 120, why ≤ 300 and detail ≤ 500 characters (plain text); a reject note or `word` input ≤ 2000 characters (checked on both the route and the client); at most 50 open decisions per extension. Breaking a limit throws `InboxLimitError` (documented in §11.2) and writes nothing.
- **Lifecycle.**
  - While an extension is not running (disabled, revoked, failed to activate), its open decisions are hidden from lists and the bell and kept, and their escalation timers are **cancelled** (`cancelEscalationByKey`) and their deadline timers **paused**, so a phone is never woken and no default is applied for something nobody can answer. When it runs again and registers `onAction`, they reappear, escalation re-arms, and a deadline that passed meanwhile fires then.
  - A decision whose `project_root` folder no longer exists (an unplugged drive) is hidden, not cancelled, and its timer is cancelled; it reappears and re-arms when the folder is back.
  - When an extension is no longer discovered at boot, its open decisions resolve `cancelled` with no history row (there is nobody left to explain them).
- **Push text is generic.** The escalation push for `extension.decision` says "<Extension name> needs you in 1 project" ("in 3 projects" when several are open), never a decision title, key or project name, because the lock screen is not private. The row itself carries the detail.

### 7.2 Storage

New table `extension_decisions` (`packages/db/src/schema/extension-decisions.ts`; add to `drizzle.config.ts` and the barrel; next numbered migration):

| Column                                        | Type                       | Notes                                                                                              |
| --------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                                          | text PK                    | ULID                                                                                               |
| `extension_id`                                | text not null              |                                                                                                    |
| `key`                                         | text not null              | the extension's own key                                                                            |
| `project_root`                                | text null                  |                                                                                                    |
| `project_label`                               | text null                  |                                                                                                    |
| `title`                                       | text not null              |                                                                                                    |
| `detail`                                      | text null                  |                                                                                                    |
| `actions_json`                                | text not null              | `DecisionActions`                                                                                  |
| `link`                                        | text null                  | in-app path                                                                                        |
| `why`                                         | text not null              | the required second line (≤ 300)                                                                   |
| `since`                                       | text null                  | when the condition began                                                                           |
| `decide_by`, `default_choice`                 | text null                  | questions only                                                                                     |
| `raised_at`, `updated_at`                     | text not null              |                                                                                                    |
| `resolved_at`, `outcome`, `note`, `choice_id` | text null                  | `note`: the "Needs changes" note or the typed answer (≤ 2000); `choice_id`: the chosen choice      |
| `resolved_by`                                 | text null                  | `person`, `deadline`, `agent`, `rule`, `extension` (§7.9)                                          |
| `resolved_by_label`                           | text null                  | who, in words, for `agent` and `rule` ("the reviewer agent", "your 'Tell me after' setting"), ≤ 60 |
| `offer_json`, `offer_used_at`                 | text null                  | the V9 follow-up offer (§7.8)                                                                      |
| `recorded`                                    | integer not null default 0 | 1 for a history-only row from `ctx.inbox.record` (never an ask)                                    |

Unique partial index `(extension_id, key) WHERE resolved_at IS NULL` (the dedupe, N2). Index on `(resolved_at, raised_at)`. Resolved rows older than 30 days are pruned with the notifications retention sweep. Migration test in `packages/db/src/__tests__/extension-decisions-migration.test.ts`.

Service: `apps/server/src/services/extensions/extension-inbox.ts` (`ExtensionInboxService`), wired into `createDataProviderContext` in `extension-server-api-factory.ts`.

### 7.3 Routes

| Route                                      | Bar                                                           | Body                                                                                                                                                                                           | Result                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/extension-decisions`             | normal                                                        | none                                                                                                                                                                                           | `{ decisions: ExtensionDecisionDTO[] }`, open decisions of running extensions                                                                                                                                                |
| `POST /api/extension-decisions/:id/action` | `refuseIfNotAPerson` (copy: "Only a person can answer this.") | `{ action: 'approve' \| 'reject' \| 'word' \| 'choice'; note?: string (≤ 2000); text?: string (≤ the action's `input.maxLength`, itself ≤ 2000; for `choice` a "Reply…"); choiceId?: string }` | `200 { resolved: boolean; message: string \| null; navigate: string \| null; offer: { text: string } \| null }`; `409 not_running` ("Flow isn't running right now."); `409 already_resolved`; `504 extension_timeout`; `404` |

`ExtensionDecisionDTO` = `{ id, extensionId, extensionName, key, title, why, detail, project: ProjectRef | null, projectLabel, since, actions, link, raisedAt }` (`actions` of kind `choice` include `defaultChoice` and `decideBy`).

| `POST /api/extension-decisions/:id/offer` | `refuseIfNotAPerson` | `{ accept: boolean }` | `200 { message: string \| null }`; `409 offer_gone` when it was used, dismissed or is older than 15 minutes (§7.8) | `GET /api/extension-decisions?extensionId=<id>` filters to one extension (what `api.listDecisions()` calls).

Action semantics:

- `word` with `href` and no `input` is handled in the client (navigate; the row stays until the extension resolves it) and never reaches this route. A `word` with `input` shows an inline field ("Answer") and posts `word` with `text`.
- Everything else calls the handler. `{ resolve: outcome, navigate?, offer?, watch? }` resolves with `resolved_by = 'person'` and stores the note or text; `{ keepOpen: true, message?, navigate?, watch? }` keeps the row, shows `message` as a toast, and issues a `pendingActionId` (below).
- **Watch (V7).** Either result may carry `watch: { sessionId, label }` (label ≤ 40, e.g. "Sorting 12 ideas…"). Core stores it on the row and draws "Sorting 12 ideas… · Watch" on the open row or the history row; "Watch" opens `/session?session=<sessionId>`. The session id must name a chat whose `startedBy` is this extension (or a chat started from one), else the `watch` is dropped with a log line.
- **Pending actions.** When a person's answer gets `keepOpen`, core records a `pendingActionId` (a ULID, stored with the person attribution, the action, note and text, valid until the row resolves) and passes it to the handler in `DecisionActionEvent.pendingActionId`. When the extension later calls `resolve(key, { outcome, answering: pendingActionId, offer? })`, the history row is attributed to that person (`resolved_by = 'person'`), and `offer` is shown to them once, the next time that person's app is open, exactly like §7.8. A stale or foreign `pendingActionId` is ignored (the resolve still happens, attributed to the extension). A validated `navigate` is returned to the client, which goes there. A handler that throws, times out or returns an invalid `navigate` keeps the row: "Flow couldn't take that. Try again."
- **The row must still be open.** The route reads the row, calls the handler, then resolves inside one SQLite transaction that re-checks `resolved_at IS NULL`; if the extension (or a second tab) resolved it meanwhile, the answer is not recorded and the route answers `409 already_resolved` ("This was already settled."). Two clicks never write two outcomes.
- **Two paths, two attributions.**
  - `POST /api/extension-decisions/:id/action` (and `/offer`) are **core UI endpoints**: the bell and the inbox call them. They are not reachable through any `ExtensionAPI` member. An answer here is attributed `person`.
  - `api.answerDecision` and `api.listDecisions` (§11.1), which flow's home and lens use, call `POST /api/extensions/:id/decisions/:decisionId/action` and `GET /api/extensions/:id/decisions`. The server scopes both to `:id`: a decision raised by another extension answers `404`. The client host fills `:id` with the calling extension's own id. An answer through this path is attributed `resolved_by = 'extension'` with `resolved_by_label` "in <Name>" (history: "… · answered in Flow at 2:14pm"), never `person`, and it never carries an offer.
  - **Residual, stated here as at every route using the bar:** both paths sit behind `refuseIfNotAPerson`, which refuses agents that name themselves (and, with login on, anything without the person's cookie), but cannot tell a person from same-page extension code, which can call any of these URLs with `fetch`, including another extension's `:id` or the core UI endpoints. Scoping by `:id` stops mistakes and keeps each extension's surface to its own rows; it is not a wall against a hostile approved extension, which already has everything the person has (invariant 9).

### 7.4 Notification kind

`'extension.decision'`: tier `blocking`, storage `standing`, subject type `system`, `dedupeKey: (p) => \`ext-decision:${p.extensionId}:${p.key}\``, `relay: 'never'`, deep link `p.link ?? '/'`. Escalation uses the existing ladder (`notifications.escalation.phoneAfterMinutes`); the extension already waited its own time limit before raising (N7).

History copy (V2, §7.9): `cleared` → "<title> · Resolved on its own at 11:02"; `cancelled` → "<title> · No longer needed"; `approved` / `rejected` / `answered` → "<title> · <what was chosen> · <who> at 11:02", where who is "you", "the agent" (deadline), `resolved_by_label` (agent or rule). `NOTIFICATION_OUTCOMES` already has `cancelled`; the inbox renders it with this copy for this kind. The history row's `data_json` carries `{ extensionId, key, outcome, resolvedBy, resolvedByLabel, choiceLabel }` so the copy can be rebuilt on read.

### 7.5 Client

- `entities/extension/model/use-extension-decisions.ts` (query + action mutation), feeding `useWaitingQueue` as `extensionDecisions` with `AttentionSignalKind` `'extension-decision'`.
- The bell renders them with `InboxDecisionRow`: `yes-no` gets ⓘ (when `detail` is present), 👎 (`rejectLabel`), 👍 (`approveLabel`); `word` gets its one button. The mono source line is always the **extension's manifest name** as core knows it ("Flow"), never text the extension supplies, so one extension cannot dress a row up as another's or as core's. `meta` shows `since` as "since 09:14" and, when the row was raised later than `since`, "· asked after 1h" (V2).
- Every row shows `why` under the title (V8).
- A `choice` question shows its chips (the default marked "agent's pick"), the deadline line, and "Reply…" when `allowReply`, which expands a text field and posts `choice` with `text`.
- After an answer that returned an `offer`, the history row shows it once as a green line with "Yes" and a quiet dismiss (§7.8).
- A `word` action with `input` expands an inline text field in the row (its `placeholder`, at most `maxLength` characters) with Send and Cancel; Send posts `word` with `text` (V2's inline "Answer").
- `rejectAsksForNote: true`: 👎 expands a text field in the row ("What needs to change?", at most 2000 characters, with a counter near the limit) with Send and Cancel; Send posts `reject` with the note. Never closes anything by itself (V2).

### 7.6 Keeping extension routes to a person (D11)

`/api/ext/:id/*` is served by `createExtensionRoutesMiddleware` (`apps/server/src/middleware/extension-routes.ts`), which hands the request to the extension's router with no person check. Flow's settings, pause and decision routes would be callable by any agent.

- **Seam.** `ctx.requirePerson` (§11.2) is an Express `RequestHandler` the extension puts in front of a route: `router.put('/settings', ctx.requirePerson, handler)`, or `router.use(ctx.requirePerson)` for a whole router. It calls `refuseIfNotAPerson(req, res, copy)` with a `PersonBarCopy` built from the extension's manifest name ("Only a person can change Flow's settings.", code `extension_person_required`), so it is exactly the bar that guards approving an extension, with both of its residuals (invariant 9): with login off a local caller without `X-DorkOS-Agent` passes, and in any posture same-page extension code passes.
- **Flow must use it** on every route that changes state on a person's behalf: settings writes, pause and resume, and anything else a person clicks. Read routes need not. Decisions are not answered through extension routes at all (§7.3), with one carve-out: on a host without `ctx.inbox` (before phase 2b), core holds no decisions, so the extension's own route behind `ctx.requirePerson` is the only path for an answer given on its page. Once `ctx.inbox` exists, the extension must use it.
- **Tests** (`apps/server/src/services/extensions/__tests__/extension-person-bar.test.ts`): through the real `/api/ext/:id/*` middleware, a route behind `ctx.requirePerson` refuses a request carrying `X-DorkOS-Agent` with `403` and the extension-named copy, refuses a cross-site request, and admits a same-origin browser request; with login on it requires the session cookie; a route without it stays open (the seam is opt-in and does not change existing extensions).

### 7.7 Starting work in a new chat (V7, N12, D13)

An extension button names an outcome ("Sort them", "Set up flow here"). One click starts the work in a **new** chat; the current chat and its unsent text are untouched. No command is ever shown as the headline, and the click is the only confirmation.

**Server:** `ctx.sessions.start(input)` (§11.2) → `{ sessionId }`.

- `project`: any path inside a known project; core resolves it (boundary check, git repo required) and the new chat's cwd is the **project root**. A path outside every project is refused (`StartWorkError`, code `not_a_project`). The project must also be one `ctx.projects.list()` would return to this extension (it holds a copy of the extension, or the extension reported it); otherwise `not_a_project` too.
- `prompt` (≤ 20,000 characters): sent as the chat's first message at once, through `dispatchSessionMessage` (`apps/server/src/services/session/launch/launch-session.ts`) with a new origin kind `extension-start`, the default runtime and the new-session defaults (the "full power" defaults of `specs/full-power-defaults` apply unchanged; this seam does not change the permission mode).
- `title` (1 to 80 characters, plain words, e.g. "Sorting 12 new ideas in dorkos"): set at start through the runtime's `renameSession`, the same path `PATCH /api/sessions/:id` uses.
- `reason` (1 to 200 characters, e.g. "12 new ideas were waiting to be sorted"): stored in `startedBy`.
- **Eligibility (N6) applies** exactly as for any launch: the account ladder with the project (§8.4). A refusal throws `StartWorkError` with code `account_not_allowed_here` and the §8.3 message. Phase 2 ships this seam before phase 3's rules exist, so until phase 3 the refusal can never happen (every account is eligible); the code path and its type exist from phase 2 so flow handles it from the start.
- **Limits**, per extension, counted across `ctx` and `api` together: at most 10 starts per rolling hour and 3 of its started chats running a turn at once. Over a limit: `StartWorkError` code `start_limit` ("Flow has started a lot of chats in the last hour. Try again later."). Nothing is launched.
- **The counter survives a restart.** It is read from `session_started_by` (`created_at` within the last hour, `origin_extension_id` = this extension), not kept in memory. Concurrency is read from the live projector statuses of those sessions.
- **Chats started from a started chat count too.** When `session_start` runs inside a chat whose `startedBy` chain leads to an extension, the new chat's row records `origin_extension_id` = that extension, and it counts against that extension's limits. A `session_start` that would exceed them is refused with the same `start_limit` message. So an extension cannot escape its limit by asking its chats to start more chats.

**Client:** `api.startWork(input)` (§11.1) → `Promise<{ sessionId: string }>`. It calls `POST /api/extensions/:id/start-work`, scoped server-side to `:id` and behind `refuseIfNotAPerson`. Residual (invariant 9): the bar keeps agents out but cannot tell a person's click from the extension's own page code, so the start is recorded as the extension's (`startedBy.kind = 'extension'`), with or without a click. It does not navigate; the row turns into "Sorting 12 ideas… · Watch", and "Watch" opens `/session?session=<sessionId>` (the existing `sessionSearchSchema` key, `apps/client/src/layers/shared/lib/session-link.ts`) (V7). Server-started work (`ctx.sessions.start`) needs no person, because the extension's own rules (V10 stops) decided it, and it is recorded as such in history (§7.9).

**Origin, shown as the first line.** A new table `session_started_by` (`packages/db/src/schema/session/session-started-by.ts`; next numbered migration): `session_id TEXT PRIMARY KEY, kind TEXT NOT NULL ('extension' | 'chat'), extension_id TEXT NULL, started_by_session_id TEXT NULL, origin_extension_id TEXT NULL, reason TEXT NULL, created_at TEXT NOT NULL`, indexed on `(origin_extension_id, created_at)`. `origin_extension_id` is the extension at the root of the `startedBy` chain (itself for `kind = 'extension'`, inherited from the parent chat for `kind = 'chat'`). A third step in `session-origin-overlays.ts` (after room and task, since it sets a separate field) fills `Session.startedBy` (§11.4) on the session routes and the session-list broadcaster. The chat draws it as its first line, above the transcript, never sent to the model: "Started by Flow: 12 new ideas were waiting to be sorted", or "Started from <that chat's title>: <reason>" with a link to that chat. The prompt itself shows as the first message, collapsed to one line under that first line ("What it was asked ▸"), so it is readable but never the headline.

**`session_start` records it too.** `createSessionStartHandler` (`apps/server/src/services/runtimes/claude-code/mcp-tools/session-tools.ts`) writes `startedBy = { kind: 'chat', sessionId: <calling session>, reason }`, with a new optional `reason` argument (≤ 200), and inherits the calling chat's `origin_extension_id`. This is the "who started this chat" link that "Open its chat" rows rely on (with `ownChatSessionId`, §6.8).

**Tests** (`apps/server/src/services/extensions/__tests__/start-work.test.ts` and a route test): a start launches one chat in the project root with the title, the prompt as its first message and `startedBy` on the session list and the live stream; a path outside every project, an ineligible account, the hourly limit and the concurrency limit each refuse and launch nothing; `api.startWork` refuses an agent-headed request; `session_start` records the calling session. Browser (`apps/e2e/tests/extensions/start-work.spec.ts`): with the hello-world fixture's "Start a chat" button, one click opens nothing in the current chat, a new chat appears with the title and "Started by Hello: …" as its first line, and no slash command is visible as a headline.

### 7.8 "Next time, do this on its own" (V9)

After a person answers, **once**, the row may offer to skip the ask next time. The extension decides whether to offer and what it means; core only draws the line and carries the answer.

- The action result may carry `offer: { text, offerId }` (text ≤ 160, plain, e.g. "Shipped. Next time, ship on its own when the reviewer agent approves?"; `offerId` ≤ 64), and so may a later `resolve(key, { answering, offer })` (§7.3). Core stores it on the row (`offer_json`) and returns `{ text }` to the core UI that answered.
- That client shows it under the history row as a green line with "Yes" and a quiet dismiss. It shows once: it goes away when answered, dismissed, when the bell closes, or after 15 minutes, and it never shows on another device or in a push.
- "Yes" posts `POST /api/extension-decisions/:id/offer` `{ accept: true }` (person bar). This is a **core UI endpoint only**: no `ExtensionAPI` member reaches it, and the offer line is drawn only by core. Residual (invariant 9): same-page extension code could still `fetch` it; that is documented, not prevented. If the offer carries `settingsPatch: { project, patch }`, core first applies it itself to that extension's per-project settings (§7.10): a shallow merge of `patch` (a JSON object) into the stored value for that project root, validated like `api.projectSettings.set` (the project must be one `ctx.projects.list()` returns to the extension; the merged value ≤ 16 KiB), recorded with `updatedBy = 'person'` and an Activity entry. The patch lives only in that extension's own store, so it can only touch keys the extension owns. If the write fails, nothing else happens and the person sees "Couldn't change that. Try again.". Then core calls the same `onAction` handler a second time with `{ action: 'offer', offerId }`; the handler's `message` becomes a toast ("Done. Change it any time in Flow settings."). Dismiss posts `{ accept: false }` and calls nothing. Either way `offer_used_at` is set and a second post answers `409 offer_gone`.
- Only answers attributed to a person get offers (core UI answers, or a `resolve` with a valid `answering`); a deadline, delegated or extension-path resolution never does.
- For extension approvals, core makes its own offer (§9.3).

### 7.9 Who decided, and "While you were away" (V10, N11)

Every resolved decision records who settled it, so history can say so:

| `resolved_by` | Meaning                                                               | History says                                             |
| ------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `person`      | A person answered (inbox or an extension page)                        | "… · you at 2:14pm"                                      |
| `deadline`    | Core applied `defaultChoice` at `decideBy`                            | "… · decided by the agent at 5pm"                        |
| `agent`       | The extension let an agent it trusts decide (e.g. the reviewer agent) | "… · <label> at 3:10pm" ("the reviewer agent")           |
| `rule`        | The extension decided by a setting the person chose (e.g. a V10 stop) | "… · <label> at 3:10pm" ("your 'Tell me after' setting") |
| `extension`   | The extension withdrew or cleared it (`cleared`, `cancelled`)         | "Resolved on its own" / "No longer needed"               |

- `ctx.inbox.resolve(key, { outcome, by? })` takes an optional `by`: `{ kind: 'agent' | 'rule'; label }`, or `{ kind: 'deadline' }` when the extension applied its own default at its own deadline (e.g. after a `keepOpen`); that renders with core's wording "decided by the agent at <time>" and records `resolved_by = 'deadline'`. Absent means `extension`.
- **Decisions that were never asked.** At "Tell me after" or "Just do it", the extension decides without asking. `ctx.inbox.record(input)` writes a **history-only** row (`recorded = 1`, resolved at birth; `why` required; `by` required): never in "Needs you", never a push. `tell` decides how loud it is:
  - `tell: true` ("Tell me after"): the row is **unread** in Activity (it counts in the bell's unread count when nothing is waiting, and has an unread dot) until seen.
  - `tell: false` or absent ("Just do it"): quiet history, written already read.
- **"While you were away".** In Activity (`features/inbox/lib/group-activity-rows.ts`), three or more consecutive `extension.decision` history rows whose `resolved_by` is not `person` fold into one group row "While you were away · 5" (`extension.decision` joins `GROUPABLE_KINDS` for these rows only), which expands to the rows. The group shows an unread dot while any `tell: true` row inside it is unread. These rows are history, never asks.
- This layer is separate from the in-chat tool-approval posture of `specs/full-power-defaults`: that spec's attended/unattended copy ("still asks when it matters") stays as it is, and nothing here changes how a chat's tool calls are approved.

### 7.10 Per-project settings only a person writes (for the autonomy dial)

Flow's autonomy dial (V10) must not be something its own server half, an agent, or a commit to the repo can turn to "Just do it". So flow moves the dial out of the repo's `config.local.json` into a core-held store.

- **Storage.** Per extension and project root: `{dorkHome}/extension-data/<id>/project-settings/<sha256(root)>.json`, beside `ctx.storage`'s `data.json` (`extension-server-api-factory.ts`), holding `{ root, value, updatedAt, updatedBy }`. `value` is any JSON, at most 16 KiB; the extension validates it on read.
- **Read:** `ctx.projectSettings.get(root)` and `onChange(listener)` on the server; `api.projectSettings.get(root)` in the browser.
- **Write: only** `PUT /api/extensions/:id/project-settings` `{ project, value }` behind `refuseIfNotAPerson`, called by `api.projectSettings.set(root, value)`. There is **no** server-side setter: the extension's server half, and so any agent it runs, cannot move the dial. Each write records an Activity entry ("Flow settings for dorkos changed"). Residual (invariant 9): the bar keeps agents out but not same-page extension code; `updatedBy` is recorded as `extension-page`.
- **Login state for the copy (N11, invariant 15).** `ExtensionReadableState` gains `requireLogin: boolean` (the server's `auth.enabled`). When it is false, the dial shows one line under it: "Anyone on this computer can change this. Turn on Require login so only you can." Flow draws it; core supplies the state and this copy in the authoring guide.
- **Tests:** an agent-headed `PUT` and a server-half attempt (no setter exists; a type test) both fail; a person write lands and fires `onChange`; values over 16 KiB are refused; roots containing dots round-trip.

## 8. Phase 3: account eligibility (N6)

### 8.1 Config

`packages/shared/src/config-schema.ts`:

```ts
// ClaudeCodeAccountSchema gains:
onlyProjects: z.array(z.string().min(1)).nullable().default(null),   // project roots; null = any project
// ClaudeCodeSettingsSchema gains:
projectAccounts: z.record(z.string().min(1), z.object({ allow: z.array(z.string().min(1)) })).default({}),
// Main (id "default") takes part through:
defaultAccountOnlyProjects: z.array(z.string().min(1)).nullable().default(null),
```

**Decided in spec:** Main has no registry row (`IMPLICIT_ACCOUNT_ID`, `packages/shared/src/account-identity.ts`), so its account-side rule lives in `runtimes.claudeCode.defaultAccountOnlyProjects`, the same pattern as `defaultAccountColor`. `projectAccounts[root].allow` lists account ids and may include `default`.

Roots are stored canonical (`canonicalDirectory`). Lifecycle per `contributing/configuration.md`:

- Migration under the next free key after phase 1's (`0.93.0` if phase 1 took `0.92.0`), seeding `projectAccounts = {}` and `defaultAccountOnlyProjects = null` when absent and `onlyProjects = null` on each existing row that lacks it (rows edited by id so every other member survives, as `seedDefaultAccountColor` does). Pinned in `merged-migration-hashes.ts`. A real-file `ConfigManager` test that reads `config.json` itself.
- `CONFIG_WRITE_POLICY`: all three `operator-only` (they bound where a credential may be used).
- `CONFIG_DISCLOSURE`: `withhold` (they name local folders; agents do not need them).
- `default-verdicts.ts`: `no-risk` (the defaults are today's behaviour).
- `PROTECTIVE_CARRYOVERS`: a rule for all three. A wipe that forgot "work account only for client-app" would silently let it into personal repos, which is exactly the DOR-584 class.
- `describeClaudeCodeAccounts` (`claude-config-dir.ts`) and `ServerConfigSchema` add `onlyProjects: ProjectRef[] | null` per account so Settings can draw names.
- `account-reference-move.ts`: a renamed account id is rewritten inside every `projectAccounts[*].allow` too.
- Readers treat absence as the default (the launch path reads raw JSON).
- **Never write `projectAccounts` through a dotted key path.** Its keys are absolute paths, which contain dots (`/Users/x/client.app`), and `conf`'s `set('a.b.c')` splits on dots. Every write reads the whole `runtimes.claudeCode.projectAccounts` object, changes one entry and writes the whole object back (`configManager.set('runtimes', ...)` at the `runtimes.claudeCode` level, as `planClaudeAccountWrite` does for accounts). The migration does the same. A test writes a root containing a dot and reads `config.json` back.

### 8.2 The rule

`apps/server/src/services/core/usage/account-eligibility.ts`:

```ts
export type Ineligible =
  | { reason: 'only-projects'; allowedProjects: ProjectRef[] } // the account's own rule
  | { reason: 'project-allowlist'; project: ProjectRef }; // the project's rule

/** Whether an account may serve work in a project. `project` null = no project. */
export function accountEligibility(
  config: ConfigReader,
  runtime: 'claude-code',
  accountId: string,
  project: ProjectRef | null
): { eligible: true } | ({ eligible: false } & Ineligible);

/** The eligible subset of `accountIds`, order kept. */
export function eligibleAccountIds(
  config,
  runtime,
  accountIds: readonly string[],
  project: ProjectRef | null
): string[];
```

- An account is eligible only if **both** rules allow it (N6).
- Account side: `onlyProjects` null allows any project. A non-null list allows only those roots, and **never "no project"** (a work account restricted to client-app does not run in `~/scratch`).
- Project side: no `projectAccounts` entry allows every account. An entry allows exactly its `allow` list. "No project" has no project side.
- The cwd → project step always goes through `projectRegistry.resolve`. An empty or unknown cwd (several callers pass `''` today) is "no project".

### 8.3 The refusal

```ts
export class AccountNotAllowedError extends Error {
  code = 'account_not_allowed_here';
  constructor(readonly project: ProjectRef | null, readonly accountId: string | null, readonly detail: Ineligible | { reason: 'none-eligible' });
}
```

HTTP `409 { code: 'account_not_allowed_here', message, project, accountId }`. Copy (writing-for-humans):

- Named account: "Work can't be used in dorkos. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes."
- Project allowlist: "dorkos isn't set to use Work. Pick another account, or change which accounts dorkos may use."
- Nothing eligible: "No account is allowed to work in dorkos. Choose which accounts it may use in Settings → Runtimes."
- No project: "Work is set to work only in client-app, and this folder isn't in a project. Pick another account."

The link target is `/?settings=runtimes` (the existing deep link). It never falls back to an ineligible account (invariant 6).

### 8.4 Every pick site

| Site                                | File                                                                                                                                                                       | Today                                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch ladder                       | `apps/server/src/services/runtimes/claude-code/claude-config-dir.ts` `resolveLaunchAccountRoot`                                                                            | `(opts: { hintId?, agentAccountId?, config? }) => string`; unknown ids fall through | Gains `project: ProjectRef \| null` and returns `{ ok: true; root; accountId } \| { ok: false; error: AccountNotAllowedError }`. Rungs 1-2 (`hintId`, agent manifest `account`): a named account that is ineligible **refuses** (it does not fall through; running elsewhere silently is a surprise). Rungs 3-4 (`defaultAccount`, then the env / `~/.claude` root, which counts as `default` when it matches no row): if ineligible, pick the first eligible account in `rankAccounts` order (**Decided in spec**: the implicit default is an automatic choice, so choosing the next eligible account is the right automatic behaviour); none eligible refuses. |
| Launch resolver                     | `.../claude-code/messaging/launch-resolver.ts`                                                                                                                             | `session.accountRoot ?? resolveLaunchAccountRoot(...)`                              | Passes the session's project; a refusal becomes a session error with the message. An existing session keeps its account (no re-check mid-session; the rule applies when an account is picked).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Prediction                          | `.../claude-code/claude-code-runtime.ts` `accountRootForSession`                                                                                                           | predicts via the ladder                                                             | Passes the project; a refusal predicts `null` (feeds `billingAccountFor` and `resolve-session-account.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| First message with a picked account | `apps/server/src/services/session/launch/launch-session.ts` `dispatchSessionMessage` (from `POST /api/sessions/:id/messages`)                                              | never validated                                                                     | Checks eligibility **before** the 202 and answers `409 account_not_allowed_here`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Ranking                             | `apps/server/src/services/core/usage/account-ranking.ts` `rankAccounts`, `candidatesOf`, `defaultRanking`, `advisedRanking`                                                | all routable accounts                                                               | `candidatesOf(runtime, project)` filters to eligible accounts before anyone ranks, so the advisor only ever sees eligible candidates, and core filters the advisor's answer again through `validateAdvisorRanking`'s `isKnown`. `AdvisorContext.cwd` is resolved to a project once.                                                                                                                                                                                                                                                                                                                                                                              |
| Launch check                        | same file, `checkAccountLaunch`                                                                                                                                            | advisor-driven                                                                      | Refuses an ineligible account first, with the eligibility message, before asking the advisor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Continue (person)                   | `apps/server/src/services/session/fleet/continue-service.ts` `continueSession`, routes in `apps/server/src/routes/session-continue.ts` (`POST /api/sessions/:id/continue`) | same-runtime picks checked only for "registered, not the spent one"                 | Also eligibility (D7). `continueOptions` (`GET /:id/continue-options`) marks ineligible accounts `eligible: false` with the reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Carry-over                          | `.../fleet/carry-over.ts` `carryOverSession`                                                                                                                               | trusts callers                                                                      | Asserts eligibility of `targetAccountId` (defence in depth; throws `AccountNotAllowedError`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Advisor plans                       | `.../fleet/limit-plans.ts` `planEpisode`, `rankForLimit`, `isRegisteredAccount`                                                                                            | `auto` targets checked only for registration                                        | An `auto` target must be eligible or the plan degrades to `ask`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Automatic handoff timer             | `.../fleet/auto-handoff.ts` `fireAutoHandoff`, `targetStillEligible`                                                                                                       | re-ranks                                                                            | Unchanged in shape: it re-ranks through `rankAccounts`, which now filters. Covered by a test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Wait                                | `POST /api/sessions/:id/wait` (`waitForReset`)                                                                                                                             | picks nothing                                                                       | No change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Schedules, direct                   | `apps/server/src/services/tasks/execution/resolve-run-execution.ts` (`accountHint`), `task-scheduler-service.ts`                                                           | hint reaches the ladder unchecked                                                   | The ladder refuses; the run fails with the message as its reason. `reportUnregisteredAccount` gains a sibling `reportIneligibleAccount`, which warns when a schedule is saved or edited with an account its folder can't use.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Schedules, over relay               | `apps/server/src/services/tasks/relay-dispatch.ts` `dispatchRunViaRelay`; receiver `packages/relay/src/adapters/claude-code/task-handler.ts`                               | `payload.account` → `accountHint` unchecked                                         | Same ladder refusal on the receiving side; the run reports it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Agent-proposed schedules            | `apps/server/src/services/runtimes/claude-code/mcp-tools/task-tools.ts`                                                                                                    | account approved with the schedule                                                  | Refuses at proposal time when the account can't serve that folder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Relay messages                      | `apps/server/src/services/relay/turn-execution-settings.ts` `allowedRelayAccount`                                                                                          | refusal falls back to the ladder                                                    | Unchanged fallback, now safe: the ladder's default rungs pick only eligible accounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session_start` MCP tool            | `apps/server/src/services/runtimes/claude-code/mcp-tools/session-tools.ts` `createSessionStartHandler`                                                                     | named account → `checkAccountLaunch`; unnamed → ladder                              | Both paths now enforce (the unnamed path through the ladder). Refusal is `ACCOUNT_REFUSED` with the message. The external `/mcp` projection (`services/core/external-mcp/session-tools.ts`) shares it.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Starting work from an extension     | `ctx.sessions.start`, `POST /api/extensions/:id/start-work` (§7.7)                                                                                                         | new                                                                                 | Goes through the ladder with the project; a refusal is `StartWorkError` `account_not_allowed_here`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Status-bar picker                   | `apps/client/src/layers/features/status/model/use-account-switch.ts`                                                                                                       | lists all                                                                           | Draws ineligible accounts disabled with "Only for client-app" or "Not used in dorkos".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Continue picker                     | `apps/client/src/layers/features/continue-on-account/ui/ContinueOnAccountDialog.tsx`                                                                                       | lists offered accounts                                                              | Disabled rows with the same reason line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Warmup and probe roots (`claude-code-runtime.ts` warmup, `messaging/runtime-cache.ts`) pick nothing that spends and are out of scope. Resume (`apps/server/src/services/session/fleet/resume-service.ts`) stays on the same account.

### 8.5 Settings → Runtimes (V6 core half)

`apps/client/src/layers/features/settings/ui/runtimes/sections/ClaudeAccountsSection.tsx` `AccountRow`:

- When `onlyProjects` is non-null, the row shows a muted line "Only for client-app" (names joined: "Only for client-app and client-api").
- The row's menu gains "Limit to projects…", a small dialog listing `GET /api/projects` with checkboxes; saving calls §8.6's `PUT`. "Any project" clears it.
- When `projectAccounts` has entries, a quiet "Project limits" list under the accounts shows each project and its allowed accounts with a "Remove" action. **Decided in spec:** this keeps the app complete without the flow extension installed; a person can always see and undo a project rule from core.

### 8.6 The API flow uses (V6 checkboxes and the `fleet.json` handshake)

In `apps/server/src/routes/runtimes.ts`:

| Route                                                              | Bar                  | Body                                           | Result                                                                                                                 |
| ------------------------------------------------------------------ | -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /api/runtimes/claude-code/account-eligibility?project=<path>` | normal               | none                                           | `{ project: ProjectRef \| null, allow: string[] \| null, accounts: AccountEligibilityRow[] }`                          |
| `PUT /api/runtimes/claude-code/project-accounts`                   | `refuseIfNotAPerson` | `{ project: string; allow: string[] \| null }` | `200` with the new `account-eligibility` body; `null` removes the entry; `400` unknown account id; `404` not a project |
| `PUT /api/runtimes/claude-code/accounts/:id/only-projects`         | `refuseIfNotAPerson` | `{ projects: string[] \| null }`               | `200 { onlyProjects: ProjectRef[] \| null }`; `:id` may be `default`; `400` a path that is not a project               |

`AccountEligibilityRow` = `{ id, label, color, implicit, onlyProjects: ProjectRef[] | null, allowedByAccount: boolean, allowedByProject: boolean, eligible: boolean }`.

**Auth bar.** The person bar (the same one that guards approving an extension, with its residuals, invariant 9) and nothing on `ctx`: flow's V6 checkboxes run in the browser as the person, so they pass; flow's server half and any agent cannot widen account access (invariant 9). Each write records an Activity entry (`eventType: 'config.accounts_updated'`) naming who and what.

**`fleet.json` handshake (D6).** Core offers the two `PUT`s and `GET /api/projects` (with `originRepo`). The migration runs in flow's **browser half**, when a person opens Settings → Flow: flow reads its own kept-out accounts' `scope.repos` (`owner/name`) through its own read route, maps each to the known projects whose `originRepo` matches case-insensitively, writes `onlyProjects` through `PUT .../only-projects` as that person, and shows what moved (and any repo it could not match, which is kept in `fleet.json` and never dropped silently). Flow records its own "migrated" marker; core keeps no state about the migration. No `ctx` member can do this write, and flow's server half never attempts it. "Kept out" itself stays flow's role (N6).

### 8.7 Fleet contract fixtures

Phase 3 re-vendors flow's fleet contract **4.1.0** into `packages/shared/src/__fixtures__/flow-fleet-conformance/` (today at 4.0.1; update `CONTRACT_VERSION`, `SOURCE.json`, `VENDORED.md` by the existing procedure). Flow's 4.1.0 `eligibility.cases.json` carries project cases for `onlyProjects` and `projectAccounts`; `apps/server/src/services/core/usage/__tests__/fleet-conformance.test.ts` runs those cases against core's `accountEligibility`, so flow's CLI (`mayServe`) and core cannot disagree. Two case groups are added upstream in flow and vendored here: Main (`default`) restricted through `defaultAccountOnlyProjects`, and path canonicalization (a trailing slash, a symlinked root, and a worktree path all resolve to the same project). The `dispatchedBy` case in `flow-run.cases.json` (§6.8) rides the same vendoring.

## 9. Phase 4: extensions across many projects (N5, D9)

### 9.1 Trusted origin

```ts
/** Where a copy came from, when this machine can prove it. */
export interface ExtensionOrigin {
  plugin: string;
  source: string;
}
export function trustedOriginOf(
  copy: DiscoveredRecord,
  installs: ProjectInstallRecord[]
): ExtensionOrigin | null;
```

- A plugin-carried copy under `{dorkHome}/plugins/<p>/` (written only by DorkOS): origin from its install metadata's `sourceRepo` **only**, normalized to `owner/repo` (a `github.com` https or ssh URL is reduced to `owner/repo`, lowercased; anything else, or a missing `sourceRepo`, gives no trusted origin). `installedFrom` is never used: it is a marketplace name the person chose, not a proven source.
- A plugin-carried copy under `<project>/.dork/plugins/<p>/`: trusted **only** when `project-installs.json` holds a record for that exact `installRoot`. `ProjectInstallRecord` (`apps/server/src/services/marketplace/lib/project-install-index.ts`) gains `source?: string`, the installer's resolved `sourceRepo` normalized to `owner/repo` by the same rule (absent when there is none). **Decided in spec: no backfill.** Existing records lack `source`, and the only place to backfill it from is the install's own `.dork/install-metadata.json`, which lives inside the repo and can be edited by anyone who can commit there; trusting it once would defeat the point. So a copy gains a trusted origin on its next install or update through DorkOS, and until then it stays path-approved exactly as today. In practice the operator's four flow copies collapse to one after each has been updated once, which flow's own update flow already prompts.
- Anything else (a directly placed extension, a plugin committed into a repo someone cloned): `null`. Such a copy is approved only by path, exactly as today.

`extensions.approvedSources[id]` (`ExtensionApprovedSourceSchema`) gains `origin?: { plugin: string; source: string }`, set by `approveToRun` when the approved copy has a trusted origin. `isApprovedCopy` becomes: approved id, and (path and plugin match **or** the copy's trusted origin equals the stored origin). Config: the field is optional, so no migration; operator-only like its parent.

### 9.2 Discovery

`ExtensionDiscovery.discover(cwd, config, core)` (`apps/server/src/services/extensions/extension-discovery.ts`) gains `projects: readonly string[]` (the registry's `seen` roots, never `reported`-only ones (§6.1), plus the resolved project of `cwd`). For each root, it scans `<root>/.dork/extensions` (local) and `<root>/.dork/plugins/<p>/.dork/extensions` (local, plugin-carried), deduplicating roots and skipping one that resolves to the dork home (the existing `isSameDirectory` check). `ExtensionManager` refreshes discovery on `projectRegistry.onChange` (debounced 2s) as well as on `cwd-changed`.

Precedence per id (first match wins; rows 1-3 are today's order, unchanged):

| #   | Candidate                                                                                         | Rule                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Core extension                                                                                    | Always wins; other copies are ignored with today's warning.                                                                                                                                 |
| 2   | Installed directly (`{dorkHome}/extensions/<id>`, then the cwd project's `.dork/extensions/<id>`) | Today's rule, including "a project copy is dropped when its id is approved for another copy". A direct copy in any other known project counts as a project copy with the same rule.         |
| 3   | Plugin-carried copies approved **by path**                                                        | Today's rule: the approved copy wins.                                                                                                                                                       |
| 4   | Plugin-carried copies whose **trusted origin equals the approved origin**                         | New. Among them, the **highest manifest version** wins (semver; a tie goes to global before project, then sorted root, then sorted plugin name). No re-approval: same approved source (N3). |
| 5   | Other plugin-carried copies                                                                       | Today's rule: global before project, sorted plugin name; with multi-project scan, then sorted project root. It runs only after a person approves it.                                        |

One warning per id lists every copy found and which one won, as today.

**Edge cases:**

- **One repo has an older flow.** Row 4 picks the newest; the older copy is listed in `GET /api/extensions` with a new informational field `shadowedBy: string | null` (the winning copy's path; not a new `ExtensionStatus`), so flow can say "runs an older flow, update" (N5).
- **A cloned repo carries a flow copy with a higher version and a claimed origin.** No install record on this machine means no trusted origin, so row 4 ignores it; at most it is a row-5 candidate that must be approved by path, and only if nothing in rows 1-4 exists.
- **The newest trusted copy is deleted.** The next discovery falls back to the next highest trusted copy with no prompt.
- **A known project's folder is gone.** Skipped silently; the registry keeps the root (§6.1).
- **Different sources, same id.** Unchanged: rows 3 and 5, today's warning, and approval stays source-bound.
- **The server's working folder changes.** The chosen copy no longer changes with it (the cwd project is just one of the scanned roots). `POST /api/extensions/cwd-changed` still triggers a rescan so a newly opened project is picked up at once.
- **Server half.** One loaded copy serves every project; its `ctx` is not per project. Per-project behaviour is the extension's (`ctx.projects`).

### 9.3 Trusted sources (V9, N11, D14)

Trusting code from a source not yet trusted is one of the three asks only a person can answer (N11), and it is asked **once per source**.

- **Config:** `extensions.trustedSources: z.array(z.object({ source: z.string().min(1), trustedAt: z.string() })).default([])` in `packages/shared/src/config-schema.ts`. `source` is a trusted origin's normalized `owner/repo` (§9.1), e.g. `dork-labs/marketplace`. Lifecycle per `contributing/configuration.md`: a migration under the next free key at merge time seeding `[]` when absent (guarded by `store.has`, pinned in `merged-migration-hashes.ts`); `CONFIG_WRITE_POLICY` `operator-only` (it decides which code runs); `CONFIG_DISCLOSURE` `withhold`; `default-verdicts.ts` `safe` (it starts empty); no protective carry-over (a wipe empties it, which is stricter). A real-file `ConfigManager` test.
- **Effect:** `mayRunExtensionCode(copy)` (`extension-load-policy.ts`) is also true when the copy's **trusted origin** has a `source` in `trustedSources`. Such a copy never produces an `extension.approval` row. A copy without a trusted origin is never covered, whatever its files claim.
- **The offer (V9).** After a person turns on an extension whose copy has a trusted origin not yet trusted, the history row shows once: "Next time, trust everything from dork-labs/marketplace? [Yes]". (The design's example says "dork-labs"; core names the exact `owner/repo` it will trust, because trusting an owner's every repository is broader than what was proven.) "Yes" calls `POST /api/extensions/trusted-sources` `{ source }` (person bar). Same once-only rules as §7.8. Like the offer endpoint, this is reachable only from core-drawn UI (the bell's offer line and Settings → Extensions), never through an `ExtensionAPI` member; residual (invariant 9): same-page extension code could `fetch` it, which is documented, not prevented.
- **Settings → Extensions** gains a "Trusted sources" list (source, when trusted, "Stop trusting"). "Stop trusting" calls `DELETE /api/extensions/trusted-sources` `{ source }` (person bar); extensions already turned on stay on (their own approval stands), and new copies from that source ask again.
- **Tests:** a trusted source's new extension runs with no approval row; a clone claiming that source without an install record still asks; the offer appears once and only after a person approves; "Stop trusting" makes the next new copy ask; both routes refuse an agent-headed request.

## 10. Extension API surface, docs and conformance

Every seam lands with:

1. TSDoc on every exported type and member in `packages/extension-api` (Hard Rule 4).
2. A section in `contributing/extension-authoring.md`: "API Reference" (UI Registration gains `registerPage`, `registerStatusBarItem`; UI Control gains `setTabMarker`; State gains `currentProject`), "UI Slots" (`status-bar`, pages), and "Server-Side Data Providers" (`ctx.inbox`, `ctx.projects`), each with a short example. `docs/integrations/extensions.mdx`'s overview paragraph lists the new members.
3. A use in a fixture. `apps/server/src/core-extensions/hello-world/` gains a page (`registerPage('', ...)`, title "Hello"), a status-bar item visible only when the session has a cwd, a tab marker toggled by its command, and a "Start a chat" button on its page that calls `api.startWork` (it stays `defaultEnabled: false`). A server fixture extension `apps/server/src/services/extensions/__tests__/fixtures/inbox-fixture/` raises, updates and resolves a decision, answers an action, makes an offer, raises a question with a near deadline, records a history-only decision, and starts a chat.
4. A conformance-style test. `apps/server/src/services/extensions/__tests__/extension-seams.conformance.test.ts` drives the real `createDataProviderContext` with two fixture extensions and asserts: namespacing (B cannot resolve A's key), dedupe (two raises, one open row), `cleared` writes one history row, the handler timeout keeps the row, limits throw, `ctx.projects.resolve` of a worktree returns its main checkout. The client twin `apps/client/src/layers/features/extensions/__tests__/extension-seams.test.tsx` asserts `registerPage` routes and lists, `navigate` reaches the router, `setTabMarker` draws the dot and changes the accessible name, `registerStatusBarItem`'s `when` promotes the item and a throwing `when` hides it, and `currentProject` updates on cwd change. `extension-test-harness.ts` (the MCP `test_extension` mock) counts the new registrations.
5. **A shared type contract (cross-repo drift guard).** `@dorkos/extension-api` is not published, so flow mirrors host types in `lib/host-types.ts`. Core adds `packages/extension-api/src/__fixtures__/seam-contract/` with `seams.contract.ts` (the §11.1 and §11.2 declarations exactly, types only), `CONTRACT_VERSION` (semver; starts at `1.0.0`, minor for an added member, major for a removal or a narrowing), and `README.md` with the vendoring procedure, mirroring `flow-fleet-conformance`. A type test in core (`packages/extension-api/src/__tests__/seam-contract.test.ts`, `expectTypeOf` both ways) fails if the real `ExtensionAPI` / `DataProviderContext` stop being assignable to and from the fixture's declarations. Flow vendors the same file and runs the same assertion against `host-types.ts`, so a drift fails in whichever repo moved. Each phase bumps the fixture in the PR that adds the members.
6. **Feature detection, not version checks.** An extension tells whether a seam exists by probing it: `typeof api.registerPage === 'function'`, `api.isSlotAvailable('status-bar')`, `typeof api.setTabMarker === 'function'`, `'currentProject' in api.getState()`, `ctx.inbox !== undefined`, `ctx.projects !== undefined`, `typeof ctx.requirePerson === 'function'`, `ctx.sessions !== undefined`, `typeof api.startWork === 'function'`. The authoring guide documents this pattern; it lets one flow build run on hosts from before and after each phase.

## 11. Contracts consumed by the flow spec

The marketplace spec builds against exactly these names and shapes. `@dorkos/extension-api` is not published to npm, so flow mirrors them in `lib/host-types.ts`, checked against the vendored seam contract (§10.5). Flow detects each seam by probing for it (§10.6) rather than by raising `minHostVersion`, so one flow build works on hosts with and without a given phase.

### 11.1 Client (`@dorkos/extension-api`)

```ts
/** A project as core knows it: a git main checkout. */
export interface ProjectRef {
  /** Absolute, canonical path of the main checkout. */
  readonly root: string;
  /**
   * Short display name: URL-safe, unique among known projects, and stable once
   * assigned (basename, or "basename~parent" on a clash). Safe in URLs as-is.
   */
  readonly name: string;
}

export interface ExtensionReadableState {
  currentCwd: string | null;
  activeSessionId: string | null;
  agentId: string | null;
  /** The project of `currentCwd`; null for no project or while resolving. */
  currentProject: ProjectRef | null;
  /**
   * Whether Require login is on (`auth.enabled`). When false, anyone on this
   * computer can pass the person bar; autonomy UI should say so (§7.10).
   */
  requireLogin: boolean;
}

export type ExtensionPointId =
  | 'sidebar.footer'
  | 'dashboard.sections'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'right-panel'
  | 'status-bar';

/** Props every extension page receives. */
export interface ExtensionPageProps {
  /** Values of the page path's `:param` segments. */
  readonly params: Readonly<Record<string, string>>;
  /** The URL's query, flat. */
  readonly search: Readonly<Record<string, string>>;
  /** Replace query keys; null removes a key. Writes the URL (bookmarkable). */
  setSearch(next: Record<string, string | null>): void;
}

export interface ExtensionPageOptions {
  /** Title for the page bar, tab, palette and phone menu, e.g. "Flow". */
  title: string;
  icon?: ComponentType<{ className?: string }>;
  /** List it in the command palette and phone "Add-ons" menu. Default true; param paths are never listed. */
  menu?: boolean;
}

/** One tracker item a chat is working on, newest first in lists. */
export interface TrackerItemRef {
  readonly id: string;
  readonly stage: string | null;
  readonly runStatus: string | null;
  readonly startedAt: string;
  /** 'this-chat': this chat works on it. 'own-chat': this chat started it and it runs in its own chat. */
  readonly via: 'this-chat' | 'own-chat';
  /** That chat's session id: the "Open its chat" target. Null for 'this-chat', or when it is not a DorkOS chat. */
  readonly ownChatSessionId: string | null;
}

/** What a status-bar item is given, for the chat whose status bar it sits in. */
export interface StatusBarSlotContext {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly project: ProjectRef | null;
  readonly trackerItems: readonly TrackerItemRef[];
  /** True at phone width: draw the short form. */
  readonly compact: boolean;
}

export interface StatusBarItemOptions {
  /** Accessible name of the item's region. */
  label: string;
  /** Order among extension items; lower first. Default 100. */
  priority?: number;
  /**
   * Whether to show for this chat. Default: always. Pure and synchronous: read
   * only `ctx`, never fetch, read extension state or subscribe. It runs in the
   * status bar's budget pass; a throw hides the item.
   */
  when?(ctx: StatusBarSlotContext): boolean;
  /** Whether it needs attention (raises its budget priority). Same rules as `when`. */
  urgent?(ctx: StatusBarSlotContext): boolean;
}

export interface ExtensionAPI {
  // ...existing members...
  /** Mount a full page at /x/<extensionId>/<path>. `path` is '' or segments with ':param'. */
  registerPage(
    path: string,
    component: ComponentType<ExtensionPageProps>,
    options: ExtensionPageOptions
  ): () => void;
  /** Add an item to the chat status bar, beside the runtime and account chips. */
  registerStatusBarItem(
    id: string,
    component: ComponentType<StatusBarSlotContext>,
    options: StatusBarItemOptions
  ): () => void;
  /** Mark one of this extension's right-panel tabs. Core draws the dot; null clears it. */
  setTabMarker(tabId: string, marker: 'attention' | null): void;
  /** Navigate in-app. Accepts core routes and '/x/<id>/<path>[?query]'. */
  navigate(path: string): void;
  /**
   * Answer one of THIS extension's inbox decisions from its own page. Scoped
   * server-side to this extension's id (another extension's row is 404).
   * Attributed to the extension ("answered in Flow"), never to a person, and
   * never returns an offer. Behind the person bar, with its residuals.
   */
  answerDecision(decisionId: string, answer: DecisionAnswer): Promise<DecisionAnswerResult>;
  /** This extension's open decisions (scoped to its id), as the inbox shows them. */
  listDecisions(): Promise<ExtensionDecisionView[]>;
  /**
   * Start work in a NEW chat (scoped to this extension; behind the person bar).
   * Never touches the current chat. Recorded as started by the extension.
   * Throws StartWorkError on refusal.
   */
  startWork(input: StartWorkInput): Promise<{ sessionId: string }>;
  /** Per-project settings core holds for this extension (§7.10). */
  projectSettings: {
    get<T = unknown>(projectRoot: string): Promise<T | null>;
    /** The only writer; behind the person bar. Value is JSON, ≤ 16 KiB. */
    set(projectRoot: string, value: unknown): Promise<void>;
  };
}

/** Shared by api.startWork and ctx.sessions.start. */
export interface StartWorkInput {
  /** Any path inside a known project; the chat runs in the project root. */
  project: string;
  /** Sent at once as the first message (≤ 20,000). Never shown as the headline. */
  prompt: string;
  /** The chat's title, plain words (1-80), e.g. "Sorting 12 new ideas in dorkos". */
  title: string;
  /** Why it was started (1-200), shown as the chat's first line: "Started by Flow: <reason>". */
  reason: string;
}

/** Codes: 'not_a_project' | 'account_not_allowed_here' | 'start_limit'. `message` is plain words. */
export class StartWorkError extends Error {
  readonly code: 'not_a_project' | 'account_not_allowed_here' | 'start_limit';
}

export type DecisionAnswer =
  | { action: 'approve' }
  | { action: 'reject'; note?: string } // ≤ 2000
  | { action: 'word'; text?: string } // ≤ the action's input.maxLength
  | { action: 'choice'; choiceId?: string; text?: string }; // a chip, or "Reply…" text (≤ 2000)

export interface DecisionAnswerResult {
  readonly resolved: boolean;
  readonly message: string | null;
  /** A validated in-app path the host already navigated to, or null. */
  readonly navigate: string | null;
  /** "Sorting 12 ideas… · Watch", when the handler returned one. */
  readonly watch: { sessionId: string; label: string } | null;
}

/** One open decision as the client sees it (the ExtensionDecisionDTO, scoped to the caller). */
export interface ExtensionDecisionView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly detail: string | null;
  readonly project: ProjectRef | null;
  readonly projectLabel: string | null;
  readonly since: string | null;
  readonly actions: DecisionActions;
  readonly link: string | null;
  readonly raisedAt: string;
}
```

Routes: the extension home is `/x/<extensionId>` (flow: `/x/flow`); `/x/flow/p/<name>` is flow's to register as `'p/:name'`; `?project=<name>` is carried in `search`.

### 11.2 Server (`@dorkos/extension-api/server`)

```ts
export interface DataProviderContext {
  // ...existing members...
  inbox: InboxApi;
  projects: ProjectsApi;
  /**
   * Express middleware that admits only a person (the same bar as approving an
   * extension, including its login-off residual). Put it in front of every
   * route that changes state on a person's behalf.
   */
  requirePerson: import('express').RequestHandler;
  sessions: SessionsApi;
  /** Read-only view of the per-project settings a person writes through api.projectSettings.set (§7.10). No setter exists here. */
  projectSettings: {
    get<T = unknown>(projectRoot: string): Promise<T | null>;
    onChange(listener: (projectRoot: string) => void): () => void;
  };
}

export interface SessionsApi {
  /**
   * Start work in a new chat in a project, decided by the extension's own rules
   * (no person needed). Same input, limits, eligibility and StartWorkError as
   * the client's api.startWork. The project must hold a copy of this extension
   * or have been reported by it. Limits are restart-safe and include chats
   * started from its started chats. Records startedBy { kind: 'extension' }.
   * Eligibility refusals begin with phase 3.
   */
  start(input: StartWorkInput): Promise<{ sessionId: string }>;
}

export interface ProjectInfo extends ProjectRef {
  /** "owner/name" from the origin remote, or null. */
  readonly originRepo: string | null;
  readonly lastSeenAt: string;
}

export interface ProjectsApi {
  /** The project a folder belongs to (worktrees and subfolders map to their main checkout). */
  resolve(cwd: string): Promise<ProjectRef | null>;
  /**
   * Known projects whose folder exists and that either hold a copy of this
   * extension or were reported by it, by name.
   */
  list(): Promise<ProjectInfo[]>;
  /**
   * Tell core about a project it may not have seen. Boundary-checked; must be
   * inside a git repo, else null. Reported-only roots are never scanned for
   * extensions. Carries no label.
   */
  report(path: string): Promise<ProjectRef | null>;
  /** Called when the list changes. */
  onChange(listener: () => void): () => void;
}

export type DecisionActions =
  | { kind: 'yes-no'; approveLabel: string; rejectLabel: string; rejectAsksForNote?: boolean }
  | {
      kind: 'word';
      label: string;
      /** In-app path; core route or '/x/<this extension id>/…'. Ignored when `input` is set. */
      href?: string;
      /** Show an inline text field ("Answer"); its text reaches onAction. maxLength ≤ 2000. */
      input?: { placeholder: string; maxLength: number };
    }
  | {
      /** A question: chips, the agent's pick marked, and a deadline. */
      kind: 'choice';
      /** 2-5 choices; label ≤ 40. */
      choices: { id: string; label: string }[];
      /** The agent's pick, marked "agent's pick". Required when decideBy is set. */
      defaultChoice?: string;
      /**
       * ISO time; absent = no deadline line and no timer. Earlier than raise + 5
       * minutes (or past) is clamped to raise + 5 minutes; > 7 days throws.
       * At the deadline core calls onAction with defaultChoice, decidedBy 'deadline'.
       */
      decideBy?: string;
      /** Offer "Reply…" (free text reaches onAction as `text`). */
      allowReply?: boolean;
    };

export interface DecisionInput {
  /** Extension-local; core namespaces it. /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/ */
  key: string;
  /** A question or an outcome, never a command or id (V8). ≤ 120 chars, plain text. */
  title: string;
  /**
   * REQUIRED. What happens, why now, what a "no" means (V8). Plain text,
   * 1-300 chars. raise() throws InboxLimitError('why') without it.
   */
  why: string;
  /** ≤ 500 chars, plain text; shown behind ⓘ. */
  detail?: string;
  /** Any path inside the project; core resolves it. */
  project?: string;
  /** Muted right-hand label of the project heading, e.g. "Linear DOR". */
  projectLabel?: string;
  /** ISO time the condition began ("since 09:14 · asked after 1h"). */
  since?: string;
  actions: DecisionActions;
  /** In-app path the row's title opens, e.g. "/x/flow/p/dorkos". Core route or '/x/<this extension id>/…' only. */
  link?: string;
}

export interface RaisedDecision {
  /** Core's id for the row (what `answerDecision` takes). */
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly detail: string | null;
  readonly project: ProjectRef | null;
  readonly projectLabel: string | null;
  readonly since: string | null;
  readonly actions: DecisionActions;
  readonly link: string | null;
  readonly raisedAt: string;
  readonly updatedAt: string;
}

/** `cleared` = resolved on its own; `cancelled` = no longer needed. */
export type DecisionOutcome = 'approved' | 'rejected' | 'answered' | 'cleared' | 'cancelled';

/** Who settled a decision, when it was not a person. */
export type DecisionActor =
  | {
      kind: 'agent' | 'rule';
      /** In words, ≤ 60: "the reviewer agent", "your 'Tell me after' setting". */
      label: string;
    }
  /** The agent's default applied at a deadline; core words it "decided by the agent at <time>". */
  | { kind: 'deadline' };

export interface DecisionActionEvent {
  readonly key: string;
  /** 'offer' is the second call when a person said Yes to a follow-up offer. */
  readonly action: 'approve' | 'reject' | 'word' | 'choice' | 'offer';
  /** The chosen chip, for 'choice'. */
  readonly choiceId: string | null;
  /** 'person', or 'deadline' when core applied defaultChoice at decideBy. */
  readonly decidedBy: 'person' | 'deadline';
  /** The offer being accepted, for 'offer'. */
  readonly offerId: string | null;
  /**
   * Set when a person answered in core's UI: pass it back as
   * resolve(key, { answering }) after a keepOpen, so history credits the person.
   */
  readonly pendingActionId: string | null;
  /** The "Needs changes" note (≤ 2000), when the reject asked for one. */
  readonly note: string | null;
  /** The typed answer (word `input`, or a choice's "Reply…"). */
  readonly text: string | null;
  readonly project: ProjectRef | null;
}

/** "Sorting 12 ideas… · Watch": a chat this extension started, drawn on the row. label ≤ 40. */
export interface DecisionWatch {
  sessionId: string;
  label: string;
}

export type DecisionActionResult =
  | {
      resolve: 'approved' | 'rejected' | 'answered';
      navigate?: string;
      offer?: DecisionOffer;
      message?: string;
      watch?: DecisionWatch;
    }
  | { keepOpen: true; message?: string; navigate?: string; watch?: DecisionWatch }
  /** "Already settled" (by this extension, or moot). Valid at a deadline; core cancels the timer and does nothing else. */
  | { settled: true };
// `navigate` must pass the same rule as `link`, else the answer is treated as a handler error.
// `offer` is honoured only for an answer attributed to a person; for 'offer' calls only `message` is read.
// At a deadline, `keepOpen` is honoured: the timer stops, nothing retries, the row stays open.

/** V9: a one-time "do this on its own next time" line under the answered row. */
export interface DecisionOffer {
  /** Plain text, ≤ 160: "Shipped. Next time, ship on its own when the reviewer agent approves?" */
  text: string;
  /** ≤ 64; comes back as DecisionActionEvent.offerId when the person says Yes. */
  offerId: string;
  /**
   * Applied by core on the person's Yes, before the 'offer' handler call: a
   * shallow merge into this extension's per-project settings (§7.10), attributed
   * to the person, validated like api.projectSettings.set.
   */
  settingsPatch?: { project: string; patch: Record<string, unknown> };
}

/** Thrown by `raise`/`record` when a limit is broken: missing or long why, title > 120, detail > 500, > 50 open, a bad key, a bad choice set or decideBy. Nothing is written. */
export class InboxLimitError extends Error {
  readonly code: 'inbox_limit';
  readonly limit: 'why' | 'title' | 'detail' | 'open' | 'key' | 'choices' | 'decideBy';
}
/** Thrown by `raise` when `link` or a word action's `href` is not an allowed in-app path. Nothing is written. */
export class InboxLinkError extends Error {
  readonly code: 'inbox_link';
}

export interface InboxApi {
  /** Raise, or update in place, the one open decision for `key`. Max 50 open per extension. */
  raise(input: DecisionInput): Promise<RaisedDecision>;
  /**
   * Settle it; `cleared` = "resolved on its own". `by` says an agent or rule of
   * the person's decided (history shows its label). False when nothing was open.
   */
  resolve(
    key: string,
    opts: {
      outcome: DecisionOutcome;
      by?: DecisionActor;
      /** A pendingActionId from a person's answer that got keepOpen: credits that person. */
      answering?: string;
      /** Only with a valid `answering`: the one-time V9 follow-up for that person. */
      offer?: DecisionOffer;
      watch?: DecisionWatch;
    }
  ): Promise<boolean>;
  /**
   * Write a history-only row for something decided without asking ("While you
   * were away"): never in "Needs you", never a push. `why` and `by` are required.
   */
  record(
    input: Omit<DecisionInput, 'actions' | 'since'> & {
      outcome: 'approved' | 'rejected' | 'answered';
      by: DecisionActor;
      /** true ("Tell me after"): unread in Activity until seen. false/absent ("Just do it"): quiet, already read. */
      tell?: boolean;
      /** What was chosen, in words (≤ 40), e.g. "Shipped". */
      choiceLabel?: string;
    }
  ): Promise<void>;
  /** This extension's open decisions. */
  list(): Promise<RaisedDecision[]>;
  /** The one handler for a person's answer; bounded at 5s. A second call replaces the first. */
  onAction(
    handler: (event: DecisionActionEvent) => DecisionActionResult | Promise<DecisionActionResult>
  ): () => void;
}

export interface SessionInfo {
  // ...existing members...
  /** @deprecated Newest of `trackerItems`; removed per §6.8's condition. */
  trackerItem?: { id: string };
  trackerItems: { id: string; via: 'this-chat' | 'own-chat' }[];
}
// LimitedSessionInfo likewise.
```

### 11.3 HTTP (called from flow's client half, as the person)

| Route                                                                                                                                                                                                         | Use                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/projects` → `{ projects: ProjectInfo[] }`                                                                                                                                                           | Flow home, the settings project switcher, mapping `owner/name` in the `fleet.json` handshake |
| `GET /api/projects/resolve?cwd=` → `{ project: ProjectRef \| null }`                                                                                                                                          | Rarely needed; `currentProject` covers the chat                                              |
| `GET /api/runtimes/claude-code/account-eligibility?project=<path>` → `{ project, allow: string[] \| null, accounts: AccountEligibilityRow[] }`                                                                | V6 "Accounts this project may use"                                                           |
| `PUT /api/runtimes/claude-code/project-accounts` `{ project, allow: string[] \| null }` (person bar)                                                                                                          | V6 checkboxes                                                                                |
| `PUT /api/runtimes/claude-code/accounts/:id/only-projects` `{ projects: string[] \| null }` (person bar)                                                                                                      | The one-time `fleet.json` migration                                                          |
| `POST /api/extensions/:id/start-work` (person bar, scoped to `:id`; what `api.startWork` calls)                                                                                                               | V7 outcome buttons                                                                           |
| `GET /api/extensions/:id/decisions`, `POST /api/extensions/:id/decisions/:decisionId/action` (person bar, scoped to `:id`; what `api.listDecisions` / `api.answerDecision` call; attributed to the extension) | Answering from flow's pages                                                                  |
| `GET`/`PUT /api/extensions/:id/project-settings` (the `PUT` is the only writer, person bar)                                                                                                                   | The autonomy dial and other per-project "Just me" settings                                   |

Core UI endpoints, **not** for flow and not reachable through the extension API: `POST /api/extension-decisions/:id/action` and `/offer` (the bell), `POST`/`DELETE /api/extensions/trusted-sources` (the bell's offer line and Settings → Extensions). Every person-bar route above has the residuals of invariant 9: with login off a local caller without `X-DorkOS-Agent` passes, and same-page extension code always can.

`AccountEligibilityRow` = `{ id: string; label: string | null; color: string; implicit: boolean; onlyProjects: ProjectRef[] | null; allowedByAccount: boolean; allowedByProject: boolean; eligible: boolean }`.

Errors flow should expect: `409 { code: 'account_not_allowed_here', message, project, accountId }` from any launch, and `refuseIfNotAPerson`'s `403` from the two `PUT`s when called by anything but a person.

### 11.4 Session and events

- `Session.trackerItems?: TrackerItemRef[]` (newest first; includes work this chat started in its own chats, via `dispatchedBy`) on `GET /api/sessions`, `GET /api/sessions/:id` and live session-list updates. `Session.trackerItem` stays as the newest item until §6.8's removal condition holds.
- `Session.startedBy?: { kind: 'extension'; extensionId: string; extensionName: string; reason: string } | { kind: 'chat'; sessionId: string; title: string | null; reason: string | null }`, drawn as the chat's first line. `ctx.sessions.start`, `api.startWork` and the `session_start` MCP tool set it.
- Resolved `extension.decision` history carries `resolvedBy: 'person' | 'deadline' | 'agent' | 'rule' | 'extension'` and `resolvedByLabel`.
- The extension manifest gains optional `purpose` (≤ 120), used in the approval row's why line.
- A decision is answered either in core's UI (attributed to the person) or through `api.answerDecision` (attributed to the extension). History's `resolvedBy` includes `extension` with label "in Flow" for the latter.
- `GET /api/extensions` records gain `shadowedBy: string | null` (the path of the copy that won, when this copy lost on version).
- Inbox kinds `extension.approval` (notable, never pushes) and `extension.decision` (blocking, may push; the push text is generic, never a title or project name). Outcomes include `dismissed`, `cleared` and `cancelled`.
- Flow's routes that change state on a person's behalf (settings, pause and resume) sit behind `ctx.requirePerson`.

## 12. Phasing, risks and tests

### Phase 1: DOR-2517 (ships alone)

Scope: §5. Tests: §5.6. Risk: the e2e fixture plugin must install in the test-mode server without the network; the fixture is a local-path install. Risk: showing a waiting row for extensions people already ignore on purpose; mitigated by the `disabled` exclusion and one-click "Not now".

### Phase 2: projects and extension seams

Order inside the phase: 6.1 registry and callers → 6.8 tracker items → 6.2/6.3 project on wire shapes and grouping → 7 decisions → 6.4-6.7 client seams → 10 docs and conformance. It can land as three PRs: (a) registry + `trackerItems`, (b) `ctx.inbox` + grouping, (c) client seams + docs. Two things wait for phase 3: `StartWorkError('account_not_allowed_here')` cannot occur before the eligibility rules exist, and the `dispatchedBy` fleet conformance case arrives with phase 3's re-vendoring (phase 2 tests `dispatchedBy` with core unit tests).

Tests:

- Unit: `resolveProjectRoot` for a main checkout, a linked worktree (including one under `~/.dork/workspaces/`), a subfolder, a bare repo, a symlinked path, a non-repo, and a folder holding two repos; cache TTLs; name clash disambiguation; `originRepo` parsing (https, ssh, non-GitHub).
- Server route: `/api/projects` and `/resolve` (boundary refusal); `/api/extension-decisions` list and action (person bar, `not_running`, `already_resolved` under a concurrent resolve, timeout, keepOpen, `navigate`); `ctx.requirePerson` (§7.6); link validation refusing an absolute URL, `javascript:`, `//host`, and another extension's `/x/<other>/…` on `link`, `href` and `navigate`, and the push deep link falling back to `/`; the push text never containing the title; escalation disarmed while the extension is disabled and while its project folder is missing; `ctx.projects.report` refusing a path outside the boundary and a non-repo, and a reported-only root absent from the phase-4 scan roots; `ctx.projects.list` scoped to the caller; name stability (a later clash never renames the first project); the conformance test in §10; `flow-run-link` keeps several records, orders them, and includes `dispatchedBy` runs in their own chats (pinned in `fleet-conformance.test.ts`); the broadcaster carries `trackerItems` and `trackerItem`; the seam-contract type test.
- Deadlines: a handler returning `keepOpen` at the deadline leaves the row open with no retry and no timer, and a later `resolve(key, { outcome: 'answered', by: { kind: 'agent', label: 'the reviewer agent' } })` succeeds and reads so in history; `{ settled: true }` is not an error; a restored deadline does not fire before activation and `onAction` registration, and fires once both hold; no handler registered never counts as a failure; a disabled extension's deadline pauses and fires after re-enable; a `decideBy` in the past or 2 minutes ahead is clamped to raise time + 5 minutes; a `choice` without `decideBy` draws no deadline line and arms no timer.
- Attribution: a core-UI answer is `person`; `api.answerDecision` is `extension` ("answered in Flow"), cannot answer another extension's row (404), and never gets an offer; a `keepOpen` issues a `pendingActionId`, and `resolve` with it credits the person and shows its offer once; a foreign `pendingActionId` is ignored. `watch` renders "· Watch" on open and history rows, and a `watch` naming a chat the extension did not start is dropped.
- Start limits: after a server restart the hourly count still holds; a `session_start` inside an extension-started chat counts against that extension and is refused past the limit; `ctx.sessions.start` in a project without a copy of the extension is `not_a_project`.
- Trusted origin: only `sourceRepo` counts, normalized (https and ssh GitHub URLs, case); an `installedFrom`-only install has no trusted origin.
- Decisions round 2: `raise` and `record` refuse a missing, blank or 301-character `why`; a `choice` question's chips, marked pick and deadline line render; at `decideBy` (fake timers, and a deadline passed while the server was down firing once the extension has activated) the handler gets the default with `decidedBy: 'deadline'` and history reads "decided by the agent"; a handler failing at the deadline retries twice and then leaves the row open and escalating; a person's answer cancels the timer; an `offer` shows once, `Yes` calls the handler with `action: 'offer'`, a second post is `409 offer_gone`, a deadline resolution never offers; `record` never lands in "Needs you" or pushes; with `tell: true` it is unread and the "While you were away" group shows a dot, with `tell: false` it is written read; three such rows fold into "While you were away"; an offer's `settingsPatch` is merged into the project's settings on Yes, attributed to the person, before the `offer` handler call, and a patch for a project outside the extension's scope is refused with nothing written; `resolve(..., { by: { kind: 'deadline' } })` reads "decided by the agent"; `resolve(..., { by })` shows its label.
- Starting work: §7.7's tests.
- DB: migration tests for `known_projects` and `extension_decisions` (the partial unique index rejects a second open row and allows one after resolution).
- Client: grouping hides the heading below two projects; `InboxDecisionRow` note flow; page routing, skeleton and empty states; palette and phone "Add-ons"; status-bar promotion and budget; tab marker; `currentProject`.
- Browser (`apps/e2e/tests/extensions/extension-seams.spec.ts`): with hello-world enabled, open its page from the command palette, reload on the page URL (skeleton, then the page), see its status-bar item in a chat, and see its tab dot. With the inbox fixture, a raised decision appears under its project heading when a second project has an item, and 👍 resolves it.
- Risk: `SessionSchema.trackerItem` removal touches several client readers. Grep `apps/e2e` for "Working on" copy before pushing.
- Risk: grouping changes the bell's DOM, which browser specs assert on. Grep `apps/e2e` for the bell's section structure.

### Phase 3: account eligibility

Tests:

- Unit: `accountEligibility` truth table (null/list × no entry/entry × project/no project, Main included); every row of §8.4 has a test that an ineligible pick refuses and an automatic pick skips to an eligible one; the ladder's four rungs; `validateAdvisorRanking` drops an ineligible account the advisor returned; `planEpisode` degrades an ineligible `auto` to `ask`; rename propagation into `projectAccounts`.
- Fleet contract: the re-vendored 4.1.0 eligibility cases, plus the Main and canonicalization cases, pass against `accountEligibility` (§8.7).
- Config: the migration against a realistic stale blob via a real `ConfigManager` reading `config.json`; a project root containing a dot written and read back; the three drift guards (disclosure, write policy, default verdicts) and the protective carry-over test.
- Server route: the three `/api/runtimes/claude-code/...` routes, including the person bar refusing an agent request and the Activity entry.
- Browser (`apps/e2e/tests/account-ui/account-eligibility.spec.ts`): with two test-mode accounts, restrict one to project A; in a chat in project B the picker shows it disabled with "Only for A"; Settings → Runtimes shows "Only for A".
- Risk: a person with a restricted default account sees their usual account change in other repos. That is the intent, and the refusal and "Only for" line make it visible. Risk: several callers pass `''` as cwd today; they now mean "no project", which restricted accounts never serve. Each such caller is listed in §8.4 and tested.

### Phase 4: extensions across many projects

Tests:

- Unit (`extension-discovery.test.ts`): each row of the precedence table; the four edge cases in §9.2; a clone-with-claimed-origin case never runs unapproved; `trustedOriginOf` for global, recorded project, and unrecorded project copies; `isApprovedCopy` by origin.
- Server: approving flow in repo A, then installing a newer flow in repo B through the installer, loads B's copy with no new approval item; an older copy reports `shadowedBy`.
- Risk: scanning every known project on each reload costs disk reads; the scan is bounded to `.dork/extensions` and `.dork/plugins/*/.dork/extensions` per root, debounced, and runs off the request path.

### Docs and changelog

One changelog fragment per PR, covering only what that PR ships (phase 2's three PRs get three fragments; the text below is split accordingly).

- Phase 1: §5.7.
- Phase 2: `contributing/extension-authoring.md` and `docs/integrations/extensions.mdx` per §10; `contributing/architecture.md` gains a short "Projects" paragraph (what a project is, `resolveProjectRoot`, the registry). Fragment `### Added`: "Extensions can now add a full page, an item in the chat status bar, and a dot on their tab, and they can ask you things in the Activity inbox. Questions from different projects are grouped under the project's name."
- Phase 3: `contributing/configuration.md` Settings Reference and `docs/getting-started/configuration.mdx` for the three fields; a short section in `docs/guides/flow/use-all-your-accounts.mdx` on "Only for". Fragment `### Added`: "Keep an account to the projects it belongs to. Set a work account to 'Only for client-app' in Settings → Runtimes and DorkOS will never use it anywhere else, whether you, a schedule or an agent picks it."
- Phase 4: `contributing/extension-authoring.md` "Directory Structure" notes that plugin-carried extensions in every known project are found, and how the newest copy wins. Fragment `### Changed`: "When the same extension is installed in several projects, DorkOS now runs the newest copy everywhere instead of whichever project it opened first."

## 13. Open questions

None. Every non-visual question this spec met is decided in place and marked **Decided in spec**: D1-D14 (§2), no backfill of install-record origins (§9.1), the approval why line's derivation and manifest `purpose` (§5.1), core-run deadlines with retries (§7.1), trusted sources keyed on the exact source string (§9.3, D14), `startedBy` storage and the collapsed prompt (§7.7), the `adds` line source (§5.1), inbox project heading labels (§6.3), `known_projects` naming (§6.1), `trackerItems` beside a deprecated `trackerItem` (§6.8), Main's account-side rule (§8.1), the ladder's named-versus-default rungs (§8.4), and core's "Project limits" list (§8.5).
