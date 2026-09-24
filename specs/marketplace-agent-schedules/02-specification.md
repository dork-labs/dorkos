---
slug: marketplace-agent-schedules
number: 260907-001947
created: 2026-09-24
status: specified
linear-issue: DOR-2272
---

# Schedules a person makes for a marketplace agent

**Status:** Draft
**Author:** Claude Code (prog-DOR-2272)
**Date:** 2026-09-24
**Input:** [`01-ideation.md`](./01-ideation.md) (DOR-1791), read against what DOR-2245 shipped
**Baseline:** `origin/main` `b108252de` (DOR-2245, PR #2084, merged)

## Overview

A person can make a schedule for an agent that came from a marketplace package, and edit it like any other schedule, because DorkOS now decides who owns a schedule's file from the package's installed-files record instead of from where the file sits. A schedule the package shipped stays the package's: DorkOS still does not rewrite it, and when an edit is refused the app offers **Make my own copy**, which turns the edit into a new schedule of the person's own for the same agent.

## Background / Problem Statement

DOR-1789 made both task doors refuse a marketplace agent: `create-task.ts` refuses to file any new schedule under an agent whose directory carries a package marker (`isPackageOwnedAgent`), and `update-task-file.ts` refuses to rewrite any file `isPackageOwned` claims. Its third limb claims **every** file under a marked agent directory. The reason was true then: a package update deleted the whole install root, so a schedule made there vanished at the next update, and the agent came back with a new id (DOR-1791 F1).

DOR-1791 designed the fix (`01-ideation.md` §5–6, tasks T1–T5) but only the design shipped. DOR-2245 (#2084) has since changed the ground under it:

1. **Every install root carries `.dork/installed-files.json`**, listing each file the install put there with its hash (`lib/installed-files.ts`). An update, reinstall or plain uninstall removes or replaces only files the record lists; **every other file survives** (spec `marketplace-package-file-ownership` §1).
2. **An agent package keeps its id across an update and a reinstall** (§8, ADR `260923-163516`). That is DOR-1791's T1, and it also retires the stale task-root id problem (F1's second half, U4).
3. **A record-less (legacy) install is rebuilt on its next update, reinstall or uninstall**, and the rebuild keeps as the person's anything no obtainable package tree has at the same path with the same bytes (`lib/legacy-record.ts`).

So a schedule a person makes in the agent's existing task root, `<agentDir>/.agents/skills/<slug>/SKILL.md`, is not in the record and survives every update. The two refusals are now wrong for it: the create door refuses a schedule that would survive, and the update door would refuse to edit one that was made anyway (the "reads as untrue about a file they just made" failure DOR-1789's review named).

Measured today: `package-owned-agent.test.ts` pins both refusals, and `isPackageOwned` never reads the record.

## Goals

- A person can create a schedule for a marketplace-installed agent, through the app, the HTTP API and the MCP tools, and it survives that package's update and reinstall.
- A schedule the person made under a package agent can be edited like any other.
- A schedule the package shipped still cannot have what it does rewritten by DorkOS. Its switch and timing still land on the row (FB-26, DOR-2302).
- When an edit to a package's schedule is refused, the app offers a working next step: **Make my own copy**.
- One ownership answer, used by both doors and by discovery's sync rules.

## Non-Goals

- **A second task root** (`<installRoot>/.dork/schedules/`, DOR-1791 D1/T3). Dropped: see Decision 1.
- Changing what an update does with files (DOR-2245 owns that).
- Making manifest `schedules[]` file a schedule under an installed agent (DOR-1791 T5 / D5): independent, not blocked on this.
- Surfacing ownership on the `Task` API shape before an edit. The refusal carries it; see Decision 5.
- Rebuilding legacy records outside an install, reinstall or uninstall (a network fetch has no place in a PATCH).

## Decisions

### Decision 1: no second task root (DOR-1791 T3 dropped)

DOR-1791 wanted a separate, preserved directory because the install root was deleted wholesale on every update and the agent's id changed. DOR-2245 removed both premises. A second root would add a watched directory per agent, a new preserved path, a presentation problem (two rows with one name under one agent, D4) and a schedule that is not a skill the agent can invoke by hand (§7 Q3), and buy nothing that the existing `.agents/skills/` root does not now give. `agentTaskRoots` stays a one-entry list.

### Decision 2: ownership comes from the record, and ignores whether the bytes still match

