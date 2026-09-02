---
id: 260823-194809
title: Universal scheduled tasks — any skill can be scheduled
status: implemented
created: 2026-08-23
---

# Universal scheduled tasks — any skill can be scheduled

**Status:** Approved
**Author:** Dorian + Claude (specified autonomously under operator delegation, 2026-08-23)
**Date:** 2026-08-23

## Overview

Being scheduled becomes a property in the file, not a place on disk. Any skill in any scanned skills root can carry a top-level `schedule:` frontmatter block and become a scheduled task; every scheduled task is simultaneously a normal skill. The special task directories (`~/.dork/tasks/`, `<project>/.dork/tasks/`) are retired via a state-driven, idempotent boot migration. Skill/command/schedule frontmatter unifies on Claude Code's current dialect (commands merged into skills; frontmatter controls invocation), with DorkOS runtime adapters enforcing the invocation fields for Codex/OpenCode. User-facing language renames from "Tasks" to "Scheduled tasks" / "Schedules".

## Background / Problem Statement

Today a scheduled task must live at `<tasksDir>/<slug>/SKILL.md` under one of two blessed roots wired at boot (`apps/server/src/index.ts:2104-2143`). The file format is already a strict superset of a skill (`TaskFrontmatterSchema extends SkillFrontmatterSchema`), and the `flow` marketplace plugin already ships cron frontmatter inside plain `skills/` dirs that DorkOS cannot discover without a hand-copied file. Meanwhile Claude Code merged commands into skills with invocation-control frontmatter, and our schema layer (`packages/skills/src/command-schema.ts`) only half-tracks that dialect. The location requirement blocks the ecosystem goal: existing skills cannot become schedules, marketplace packages other than shapes cannot ship schedules, and the word "Tasks" collides with the unrelated BackgroundTask/subagent system.

## Goals

- A `schedule:` frontmatter block on any discovered skill makes it a scheduled task; removing the block makes it a plain skill again.
- Scheduler discovery covers `<project>/.agents/skills/` (per registered agent, realpath-deduped, `.claude/skills/` never watched) and a new global `~/.dork/skills/`.
- File-discovered schedules never auto-arm: first sighting of new schedule content parks `pending_approval`; operator approval is a content-keyed grant that survives re-syncs of identical content (same mechanism as the existing `bypassPermissions` keep-grant).
- One unified `SkillFrontmatterSchema` in `@dorkos/skills`: agentskills.io base + Claude Code's extension fields verbatim (`disable-model-invocation`, `user-invocable`, `disallowed-tools`, `paths`, `arguments`, `shell`, `context: fork`, `background`) + the DorkOS `schedule:` block. `TaskFrontmatterSchema` and `CommandFrontmatterSchema` fold into it.
- Runtime adapters enforce invocation fields where the runtime does not: Codex slash palette (`scan-skill-commands.ts`) skips `user-invocable: false`; model-facing skill lists respect `disable-model-invocation`.
- Clean break: a state-driven idempotent boot migration rewrites legacy files (top-level `cron:` fields and/or files under legacy `tasks/` dirs) to the new format and relocates them; approval grants are re-keyed in the same step; the legacy parser is deleted.
- Marketplace: the `schedules` slot opens beyond shapes — plugin packages ship schedulable skills natively; shape-apply materializes manifest `schedules` as skill files stamped `origin: shape`.
- Rename user-facing surfaces: "Scheduled tasks" (full), "Schedules" (short).

## Non-Goals

- Renaming REST paths (`/api/tasks`), MCP tool names' wire ids, or `pulse*` DB tables (descriptions/labels may change; identifiers do not).
- Changing the firing machinery (croner, prod gate, leader lock, dispatch dedup) beyond the D1/D2 prerequisite fixes tracked separately.
- Claude Code's own session-scoped scheduling (`/loop`, CronCreate) — one docs positioning line only.
- Migrating the `flow` plugin's `commands/*.md` files to skills (follow-up chore).
- Fixing the 2026-08-23 code-review defects D3–D13 (separate tracker issues; D1/D2 are prerequisites, also separate).

## Technical Dependencies

- `croner` (already in use) — cron parse/validation source of truth (`new Cron(expr, { timezone })` in a try/catch is the validator).
- `gray-matter` via `packages/skills/src/writer.ts` — atomic frontmatter rewrite for migration.
- `chokidar` v4 (no glob) — watcher; existing `depth: 1` pattern retained per root.
- Claude Code skills dialect: https://code.claude.com/docs/en/skills.md ; agentskills.io spec: https://agentskills.io/specification .
- Prerequisites (must merge first): **D1** — a `TaskRegistrar` seam so every writer (watcher, reconciler, both routes) updates the scheduler; **D2** — cron/timezone validation at every schema boundary and per-task containment in `TaskSchedulerService.start()`.

