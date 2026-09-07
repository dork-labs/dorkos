---
slug: marketplace-agent-schedules
number: 260907-001947
created: 2026-09-06
status: ideation
---

# A durable home for schedules a person makes for a marketplace agent

**Slug:** marketplace-agent-schedules
**Tracker:** DOR-1791 (follow-up from DOR-1789)
**Date:** 2026-09-06
**Author:** investigation agent (Opus)

---

## 1) Intent & Assumptions

- **Task brief.** DOR-1789 made task create/update **refuse** on an agent that came from a marketplace package: a schedule written into the package's checkout is wiped by that package's next update, and silently accepting it was worse than refusing. The cost, weighed and accepted, is that **a marketplace agent cannot be given a schedule at all today**. This document decides where such a schedule should actually live, and what the refusal becomes.
- **This document is the decision, not the code.** Each candidate gets a verdict against the six axes the ticket names — discovery/sweep interaction, update semantics, uninstall semantics, `agentId` stability, collision with author-shipped schedules, and UX — and the winner gets an implementation sketch sized for follow-up EXECUTE tickets.
- **Baseline.** Read against `origin/main` at `2d09c872e` (pinned once; working tree clean at start). Nothing was modified outside `specs/`.
- **Acceptance, restated from the ticket.** A person can schedule work for a marketplace-installed agent, and the schedule survives that package's update.
- **Assumptions carried into the verdicts:**
  - The file is the source of truth and the row is a derived cache (ADR-0043 for agents, ADR `260823-200724` for schedules). No candidate that inverts that is acceptable.
  - Schedulability is a **frontmatter property, not a place on disk** (ADR `260823-200724`). Adding a place is allowed; adding a _meaning_ to a place is not — a directory may be watched, but a file in it is still only a schedule because it carries a `schedule:` block.
  - **File-discovered schedules never auto-arm** (ADR `260823-200726`). Nothing proposed here arms anything; every new file parks for a person.
  - `.dork/data/` and `.dork/secrets.json` are the only paths an uninstall-without-purge preserves (ADR-0233, `contributing/marketplace-installs.md` §Data preservation).
  - Out of scope: the Shape schedule path (`shape-schedule-service.ts`, which binds by `agentRef` and has its own teardown), the never-auto-arm gate itself, and any change to how plugins' schedules are discovered.

## 2) Pre-reading log