For a file inside an install root that has a record, the file is the **package's** exactly when the record lists it (in `files`, or at or under an `ownedPaths` entry) **and** it does not match the record's `userEditable` patterns.

That is the question "would the package's next update put its own version back?", answered from DOR-2245's carry-over table: a listed, non-editable file is replaced whether or not the person edited it (rows 1, 5, 7), a `userEditable` one keeps the person's copy (rows 6, 8), and an unlisted one is kept (row 9).

It deliberately does **not** use `isProvenPackageFile`, which also requires the bytes to still match. That predicate answers a different question (may DorkOS delete this file?), and here it would get the answer backwards: an edited shipped file fails the hash, would read as the person's, DorkOS would write it, and the next update would replace it and save the edit as `.dork-old`. The same holds for a `skillRef` schedule whose `SKILL.md` was rewritten after the record was taken (DOR-2318).

A record with `uninstalledAt` set is the list of edited files an uninstall left behind. No package is installed there, so it claims nothing.

### Decision 3: an install with no record keeps the three-part check

A legacy install has no record until its next update, reinstall or uninstall rebuilds one. Until then DorkOS cannot tell the package's files from the person's without fetching the original tree, so the DOR-1789 answer stands for that install: plugin and Shape roots by location, `agents/` installs and the owning agent's own directory by marker. It is asked **per install root**, only when that root has no usable record, so it shrinks to nothing as installs are updated.

### Decision 4: the create door asks the same question as the update door

`create-task.ts` stops asking `isPackageOwnedAgent` (deleted) and asks the ownership question about the file it is about to write. Create then refuses exactly what update would refuse, so DOR-1789's contradiction cannot come back:

- **Recorded install, a new name:** allowed. The file is unlisted, so it is the person's.
- **Recorded install, a name the package ships** (present, or deleted by the person but still listed, so its next update would bring it back): refused with a message that says the name is the package's.
- **Legacy install:** refused, with a message that says when it ends: after the package's next update, which writes a record. (Not "reinstall": for an agent package the app's Reinstall makes a fresh agent, see Review round 1.)

### Decision 5: Make my own copy, from the refused edit

The client learns that a schedule is the package's from the `schedule_package_owned` refusal of the edit (`code` already rides on the transport error). The edit form then shows the refusal inline, in place of the generic toast, with a **Make my own copy** button. The button turns the dialog into a New Schedule form holding everything the person had typed, for the same agent, named `<name>-copy`, so they can check it and press Create. The package's schedule is left as it is, and the notice says it keeps running unless they switch it off.

Why from the refusal and not a flag on every task: the answer needs file reads (the record) per task, the list endpoint does not do file reads today, and the only moment the answer matters is when an edit is refused. Why a prefilled form and not a silent create: the person gets to see the name and the power level before a new schedule exists, and a created schedule still parks or arms through the normal create path.

### Decision 6: a later version that ships the same name

A person's schedule `<agentDir>/.agents/skills/nightly/SKILL.md` is unlisted. If a later package version starts shipping `.agents/skills/nightly/SKILL.md`, DOR-2245's row 10 applies: the package's copy takes the path, the person's is saved beside it as `SKILL.md.dork-old`, and the update result carries a `replaced-edit` notice naming it. The task row at that path now describes the package's schedule; its prompt and cron differ from what the person approved, so the stored approval no longer matches and the schedule parks for a fresh approval instead of running the package's work on the person's say-so. The person's own schedule is not lost (the `.dork-old` file holds it) but it no longer runs until they recreate it under another name. Accepted: it needs a package to start shipping a schedule with exactly the person's name, the update result says what happened, and nothing runs that nobody approved. A separate root (Decision 1) was the only way to make this impossible, and it is not worth its cost.

## Technical Dependencies

- `apps/server/src/services/marketplace/lib/installed-files.ts` (`readInstalledFiles`, `InstalledFiles`), DOR-2245.
- `matchesUserEditable` from `@dorkos/marketplace`, DOR-2245.
- No new packages.

## Detailed Design

### Server: `services/tasks/task-file-update.ts`

Replace the three-limb body of `isPackageOwned` with a per-install-root answer. The context type and its two builders (`packageOwnershipContext`, `rootPackageOwnershipContext`) keep their shape; the limbs now name **candidate install roots** rather than answers.