## Detailed Design

### 1. Unified frontmatter schema (`packages/skills`)

`SkillFrontmatterSchema` becomes the single schema:

```yaml
---
name: daily-health-check # agentskills.io base (unchanged)
description: …
license: … # optional
compatibility: … # optional
metadata: { … } # optional, string→string
allowed-tools: … # optional
# Claude Code extensions, adopted verbatim:
disable-model-invocation: false # optional
user-invocable: true # optional
disallowed-tools: … # optional
paths: … # optional
arguments: [a, b] # optional
shell: bash # optional
context: fork # optional
background: true # optional (only with context: fork)
model: … # existing DorkOS-recognized extension
effort: … # existing DorkOS-recognized extension
argument-hint: … # legacy commands-era hint, kept
# DorkOS extension — presence makes the skill a scheduled task:
schedule:
  cron: '0 9 * * 1-5' # optional; absent = on-demand schedule
  timezone: UTC # default UTC
  enabled: true # author intent; default true
  max-runtime: 30m # optional duration
  permissions: acceptEdits # TASK_PERMISSION_MODES; default acceptEdits
  prompt: … # optional override sent on fire; default = body
---
```

- `ScheduleBlockSchema` (new) with `cron` validated by attempting `new Cron(cron, { timezone })` in a Zod `superRefine`; `timezone` validated the same way.
- `TaskFrontmatterSchema` is deleted; `CommandFrontmatterSchema` is deleted; both re-exports removed after all consumers move. Legacy top-level task fields (`cron`, `timezone`, `enabled`, `max-runtime`, `permissions`, `display-name`, `origin`, `shape`) are **not** accepted by the new schema — the migration rewrites them (see §4). `display-name` survives as a base-schema optional (it predates this work in task files; keep it for all skills). `origin`/`shape` provenance moves into `schedule.origin` / `schedule.shape`.
- `kind` field: retained; DorkOS surfaces may use `kind: task` to filter schedule-only items from skill pickers. Not required for correctness.

### 2. Discovery (`apps/server`)

- `TaskFileWatcher`/`TaskReconciler` roots change from `<root>/tasks/` to skills roots:
  - Global: `<dorkHome>/skills/` (created on boot; new).
  - Per registered agent: `<projectPath>/.agents/skills/`.
  - `.claude/skills/` is never watched. Entries are realpath-resolved; two paths resolving to the same real SKILL.md dedupe to one task identity (first root wins; identity is the resolved real path).
  - A discovered SKILL.md **without** a `schedule:` block is ignored by the tasks subsystem (not an error, not a row). A row whose file loses its `schedule:` block is retired through the existing pause → 24h grace → delete path.
  - Agents registered after boot get watchers attached at registration time (closing the boot-only gap noted in research); unregistration tears down, as today.
- Template gallery moves to `<dorkHome>/skills/templates/` (still reserved/excluded); `presets.json` and `scheduler.lock` stay under `<dorkHome>/tasks/` — that directory remains for system files only, never scanned for schedules after migration.
- Task identity: `pulse_schedules.file_path` stores the resolved real path; name collisions across roots are allowed and disambiguated in the UI by provenance (root + agent).

### 3. Arm-approval for file-discovered schedules

- `upsertFromFile` gains an arming gate parallel to the existing permission clamp (`schedule-permission-clamp.ts` pattern): a row created from a file whose schedule content (prompt+cron, same key as the bypass grant) has **no** stored approval grant lands `status: 'pending_approval'` with provenance `origin: file` — regardless of `schedule.enabled`.
- Operator approval (the existing PATCH `status: 'active'` transition) stores an arm grant keyed on content; re-syncs of identical content stay approved; content changes drop the grant and re-park (identical to bypass-grant semantics; shares the keying helper).
- Operator-created schedules via the cockpit/API arm immediately, as today (the route write is the approval).

### 4. Migration (clean break, state-driven)

New module `apps/server/src/services/tasks/legacy-migration.ts` (single file, header comment names the removal condition):