| File / artifact                                                                      | What it settled                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/tasks/skills-roots.ts`                                     | The whole root inventory: one global (`<dorkHome>/skills/`), one per agent (`<projectPath>/.agents/skills/`). `agentTaskRoots` returns a **list** on purpose, "so adding a second project root later is a one-line change". |
| `apps/server/src/services/tasks/attach-task-roots.ts` + `index.ts` L2535-2600        | Where roots are attached — at boot per registered agent, and on the agent-created seam. `addRoot` dedupes **by directory**.                                                                                                 |
| `apps/server/src/services/tasks/skills-root-discovery.ts`                            | The door: parse → `schedule:` block or nothing → row. `linkedSkillDirs` follows symlinks out of a root. Attribution comes from the `TaskRoot`, never from the file.                                                         |
| `apps/server/src/services/tasks/task-store.ts` L1169-1280                            | `upsertFromFile(def, agentId, …)` writes `agentId: agentId ?? null` — **the row's agent is whatever the root said**, rewritten on every sweep.                                                                              |
| `apps/server/src/services/tasks/schedule-identity.ts`                                | Identity is the resolved real path; first root to see a file claims it.                                                                                                                                                     |
| `apps/server/src/services/tasks/schedule-permission-clamp.ts` L155-265               | The arm gate. `holdsGrantFor` compares the **stored** `approvedContentKey` against the file's prompt+cron, and never reads `status`.                                                                                        |
| `apps/server/src/services/tasks/task-store.ts` L1324-1334                            | `markRemovedByFilePath` sets `enabled:false, status:'paused'` and **does not clear `approvedContentKey`**.                                                                                                                  |
| `apps/server/src/services/tasks/lifecycle/create-task.ts` L296-324                   | The DOR-1789 create refusal, verbatim, and the comment naming DOR-1791 as its remedy.                                                                                                                                       |
| `apps/server/src/services/tasks/lifecycle/update-task-file.ts` L150-175              | The DOR-1789 update refusal, verbatim.                                                                                                                                                                                      |
| `apps/server/src/services/tasks/task-file-update.ts` L136-345                        | `isPackageOwned`'s three limbs and `isPackageOwnedAgent`. **Limb 3 claims every file under a marked agent directory.**                                                                                                      |
| `apps/server/src/services/marketplace/flows/uninstall.ts` L46-50, L496-520           | The preserved set is two constants (`DATA_SUBPATH`, `SECRETS_SUBPATH`) and one 20-line `restorePreservedData`.                                                                                                              |
| `apps/server/src/services/marketplace/marketplace-installer.ts` L444-590, L914       | `applyUpdate`: uninstall-no-purge → snapshot preserved to scratch → `rm -rf` install root → fresh install → copy back. `findInstallRootFromPreservedPath` is generic on the `.dork` segment.                                |
| `apps/server/src/services/marketplace/flows/install-agent.ts` L110-145               | Every agent install (including the reinstall half of an update) calls `createAgentWorkspace({ skipTemplateDownload: true })`.                                                                                               |
| `apps/server/src/services/core/agent-creator.ts` L290-425                            | `skipTemplateDownload` skips the collision check; then `const id = ulid()` and `writeManifest` run **unconditionally**.                                                                                                     |
| `packages/mesh/src/mesh-discovery.ts` L598-680                                       | A row at a path carrying a **different** id is the branch-swap case: `upsert` deletes the old row directly, **without** the `onUnregister` cascade.                                                                         |
| `apps/server/src/services/tasks/task-scheduler-service.ts` L872-882                  | A run resolves its working directory with `meshCore.getProjectPath(task.agentId)` and **fails loudly** when the agent is not in the registry.                                                                               |
| `apps/server/src/services/marketplace/lib/materialize-schedules.ts` L180-200         | `resolveSkillsRoot`: a project-scoped install materializes inline schedules into `<projectPath>/.agents/skills/`; a global one into `<dorkHome>/skills/`.                                                                   |
| `apps/server/src/services/marketplace/lib/validate-package-schedules.ts` L52         | `SKILL_SEARCH_DIRS = ['skills', '.claude/skills', 'commands', '.claude/commands']` — **`.agents/skills` is not in it**.                                                                                                     |
| `packages/harness/src/plan/installed-projector.ts` L67                               | `PROJECTABLE_PLUGIN_TYPES = {plugin, skill-pack}` — an **agent** package's content is never projected into a skills root.                                                                                                   |
| ADRs `260823-200724`, `-200726`, `-200729`; ADR-0233; ADR-0304                       | The programme's decided posture: frontmatter marks schedulability, discovery never auto-arms, update is uninstall-no-purge → reinstall, installs are file-scoped transactions.                                              |
| `changelog/unreleased/260905-151526-schedules-inside-installed-agents-and-shapes.md` | What DOR-1789 told users.                                                                                                                                                                                                   |

## 3) How it works today, and five facts the ticket does not state

### 3.1 The mechanism, in four sentences

A schedule is a `SKILL.md` carrying a `schedule:` block, found in one of two kinds of watched root: the global `<dorkHome>/skills/`, or one per registered agent at `<projectPath>/.agents/skills/`. Its **identity** is the file's resolved real path; its **attribution** (scope, project, agent) comes from the `TaskRoot` that found it, and is rewritten into the row on every five-minute sweep. A person's approval is a stored `approvedContentKey` on the row, keyed to that file's prompt and cron. An agent package installs to `<dorkHome>/agents/<name>` (or `<repo>/.dork/agents/<name>`), so `agentSkillsRoot` for that agent points **inside the package's own checkout** — which is what makes writing there a losing move.

### 3.2 What an update actually preserves

`update()` is uninstall-without-purge → snapshot → `rm -rf` the install root → fresh install → copy the snapshot back. The preserved set is exactly two paths, named by two module constants: `<installRoot>/.dork/data/` and `<installRoot>/.dork/secrets.json`. Everything else in the checkout — including `.dork/agent.json`, including every file under `.agents/skills/` — is replaced by the new version's contents.

### 3.3 What DOR-1789 shipped

Commit `2b870a9b0` (PR #1594). Two refusals, both `409 schedule_package_owned`:

- **Create** (`create-task.ts`): `isPackageOwnedAgent(home.projectPath)` — the agent's own directory carries `.dork/manifest.json` or `.dork/install-metadata.json`. Message: _"…Add the schedule to the package itself, or ask the package's author to ship it."_
- **Update** (`update-task-file.ts`): `isPackageOwned(filePath, ctx)` — three ORed limbs (a `plugins/`/`shapes/` root by location; an `agents/` root plus a marker on the install; the owning agent's own directory plus a marker). Message: _"…You can switch this schedule on or off here; to change what it does, edit the package or make your own copy of the skill."_

No client code reads `schedule_package_owned`; both messages surface as raw errors.

### 3.4 The five facts

**F1 — A marketplace agent's id is regenerated on every package update, so the row's foreign key breaks even if the file survives.**
`applyUpdate` deletes the install root, which takes `<installRoot>/.dork/agent.json` with it (it is not in the preserved set). The reinstall calls `createAgentWorkspace({skipTemplateDownload: true})`, which under that flag skips the "directory already contains a DorkOS project" check and then runs `const id = ulid()` followed by an unconditional `writeManifest`. The agent comes back with a **new ULID at the same path**. Mesh's `upsertAutoImported` reads that as the branch-swap case and deletes the old row **directly, not through `removeAgent`** — so `onUnregister` never fires and `disableTasksByAgentId` never runs. Two consequences:

1. Every task row still carrying the old id fails at fire time with `Agent <old id> not found in registry -- task <id> cannot run` (`task-scheduler-service.ts` L879).
2. The watched root's cached `agentId` also goes stale: `attachAgentRoots` is called again for the new agent, `addRoot` dedupes **by directory**, so the root keeps the dead id and the next sweep re-stamps every discovered file with it. Until the server restarts.

**This is the fact that reframes the whole ticket.** "Where do the bytes live" is the smaller half; "does the row still name a live agent" is the load-bearing half, and no candidate in the ticket's list addresses it.

**F2 — The refusal's advice is only partly actionable for an agent package.**
"Add the schedule to the package itself" has three readings, and only one works:

| Author does this                                                                  | What happens                                                                                                                                                                                             | Filed under the agent? |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Manifest `schedules[]` **inline**, global install                                 | `resolveSkillsRoot` has no `projectPath`, so it generates into `<dorkHome>/skills/` — the **global** root                                                                                                | **No** — global        |
| Manifest `schedules[]` **inline**, project-scoped install                         | generates into `<repo>/.agents/skills/` — the **host project's** agent, not the installed one at `<repo>/.dork/agents/<name>`                                                                            | **No** — wrong agent   |
| Manifest `schedules[]` with **`skillRef`**                                        | written into `<installRoot>/{skills,commands,.claude/*}/…` (`SKILL_SEARCH_DIRS` excludes `.agents/skills`), which **no root watches** for an agent package (`PROJECTABLE_PLUGIN_TYPES` excludes `agent`) | **No** — undiscovered  |
| Ship `.agents/skills/<slug>/SKILL.md` with a `schedule:` block, no manifest entry | The install copies it into `<agentDir>/.agents/skills/`, which **is** that agent's watched root → parked row, correct `agentId`                                                                          | **Yes**                |

So the only working path is the one the message does not mention and the manifest slot does not advertise. That is a separate defect (see D5) but it matters here: it is why "just tell the author" is not a complete answer today.

**F3 — Approval survives a file that disappears and comes back, provided its prompt and cron are unchanged.**
`markRemovedByFilePath` writes `status: 'paused'` but leaves `approvedContentKey` alone, and `holdsGrantFor` compares only that stored key — it never reads `status`. So the update window (file gone for the length of a reinstall, then back byte-identical) ends with the row re-armed and the person never asked again. **This is the property that makes a preserved file genuinely durable rather than merely present.**

Caveat worth pinning: the module TSDoc above `resolveFileArmStatus` still describes the retired status-inferred gate ("The grant … IS the row being `active` at content that has not changed since… A `paused` row does NOT hold a grant"), which contradicts the stored-key implementation two functions above it. Whichever is intended, the two must be made to agree before anything depends on F3 (see §8, U2).

**F4 — Extending the preserved set is a small, contained change.**
The set is two module constants and one 20-line `restorePreservedData`; `findInstallRootFromPreservedPath` derives the install root from the last `.dork` segment, so it already handles any `<installRoot>/.dork/<anything>` path. A third preserved path is roughly ten lines plus its tests and two documentation sentences (ADR-0233 §2, `contributing/marketplace-installs.md` §Data preservation).

**F5 — Anything durable placed inside the install root is claimed by `isPackageOwned` limb 3.**
Limb 3 is "the file is under the owning agent's directory AND that directory carries a package marker". A user schedule at `<installRoot>/.dork/anything/` satisfies both. Without an explicit carve-out, a person would be able to _create_ their schedule and then be refused when they try to _edit_ it — the exact "reads as untrue about a file they just made" failure DOR-1789's own review called out.

## 4) Candidates

Six, evaluated against the ticket's six axes. `A*` = inside the checkout, preserved; `B*` = outside the checkout; `C*` = change the agent instead.

| #      | Where the file lives                                                                                        | Discovery / sweep                                                                                                                          | Update                                                                                                                            | Uninstall                                     | `agentId` stability                                               | Collides with author's?                       | Verdict                       |
| ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- | ----------------------------- |
| **A1** | `<installRoot>/.dork/schedules/<slug>/SKILL.md`, a new **preserved** path and a second per-agent `TaskRoot` | Correct by construction: the root carries `agentId` + `projectPath`, so the sweep re-stamps the right agent and never re-homes             | Preserved; F3 keeps the approval                                                                                                  | Deleted with the agent — correct              | **Unsolved by itself** — needs D2                                 | No (separate directory; slug guard at create) | **Recommended**               |
| A2     | `<installRoot>/.dork/data/skills/…`, reusing the existing preserved path                                    | Same as A1                                                                                                                                 | Preserved with **zero** new machinery                                                                                             | Same as A1                                    | Same as A1                                                        | Same as A1, plus a package could write there  | Fallback                      |
| A3     | Marked user files left in `<agentDir>/.agents/skills/`, added to the preserved set per-file                 | Same as A1 (already the agent's root)                                                                                                      | Needs a content scan + a merge into a tree the new version also writes; the marker is a frontmatter key any author can also write | Same as A1                                    | Same as A1                                                        | **Yes** — same directory, same slug space     | Rejected                      |
| B1     | `<dorkHome>/agent-schedules/<key>/…`, a new root outside every checkout                                     | Correct **if** the root carries `agentId`                                                                                                  | Untouched by the update                                                                                                           | **Orphans** unless a teardown hook deletes it | Needs a stable key that is _not_ `agentId` (package name + scope) | No                                            | Rejected; revisit only for U1 |
| B2     | Rows in SQLite / `config.json`, no file at all                                                              | Contradicts ADR `260823-200724`; the reconciler retires a file-less row after a 24h grace                                                  | n/a                                                                                                                               | n/a                                           | n/a                                                               | n/a                                           | Rejected                      |
| B3     | The global skills root, keeping `agentId` on the row (the reviewer's cut-off)                               | **Breaks.** `upsertFromFile` is handed `root.agentId`, which is `undefined` for the global root, and writes `agentId: null` on every sweep | n/a                                                                                                                               | n/a                                           | n/a                                                               | n/a                                           | Rejected — confirmed          |
| C1     | Clone the package agent into a plain agent the person owns                                                  | Fine — an ordinary agent                                                                                                                   | The clone stops receiving updates entirely                                                                                        | n/a                                           | Fine                                                              | n/a                                           | Rejected as _this_ answer     |

**Notes on the rejections.**

- **B3 is exactly as broken as the reviewer said, and the mechanism is worth recording**: attribution lives on the `TaskRoot`, not on the row, and every sweep rewrites the row from the root. A row hand-set to an `agentId` in a global-root file is corrected to `null` within five minutes. This is not a bug to fix; it is the invariant that makes "first root wins" coherent.
- **B1 is the honest answer to a different question** — "should a schedule survive _uninstalling_ the agent?" — and its cost is real: a file that lives nowhere near the agent, keyed by something that is not the agent's id, needing its own teardown hook to avoid becoming a cron for a package that is gone. The person's mental model is "this belongs to that agent"; the disk should say so.
- **C1 is a legitimate product idea and not a substitute.** "I want to customise this agent" and "I want to give this agent a nightly job" are different wants; answering the second by forking the agent trades away every future update. Record it as its own capture, do not build it here.
- **A2 versus A1** is the only close call. A2 costs nothing in the installer and keeps ADR-0233's sentence true as written. A1 costs ten lines and buys a directory that says what it is: `.dork/data/` is documented as _the package's_ data, so a package may legitimately write `.dork/data/skills/` itself, and DorkOS silently sharing that namespace is the kind of ambiguity that becomes a support thread. Take A1; take A2 only if the operator would rather not touch the preserve contract at all (§7 Q1).

## 5) Decisions

### D1 — The durable home is `<installRoot>/.dork/schedules/`: a third preserved path, and a second task root per agent.

`agentTaskRoots(projectPath, agentId)` returns a second entry — `{dir: <projectPath>/.dork/schedules, scope: 'project', projectPath, agentId}` — for **every** agent, not only package ones. One rule beats two: a hand-made agent gets a directory that is simply empty, and nothing anywhere has to ask "is this agent a package?" to know where to look. `uninstall.ts` gains a third preserved subpath beside `DATA_SUBPATH` and `SECRETS_SUBPATH`.

Why inside the install root rather than outside it: the schedule belongs to _this_ agent, an uninstall should take it, and the preservation mechanism that has to survive the update already exists and is already tested. Why not `.agents/skills/`: that tree is the package's to replace wholesale, and merging into it is the A3 trap.

### D2 — A package agent's id must be stable across a package update. This is a precondition, not a nicety.

Per F1, a schedule that survives the update still cannot run afterwards. `applyUpdate` already reads the install root before it removes it; it should capture the existing `.dork/agent.json` `id` and hand it to the reinstall, so `createAgentWorkspace` reuses it instead of minting a new ULID. The fix is small and local, and it is worth its own ticket because it fixes far more than schedules — anything keyed on an agent's id (room membership, memories, relay endpoints, standing grants, the mesh row itself) is silently re-keyed by every package update today.

**Sequencing:** D2 lands first. D1 without D2 produces a schedule that survives on disk and fails at fire time — a worse lie than the current refusal.

### D3 — `isPackageOwned` learns one user-owned exception, and the create refusal becomes a redirect.

`.dork/schedules/` under an install root is DorkOS's, not the package's: no update overwrites it, so the reasoning behind every limb of `isPackageOwned` simply does not apply. The predicate gains an early "this path is the user's" answer, checked before the three ownership limbs. `create-task.ts` stops refusing on `isPackageOwnedAgent` and instead resolves `home.skillsDir` to the durable root for a package-owned agent. The **update** refusal stays exactly as it is for author-shipped files — editing a package's own schedule is still not ours to do.

### D4 — Author-shipped and user-made schedules stay separate, and a slug may not exist in both of an agent's roots.

They are two files, so they are two rows, and identity being the resolved path means nothing merges. The one hazard is presentation: two rows with the same display name under one agent. `create-task.ts` already refuses a slug that exists in the target directory; extend that check to the agent's other root, with a message that says the package already ships a schedule by that name.

### D5 — The advice the refusal gives has to become true, and that is its own ticket.

Per F2, the manifest `schedules[]` slot cannot produce a schedule filed under an installed agent package by any of its three declared forms. Either make it work (teach `resolveSkillsRoot` and `SKILL_SEARCH_DIRS` about an agent install's own root) or refuse it at publish-time validation with a message naming the working alternative. Until one of those lands, no user-facing copy should tell a person to ask the author for a manifest-declared schedule.

## 6) Implementation sketch (sized for follow-up tickets)

**T1 — A package agent keeps its id across an update.** _(precondition; server + marketplace)_
`applyUpdate` reads `<installRoot>/.dork/agent.json` before step 2 and threads the id through `install()` → `AgentInstallFlow.install` → `createAgentWorkspace({id})`; `CreateAgentOptionsSchema` gains an optional `id` used only on that path. **Red-before:** update an installed agent package and assert `.dork/agent.json`'s `id` is unchanged, and that a task row filed under it still resolves through `meshCore.getProjectPath`. A second test asserts the watched root's `agentId` still matches after re-registration.

**T2 — `.dork/schedules/` survives an update.** _(marketplace)_
Add `SCHEDULES_SUBPATH` beside `DATA_SUBPATH`/`SECRETS_SUBPATH`; `restorePreservedData` copies it like `.dork/data/`. Update ADR-0233 §2 and `contributing/marketplace-installs.md` §Data preservation, both of which enumerate the preserved set in prose. **Red-before:** a file at `<installRoot>/.dork/schedules/x/SKILL.md` survives `update()`, is removed by `purge: true`, and is restored to the original location when the reinstall half fails.

**T3 — Discovery watches the durable root.** _(server/tasks)_
`agentTaskRoots` returns the second root; `attachAgentRoots` and the `onUnregister` teardown already iterate the list, so nothing else changes signature. `create-task.ts` resolves a package-owned agent's `skillsDir` to it. **Red-before:** a schedule created for an installed agent package lands in `.dork/schedules/`, discovery gives it that agent's `agentId`, and a sweep does not re-home it. Plus the D4 cross-root slug refusal.

**T4 — Ownership and copy.** _(server/tasks + client)_
The `isPackageOwned` user-owned carve-out; the create refusal removed; the update refusal's message reworded to point at "make your own schedule for this agent" now that there is one. Client: `schedule_package_owned` on an edit gets a real affordance instead of a raw error string — the honest one is a **"Make my own copy"** action that creates a new schedule for the same agent from the package schedule's prompt and cron. **Red-before:** editing an author-shipped schedule still 409s; editing a user-made one under the same agent succeeds.

**T5 — Make `schedules[]` honest for agent packages.** _(separate, from F2/D5)_
Either extend `resolveSkillsRoot`/`SKILL_SEARCH_DIRS` to an agent install's own `.agents/skills/`, or refuse the declaration at publish-time validation. Independent of T1-T4; do not block them on it.

**Ordering:** T1 → T2 → T3 → T4. T5 any time.

**What the refusal message becomes.** Create stops refusing. The edit refusal becomes, in the register the repo uses: _"This schedule came with the agent's package, so DorkOS did not change it — the package's next update would put the old version back. You can switch it on or off here, or make your own copy to change what it does."_ Final wording is the `writing-for-humans` pass at T4.

## 7) Open questions for the operator

- **Q1 — New preserved path, or reuse `.dork/data/`?** D1 takes the new `.dork/schedules/` (A1) for namespace honesty at the cost of touching the preserve contract and two documents. A2 is free but shares a directory documented as the package's own. Answering "A2" changes only the path constant in T2/T3.
- **Q2 — Should a person's schedule survive _uninstalling_ the agent?** D1 says no: the agent is gone, its work goes with it, and the uninstall is already the place where a person says so. If the answer is yes, the durable home has to move outside the checkout (B1) and needs a stable key that is not `agentId` — a materially bigger design.
- **Q3 — Should a schedule under `.dork/schedules/` also be invocable as a skill?** Today only `.agents/skills/` is projected to the harnesses, so a durable schedule is a schedule and not a skill the agent can run by hand. Harness Sync could symlink it into `.agents/skills/<slug>` — harmless for discovery, since both roots carry the same `agentId` and the resolved path dedupes the row — but it is extra surface and not needed for the acceptance criterion.
- **Q4 — Is T1 (stable agent id) in this programme or its own?** It is a precondition either way. It has consequences well beyond schedules, so it may deserve its own ticket, its own ADR, and a sweep for other things silently re-keyed by a package update.

## 8) Uncertainty register

- **U1 — F1 is a code reading, not an executed test.** The chain (`applyUpdate` removes the root → preserved set excludes `.dork/agent.json` → `createAgentWorkspace` under `skipTemplateDownload` mints a fresh `ulid()` → mesh reads it as a branch swap) is unambiguous in the source and no test in `apps/server/src/services/marketplace/__tests__/` asserts either behaviour. **Evidence bar before building on it:** install an agent package, record its id, run `update()`, read `.dork/agent.json` again. That test is the first thing T1 writes, and it is red-before by construction.
- **U2 — F3 rests on an implementation that its own module TSDoc contradicts.** `holdsGrantFor` reads only the stored `approvedContentKey`; the paragraph above `resolveFileArmStatus` still describes the retired status-inferred gate and asserts a paused row holds no grant. If the _prose_ is the intent, a preserved file re-parks after every update and D1 delivers a schedule that survives but has to be re-approved each time — still better than today, but a different promise. Settle which is intended before T2, and make the code and the comment agree.
- **U3 — F2's fourth row (shipping `.agents/skills/<slug>/SKILL.md` directly) is inferred from the install copying package contents verbatim.** Nothing was executed. It matters only to D5/T5, not to the recommendation.
- **U4 — The stale-root `agentId` half of F1** (`addRoot` dedupes by directory, so a re-registered agent keeps the old root's id until restart) follows from reading `attach-task-roots.ts` and `TaskReconciler.addRoot`. If T1 lands, the cached id is correct and the question is moot — which is a reason to do T1 rather than to guard the root.
- **U5 — No measurement of how many alpha installs have agent packages with schedules today.** The design assumes the population is small enough that no migration is owed: existing rows filed under a package agent are already broken by F1, so there is nothing working to preserve. If that turns out to be wrong, T3 needs a one-time pass that re-points surviving rows.