```ts
/** Who a schedule file belongs to, and how DorkOS knows. */
export type PackageOwnership = { owned: false } | { owned: true; by: 'record' | 'legacy' };

export async function packageOwnershipOf(
  filePath: string,
  ctx: PackageOwnershipContext
): Promise<PackageOwnership>;
export async function isPackageOwned(
  filePath: string,
  ctx: PackageOwnershipContext
): Promise<boolean>; // = packageOwnershipOf(...).owned
```

1. Resolve the file through its deepest existing ancestor (`fs.realpath` of the file, else of its parent plus the rest, recursively). The create door asks about a file that does not exist yet, and a bare path would never match a resolved root on macOS, where every temp directory is a symlink.
2. Collect candidates, each `{ installRoot, legacy: 'location' | 'marker' }`, de-duplicated by resolved path:
   - each `packageOnlyRoots` entry containing the file: `<root>/<first segment>`, legacy `location`;
   - each `sharedInstallRoots` entry containing the file: `<root>/<first segment>`, legacy `marker`;
   - `agentDir`, when it contains the file: legacy `marker`.
3. For each candidate, `readInstalledFiles(installRoot)`:
   - **a record:** if `uninstalledAt` is set, it claims nothing. Otherwise compute the POSIX path of the file relative to the install root; owned when it is in `record.files` or at or under an `ownedPaths` entry, and `!matchesUserEditable(rel, record.userEditable)`. Owned returns `{ owned: true, by: 'record' }`; not owned moves on to the next candidate.
   - **no record:** `location` answers owned; `marker` answers owned when the install root carries `.dork/manifest.json` or `.dork/install-metadata.json`. Owned returns `{ owned: true, by: 'legacy' }`.
4. No candidate claims it: `{ owned: false }`.