- Runs on every boot before watchers start. Detection: (a) legacy roots `<dorkHome>/tasks/*/SKILL.md` and `<project>/.dork/tasks/*/SKILL.md` for every registered agent; (b) any discovered file whose frontmatter carries legacy top-level `cron`/`enabled`/`permissions`/`max-runtime` task fields.
- For each hit: parse with a migration-local legacy schema (the only remaining copy of the old shape), rewrite to the `schedule:` block via the atomic writer, and move the directory to the corresponding new root (`<dorkHome>/tasks/<slug>/` → `<dorkHome>/skills/<slug>/`; `<project>/.dork/tasks/<slug>/` → `<project>/.agents/skills/<slug>/`; name collision at destination → suffix `-migrated`, log, and park with a warning).
- **Grant re-keying:** in the same pass, every stored content-keyed grant (bypass keep-grants; arm grants) for the old content is re-keyed to the rewritten content so approved schedules stay approved and armed across the upgrade. Migrated previously-active schedules do **not** re-park.
- Idempotent and version-free: no version checks; empty detection is a no-op. Version skippers hit the same detector.
- Unparseable legacy file: left in place, surfaced as a parked row with a UI warning naming the file.
- **Sunset:** removal condition = 6 months after ship (2027-02) or v1.0, whichever first; a tracker issue with that date is filed at ship time; after removal, release notes document the migration floor ("coming from < the shipping version: install it once first").

### 5. Runtime adapters honor invocation fields

- `apps/server/src/services/runtimes/codex/scan-skill-commands.ts`: skip skills with `user-invocable: false` from the palette; skills with `disable-model-invocation: true` are palette-visible but excluded from model-facing skill descriptions.
- Any DorkOS-composed skill list (MCP `dorkos://skills` resources, session prompt assembly) respects `disable-model-invocation` for model-facing listings.
- Claude Code runtime: no change (native support).
- Scheduled runs are unaffected by `disable-model-invocation` (DorkOS sends `schedule.prompt`/body directly as the message). Docs note the one gotcha: the flag on a skill that a schedule's prompt asks the agent to _use_ will block Claude Code from model-invoking it.

### 6. Marketplace (`packages/marketplace` + `dork-labs/marketplace` repo)

- `manifest-schema.ts`: `schedules` moves from shape-only to a shared manifest slot available to `plugin`, `agent`, `skill-pack`, and `shape`; schema entries reference a skill by name or inline `{prompt, cron, …}`. Shape-apply (and plugin install where declared) **materializes** each schedule as a skill file with a `schedule:` block, stamped `schedule.origin: shape|plugin` + package name, written into the project's `.agents/skills/`.
- Marketplace repo: `flow` — frontmatter of `skills/flow-drain/SKILL.md` + `skills/flow-groom/SKILL.md` migrates to the `schedule:` block (no file moves). `linear-ops` — drop retired `startDisabled`, rely on arm-approval (delete `startEnabled` reliance where redundant), regenerate against the new schema.
- Install-time validation uses the unified schema, so a package with an invalid cron fails validation at install, not at boot.

### 7. Language rename (user-facing only)