Any candidate claiming the file is enough, which keeps nested installs right (a plugin installed at project scope inside an agent package's directory is claimed by the plugin's record even though the agent's record does not list it) and keeps the DOR-1789 re-review property: limbs 1 and 2 still answer without mesh.

Delete `isPackageOwnedAgent` and its TSDoc. Rewrite the `isPackageOwned` TSDoc and `PackageOwnershipContext` TSDoc to describe the record rule and the legacy fallback.

### Server: `services/tasks/lifecycle/create-task.ts`

Replace the `isPackageOwnedAgent` block with, before the existing "already exists" check:

```ts
const filePath = path.join(home.skillsDir, slug, SKILL_FILENAME);
const ownership = await packageOwnershipOf(
  filePath,
  packageOwnershipContext(deps.dorkHome, home.projectPath)
);
if (ownership.owned)
  return {
    ok: false,
    status: 409,
    code: 'schedule_package_owned',
    error: ownership.by === 'record' ? NAME_IS_THE_PACKAGES(slug) : LEGACY_PACKAGE_AGENT,
  };
```

Asked for every target, not only agents: a global or hand-made agent's path is in no install root and answers `{ owned: false }` with no record read.

### Server: `services/tasks/lifecycle/update-task-file.ts`

No logic change; the call already goes through `isPackageOwned`. Both refusal sentences are rewritten (User Experience).

### Server: sync rules

`packageOwnershipInRoot` (the watcher and the reconciler) goes through the same function, so a person's schedule under a recorded package agent is reported `packageOwned: null` and syncs like any other file (its `enabled` and timing come from the file), while a shipped one keeps the FB-26 and DOR-2302 row-only behaviour. The answer is kept on the row and ownership lapsing is handled (Review round 1, item 1).

### Client

- `apps/client/src/layers/shared/lib/query-client.ts`: the mutation-cache toast also skips an error for which `mutation.meta.isShownInline(error)` answers true. A surface that renders a specific refusal itself opts out of that refusal only, and only while it is on screen; every other failure still toasts.
- `apps/client/src/layers/entities/tasks/model/use-tasks.ts`: `useUpdateTask({ isShownInline })` takes the predicate as a per-caller option, and exports `PACKAGE_OWNED_SCHEDULE_CODE`. Only the edit form passes it. The approval card deliberately does not: its "approve at a higher level" can be refused with the same code, and its own line about the refused level relies on the toast to say why.
- `apps/client/src/layers/features/tasks/ui/TaskFormInner.tsx`: when the edit mutation fails with `schedule_package_owned`, render the server's sentence in a notice above the footer with a **Make my own copy** button. The form gains an `onMakeCopy(values)` prop.
- `apps/client/src/layers/features/tasks/ui/CreateTaskDialog.tsx`: holds an `isCopy` flag, set only by `onMakeCopy` through `applyFormValues(values, true)` and cleared by every other way of loading the form (opening, closing, a new task). While set, the dialog renders the create form (title "New Schedule", no enable switch, no Delete) on the copied values. The notice stays until the next save.
- `task-form-values.ts`: `copyFormValues(values)` does the rename, pure and tested.

## User Experience

- **Create, recorded package agent:** works exactly as for any agent.
- **Create, name the package ships:** "This agent's package already has a schedule called "nightly-sweep", so DorkOS didn't make another one with that name. Pick a different name."
- **Create, package installed by an older DorkOS:** "This agent's package was installed by an older version of DorkOS without a list of its files, so DorkOS can't yet tell them from yours, and a schedule made here could be lost at the package's next update. This will work after that update." A path that leads into another package (a Harness Sync link) names that package instead of "this agent's package".
- **Edit a package's schedule (what it does):** "This schedule came with an installed package, so DorkOS didn't change it: the package's next update would put its own version back. You can switch it on or off, or change when it runs, here. To change what it does, make your own copy."
- **Edit a package's schedule (a higher power level):** "This schedule came with an installed package, so DorkOS didn't change how much it may do: the package's next update would put its own setting back. You can still approve it as it stands, and it will run at the level the package asks for. To give it more, make your own copy."
- **In the app,** either edit refusal shows inline in the edit dialog with **Make my own copy**. The notice ends: "The package's schedule keeps running unless you switch it off." Clicking the button shows the New Schedule form with the person's edits and the name `<name>-copy`; Create files it for the same agent, where it parks for approval or arms through the usual rules.

## Testing Strategy

Each test carries a purpose comment and was seen to fail first.

- **`lifecycle/__tests__/package-owned-agent.test.ts`** (rewritten around real records written with `writeInstalledFiles`, driven through `applyTaskFileUpdate` and `createScheduledTask` with a mesh answering as the real one does):
  - recorded agent package, project and global scope: create of a new name succeeds and lands in `<agentDir>/.agents/skills/<slug>/SKILL.md`; editing that file succeeds.
  - editing a listed shipped schedule is refused (`schedule_package_owned`), and so is editing one whose bytes were changed after install (the hash-ignoring rule).
  - a listed schedule matching `userEditable` is editable.
  - create of a listed name that the person deleted is refused with the package-name message.
  - a record with `uninstalledAt` claims nothing.
  - legacy (no record) agent package: create refused with the legacy message; edit refused (both markers).
  - hand-made agent: create and edit allowed, as today.
  - plugin root: a listed file is refused; an unlisted file in a recorded plugin install is editable; a file in a record-less plugin install is refused by location.
  - no mesh and a deregistered agent: a listed file in a global agent package is still refused through the `agents/` candidate.
- **`__tests__/skills-root-discovery.integration.test.ts` / sync:** discovery reports a person's schedule under a recorded package agent as not package-owned, so a file edit to `enabled` reaches the row; a shipped one keeps the row's switch (FB-26).
- **Client:** `TaskFormInner` / `CreateTaskDialog` tests: a refused edit renders the sentence and the button and no toast; the button opens the create form with the edits, `<name>-copy`, and the same agent; Create sends a create request with them. `query-client` test: `isShownInline` suppresses only what it claims. `copyFormValues` unit test.
- **Mutation checks** (each must turn a test red): drop the `userEditable` clause; use `isProvenPackageFile`'s hash check; drop the `uninstalledAt` clause; make a record-less root answer `false`; remove the create door's ownership call; drop `ownedPaths`; skip resolving a not-yet-existing file through its ancestors; make discovery claim every file; remove the `isShownInline` check, the form's opt-in or its mounted check; show the copy for any error; keep the copy mode across a reopen.

## Performance Considerations

Each ownership question reads and parses at most one record per candidate install root (usually one). Discovery asks once per schedule file per sweep; there are few schedule files and records are small (`node_modules` is an owned path, not listed). No cache: a cache keyed on the record would have to track DOR-2245's rewrites of it, and the read is cheaper than that bookkeeping.

## Security Considerations

The record only ever makes DorkOS **more** willing to write a file inside an install root, so a tampered record is the risk to weigh. `readInstalledFiles` already rejects records that fail the schema or name paths outside the root. A record that omits a shipped schedule makes that schedule editable, which is exactly what it would be if the person had made it, and it runs only once a person approves its new content (the stored approval is bound to prompt and cron). Nothing here arms or grants anything.

## Documentation

- `contributing/marketplace-installs.md` §7: the `isPackageOwned` paragraphs rewritten for the record rule, the legacy fallback and the create door; the "open follow-up work" sentence removed.
- `specs/marketplace-agent-schedules/01-ideation.md`: status line pointing at this spec.
- ADR `260924-*-schedule-ownership-reads-the-installed-files-record` (draft).
- One changelog fragment.

## Implementation Phases

- **Phase 1:** server ownership rule, both doors, sync tests, docs.
- **Phase 2:** client Make my own copy.

## Open Questions

None.

## Related ADRs

- `260923-163513` installed files owned by provenance; `260923-163516` package agent keeps identity across update.
- `260823-200724` schedulability is frontmatter; `260823-200726` file-discovered schedules never auto-arm.

## References

- DOR-2272, DOR-1791, DOR-1789, DOR-2245 (#2084), DOR-2302, DOR-2318 (#2087), FB-26.
- `specs/marketplace-package-file-ownership/02-specification.md` §1, §4 (the carry-over table), §9.

## Review round 1 (2026-09-24)

The adversarial review kept the ownership rule and required the following, all built in the same PR.

1. **Ownership is kept on the row** (`pulse_schedules.package_owned`: `record` | `legacy` | NULL, migration `0109`), written by every discovery sync. When it goes from a package to NULL, the sync keeps the row's switch (an OFF switch always, an ON switch only under a standing approval) and `carrySwitchIntoReleasedFile` writes it into the now-writable file, from the watcher and the reconciler. Before, a person's OFF switch flipped back ON when the record stopped listing the file.
2. **The inline refusal replaces the toast only while the form is on screen.** `useUpdateTask({ isShownInline })` replaces `inlineErrorCodes`; the form answers from a mounted ref, so a refusal landing after the dialog closed still toasts.
3. **Legacy wording on the edit door**, with `ownedBy` on every `schedule_package_owned` refusal (routes and MCP tools pass it through). A legacy refusal says the rest works after the package's next update and offers no copy.
4. **Refusals name the real owner**: `PackageOwnership` carries `packageName` and `agentOwned`.
5. **Copy names count up** (`-copy`, `-copy-2`, …) past the names of the same agent's schedules.
6. **UX (operator decision):** the task wire type carries `packageOwned` (in the OpenAPI). A package's schedule opens with a notice at the top; its name, description, prompt, power level and runtime settings are read-only (a disabled fieldset), its switch and timing stay editable; a `record` notice offers Make my own copy, a `legacy` one does not. The copy form has **Switch off the package's schedule**, ticked by default; after Create it sends `enabled: false` for the original.

**Reinstall finding.** The Installed view offers Update (only when one exists) and Uninstall per row; Reinstall is only on the package's detail sheet, and for an agent package it opens agent creation, a fresh agent, rather than reinstalling in place. So "reinstall" is not honest advice for a legacy agent package, and the wording says "after the package's next update" instead. A safe background record rebuild is DOR-2197's.

## Review round 2 (2026-09-24)

1. **Rows older than the column** are backfilled to `unknown` by migration `0109`. The wire shows it as `null`; the first sync treats `unknown` → not owned as a release, so an OFF switch is kept and the file is written only where row and file disagree. (A NULL row is now only ever a person's, so the reviewer's T2 is expressed with `unknown`.)
2. **The release is two-phase** (`FileSyncGates.packageOwnedToWrite`). While the row keeps a switch the file does not say yet, the row keeps its previous ownership; `null` is recorded only by a sync that finds the file agreeing. A failed write, or the watcher and reconciler interleaving, therefore costs a retry, not the switch.
3. **The write re-checks** that no package owns the file now and that the file still parses to what discovery read, and skips otherwise.
4. Follow-up **DOR-2320** (related to DOR-2197): an in-place "Prepare this package" action for legacy installs, rebuilding the record from the installed commit under the install lock, with no byte-matching fallback.
5. **An `unknown` row keeps only an OFF switch** (final delta, T4): it may have been the person's all along, so an ON row under a standing approval never overrules an OFF the person wrote in the file. `record` and `legacy` keep the approval rule.