- Client: nav item + page title "Scheduled tasks"; short form "Schedules" where space-constrained; empty states, dialogs, toasts, approval card copy audited for bare "task(s)" (follow `writing-for-humans`).
- Docs: `docs/guides/task-scheduler.mdx` rewritten around "schedule any skill" (directories → frontmatter; approval model; migration note; positioning line vs Claude Code's session-scoped `/loop`). Marketplace `bring-your-own-scheduler.mdx` reduced to a pointer.
- MCP tool wire names unchanged; their `description` strings adopt the new language.

## User Experience

- **Turn a skill into a schedule:** add a `schedule:` block to any skill (by hand, via agent, or via the cockpit's editor); it appears on the Schedules page as `pending_approval` with provenance; approving arms it. Remove the block to turn it back into a plain skill.
- **Create from the cockpit:** unchanged flow; the file now lands in `.agents/skills/<name>/` (agent-bound) or `~/.dork/skills/<name>/` (global) and is immediately a real skill everywhere (Harness Sync projects it).
- **Upgrade:** on first boot after upgrade, legacy files are rewritten/moved silently; approved schedules stay approved; anything unparseable parks with a warning naming the file. No user action.
- **Error paths:** invalid cron in a hand-edited file → row parks with a validation warning (never crashes boot; D2); file deleted → existing pause/grace/delete; name collision → provenance-disambiguated rows.

## Testing Strategy

- **Unit:** `ScheduleBlockSchema` (valid/invalid cron+timezone incl. croner-rejected strings); legacy-migration rewrite (field mapping, `schedule.prompt` absence, origin/shape relocation, collision suffix, idempotent second run, unparseable file left+flagged); grant re-keying (approved stays approved; changed content re-parks); arm-gate in `upsertFromFile` (new content parks regardless of `enabled: true`; identical re-sync stays active); realpath dedup; watcher root changes; codex palette filtering (`user-invocable: false`, `disable-model-invocation`).
- **Integration:** boot with legacy `<dorkHome>/tasks/` fixture → migrated, armed, firing gate intact; end-to-end file-drop into `.agents/skills/` → parked row → approve via PATCH → registered cron (exercises the D1 registrar seam); shape-apply materializes a skill file that parks.
- **Existing suites:** `runtimeConformance` untouched; the tasks route/store/scheduler suites updated for new roots and schema; every test rendering changed client components re-run (per repo policy).
- **Mocking:** filesystem fixtures under temp dirs (existing pattern); croner real (cheap, deterministic for parse); no live-model tests.

## Performance Considerations

Watched roots grow from ≤ N+1 to ≤ N+1 (same count: one global + one per agent — the roots change, not the cardinality). Skills roots contain non-schedule skills; the watcher filter reads only `SKILL.md` files, and frontmatter parse of non-schedule skills is a fast reject (no `schedule:` key → ignore before full validation). Reconciler scan cost rises with skill count; the 5-minute cadence and one-level scan keep it trivial (< tens of files per root). Migration is a boot-time one-shot, O(legacy files).

## Security Considerations

- Opening discovery to skills roots is the key risk: a `git pull`, plugin install, or agent-authored skill can now plant a cron anywhere a skills root is watched. Mitigated by **never-auto-arm** (§3) layered on the existing clamp (file content can never introduce `bypassPermissions`; content edits drop grants). Both gates are content-keyed and share one helper, so they cannot drift.
- Migration re-keying must be transactional per file (rewrite + re-key together) so a crash mid-migration cannot leave an approved grant pointing at absent content (fails closed: grant lost → re-park, never grant-without-review).
- The trigger-route authorization gap (review defect D4) becomes more important once agents can author schedule files; it is tracked separately and should land in the same release wave.

## Documentation

`docs/guides/task-scheduler.mdx` (rewrite), marketplace `bring-your-own-scheduler.mdx` (reduce), `contributing/` guide touch-ups where task dirs are named, changelog fragments per PR (`writing-changelogs`), release-note migration/floor language at release time.

## Implementation Phases

- **Phase 1 — prerequisites (separate tracked fixes, merge first):** D1 TaskRegistrar seam; D2 validation + boot containment.
- **Phase 2 — unified schema:** `@dorkos/skills` merge + `ScheduleBlockSchema`; consumers compile.
- **Phase 3 — discovery + arm-approval:** new roots, realpath dedup, registration-time watcher attach, arm gate, template/preset relocation.
- **Phase 4 — migration:** `legacy-migration.ts`, grant re-keying, sunset ticket.
- **Phase 5 — marketplace:** manifest slot for all types, materialization at apply, `flow` + `linear-ops` package updates (marketplace repo).
- **Phase 6 — runtime adapters + language:** codex palette/skill-list filtering; UI + docs rename.

## Open Questions

- ~~Global home for one-off schedules~~ **(RESOLVED)** Answer: create `~/.dork/skills/`. Rationale: consistent "everything is a skill" story; usable by DorkBot; `~/.dork/tasks/` demoted to system files only (lock, presets). Resolved autonomously under operator delegation 2026-08-23.
- ~~Migration sunset~~ **(RESOLVED)** Answer: 6 months (2027-02) or v1.0, whichever first; tracked by ticket filed at ship time; migration floor documented at removal. Resolved autonomously under operator delegation 2026-08-23.

## Related ADRs

ADR-0220 (SKILL.md open standard — this spec is its logical completion), ADR-0285 (firing safety — unchanged), ADR 260821-190444 (proposed schedule carries its own case — arm-approval extends it), ADR-0295 (bring-your-own-scheduler — largely superseded by native discovery), ADR 260706-192819 (harness-native plugin delivery — projection mechanics reused), DOR-607 (`startDisabled` retirement). New draft ADRs seeded by this spec: schedule-as-frontmatter-property; never-auto-arm content grants; Claude-Code-dialect unified schema; state-driven version-free migration.

## References

- `specs/universal-scheduled-tasks/01-ideation.md` (full research trail, options weighed, decision table)
- 2026-08-23 tasks-subsystem code review (defects D1–D13; D1/D2 prerequisites)
- https://code.claude.com/docs/en/skills.md · https://code.claude.com/docs/en/scheduled-tasks.md · https://agentskills.io/specification
- Marketplace scan 2026-08-23: `flow` + `linear-ops` schedule usage; `manifest-schema.ts` `schedules` slot analysis
