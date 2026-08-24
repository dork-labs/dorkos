---
id: 260823-194809
title: Universal scheduled tasks — any skill can be scheduled
status: ideation
created: 2026-08-23
---

# Universal scheduled tasks — any skill can be scheduled

**Slug:** universal-scheduled-tasks
**Author:** Dorian + Claude (ideation session 2026-08-23)
**Date:** 2026-08-23

---

## 1) Intent & Assumptions

- **Task brief:** Make the scheduled-tasks (Pulse) system universal and compatible with the existing skills/plugins ecosystem. Being scheduled becomes a **property in the file** (a `schedule:` frontmatter block), not a **place on disk**. Retire the special task directories (`~/.dork/tasks/`, `<project>/.dork/tasks/`) so any skill in any scanned skills directory can be a scheduled task, any scheduled task is simultaneously a usable skill, and marketplace packages of every type can ship schedules. Unify skill/command/schedule frontmatter with Claude Code's current dialect (commands merged into skills; frontmatter controls invocation). Rename user-facing language from "Tasks" to "Scheduled tasks" / "Schedules".
- **Assumptions:**
  - We are pre-launch alpha; breaking changes are acceptable. The only holders of old-format files are alpha users' `~/.dork/tasks/` dirs and the two marketplace packages we control (`flow`, `linear-ops`).
  - The existing task file format is already a valid skill: `TaskFrontmatterSchema` extends `SkillFrontmatterSchema` (`packages/skills/src/task-schema.ts:40-101`), and Zod strip semantics + YAML parsers elsewhere ignore unknown keys. The `flow` plugin already ships cron frontmatter inside plain `skills/` dirs.
  - The scheduler keeps its existing runtime spine: croner + production gate + leader lock + dispatch-dedup log + permission clamp + `pending_approval` parking (ADR-0285, ADR 260821-190444). This spec changes discovery, format, and language — not the firing machinery.
  - The code-review findings from the 2026-08-23 tasks-subsystem review are tracked separately; D1 (watcher never updates the scheduler) and D2 (unvalidated cron kills boot) are **prerequisites** for this work (see §7 Dependencies).
- **Out of scope:**
  - Fixing the full defect list from the code review (separate tickets; only D1/D2 block this spec).
  - Renaming the REST API (`/api/tasks`), MCP tool names, or the `pulse*` DB tables — user-facing language only in this pass.
  - Claude Code's own session-scoped scheduling (`/loop`, CronCreate) — unrelated machinery; we only add a docs positioning line.
  - Migrating the `flow` plugin's 13 `commands/*.md` files to skills-with-frontmatter (follow-up marketplace chore).

## 2) Pre-reading Log

- `agentskills.io/specification` — a skill = a directory with `SKILL.md`; frontmatter fields are `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. The **only sanctioned extension point is `metadata`, a string→string map** — too cramped for a structured schedule block. The spec does not govern parent-directory layout or discovery; `name` must match the parent directory name.
- `code.claude.com/docs/en/skills.md` — **"Custom commands have been merged into skills."** `.claude/commands/` still works but is legacy. Claude Code supports 13 frontmatter fields: the 6 spec fields + 7 extensions: `disable-model-invocation` (default false), `user-invocable` (default true), `disallowed-tools`, `paths`, `arguments`, `shell`, `context: fork` + `background`. Invocation matrix: default = both user and model can invoke; `disable-model-invocation: true` = person-only; `user-invocable: false` = model-only; both-off is impossible via frontmatter (use `skillOverrides` setting).
- `code.claude.com/docs/en/scheduled-tasks.md` — Claude Code's own scheduling is session-scoped (`/loop`, cron tools; dies with the terminal). As of v2.1.196 its scheduler refuses to run skills with `disable-model-invocation: true` via model invocation.
- `apps/server/src/services/tasks/*` — full architecture trace (2026-08-23): SKILL.md file → chokidar watcher (`task-file-watcher.ts`) + 5-min reconciler (`task-reconciler.ts`) → SQLite derived cache (`task-store.ts`, file-first) → croner scheduler (`task-scheduler-service.ts`) with prod gate / leader lock / dispatch dedup → ClaudeCodeRuntime unattended session. Permission clamp: `schedule-permission-clamp.ts` (file content can never introduce `bypassPermissions`; grants keyed on prompt+cron content). Approval: agent-proposed schedules park `pending_approval` (routes/tasks.ts).
- `packages/harness/src/scan/scanner.ts:60-71`, `packages/skills/src/scanner.ts:151-224` — **all skill scanners look exactly one level deep** (`skills/<name>/SKILL.md`). Nothing in the repo nests deeper. Namespacing (`flow__flow-drain`) is a flat symlink-name convention from the installed projector (`packages/harness/src/plan/installed-projector.ts:410-467`), never path nesting.
- `packages/harness/src/sources/resolve-roots.ts:38-40` — `.agents/skills/` is the sole authored source root. `.claude/skills/` is a projection target (symlinks). Installed plugin skills live at `.dork/plugins/<pkg>/skills/` and project as `<pkg>__<name>` symlinks into both. **There is no global `~/.dork/skills/`** — dorkHome has `tasks/`, `agents/`, `relay/`, etc., but no skills root.
- `packages/skills/src/command-schema.ts` — `CommandFrontmatterSchema` already adopts most Claude Code extension names (`argument-hint`, `disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `model`, `effort`); missing `paths`, `arguments`, `disallowed-tools`, `shell`, `background`.
- `packages/marketplace/src/manifest-schema.ts` — only `type: "shape"` packages have a first-class `schedules` slot (`ShapeScheduleSchema`, ~line 276-320; `startEnabled` default false; `startDisabled` retired per DOR-607). Plugin/agent/skill-pack/adapter manifests have none.
- Marketplace repo (`dork-labs/marketplace`): `flow` ships `skills/flow-drain/SKILL.md` (hourly, `enabled: false`) and `skills/flow-groom/SKILL.md` (monthly, `enabled: false`) with top-level cron frontmatter. `linear-ops` (shape) declares a 15-min `inbox-tick` in its manifest but uses retired `startDisabled: false` — resolves to disabled at apply time (drift bug, fix regardless).
- `decisions/0220-adopt-skill-md-open-standard.md`, `decisions/0285-…`, `decisions/260821-190444-a-proposed-schedule-carries-its-own-case.md`, `decisions/0295-flow-autonomy-bring-your-own-scheduler.md`, `contributing/configuration.md` (semver-keyed `conf` migrations).

## 3) Codebase Map

- **Primary components:**
  - `apps/server/src/services/tasks/` — scheduler, store, watcher, reconciler, clamp, provenance (19 modules). Discovery roots wired in `apps/server/src/index.ts:2104-2143`.
  - `packages/skills/src/` — `schema.ts` (base), `task-schema.ts` (schedule superset), `command-schema.ts` (command superset), `scanner.ts`, `writer.ts`. This package becomes the home of the unified schema.
  - `packages/harness/` — source-root resolution + projection (symlinks, namespacing, command wrappers).
  - `packages/marketplace/src/manifest-schema.ts` — `schedules` slot (shape-only today).
  - `apps/client/src/layers/{entities,features,widgets}/tasks/` — `/tasks` page, approval card, run history.
  - `apps/server/src/services/runtimes/codex/scan-skill-commands.ts` — Codex slash-palette from `.agents/skills/`.
  - `docs/guides/task-scheduler.mdx`, marketplace `docs/bring-your-own-scheduler.mdx`.
- **Data flow (target):** `SKILL.md` with `schedule:` block in a scanned skills root → watcher/reconciler → clamp + arm-approval check → SQLite cache → croner → unattended run → SSE/UI. Same as today except the roots and the format.
- **Blast radius:** tasks service discovery + schema, skills package schemas, harness projection (dedup by realpath), marketplace manifest + apply step, both marketplace packages, client tasks feature (naming + provenance display), docs, onboarding templates/presets.

## 4) Research — options weighed

1. **Where schedule metadata lives**
   - a) Keep today's loose top-level fields (`cron`, `enabled`, `permissions`…) — works, but `enabled`/`permissions` become ambiguous in a file that is _also_ a normal skill (disable the skill or the schedule?).
   - b) Spec-pure `metadata:` map — string-only values; a structured schedule doesn't fit; ugly flat keys.
   - c) **Top-level `schedule:` block (chosen)** — presence = schedulable; unambiguous sub-fields (`cron`, `timezone`, `enabled`, `max-runtime`, `permissions`, optional `prompt` override); technically spec-unknown but universally ignored by other parsers — the same trade Claude Code made with its own 7 extensions.
2. **`skills/scheduled/` subdirectory** — rejected. Every scanner that matters (DorkOS harness + skills scanners, Claude Code itself) reads exactly one level deep; a nested skill is invisible to all harnesses, silently re-creating the special directory this spec exists to kill. One flat namespace; group in the UI by presence of `schedule:`, not by path.
3. **Which roots the scheduler watches**
   - Per project: `<project>/.agents/skills/` only (canonical root; installed plugin skills already appear there as `pkg__name` symlinks — dedup by `realpath`). Never watch `.claude/skills/` (mirror; would double-count).
   - Global: no skills root exists under dorkHome today. Options: (a) **create `~/.dork/skills/` (recommended)** — consistent "everything is a skill" story, usable by DorkBot; (b) keep `~/.dork/tasks/` as the global home — less work but preserves the special-dir concept forever. **Open decision — leaning (a).**
4. **Frontmatter dialect for cross-runtime robustness** — adopt Claude Code's extension fields **verbatim** (names + semantics) into one unified `SkillFrontmatterSchema`; do not invent DorkOS synonyms. Claude Code honors them natively; Codex/OpenCode don't read frontmatter, but DorkOS composes their skill lists and command palettes, so **our runtime adapters enforce the fields for them** (e.g. `scan-skill-commands.ts` skips `user-invocable: false`; model-facing lists respect `disable-model-invocation`). The file is the standard; each runtime gets it enforced either natively (CC) or by the adapter (Codex/OpenCode).
5. **Migration strategy** — clean break vs deprecation window: see Decision 3. Mechanism: **state-driven, idempotent boot migration**, not version-keyed. On every boot, detection runs: legacy dirs containing task files, or files with legacy top-level `cron:` fields, trigger an in-place atomic rewrite to the `schedule:` block + relocation to the new roots. Detection-on-state means **version skippers are safe by construction** — someone jumping v0.58 → v0.70 hits the same detector; there is no "you must pass through release N" as long as the migration code exists. When nothing legacy exists, the detector no-ops in microseconds.
   - **Grant preservation trap:** approval grants (`bypassPermissions` keep-grants and the new arm-approvals) are keyed on file _content_ (prompt+cron). Rewriting frontmatter changes content, so a naive migration un-approves every approved schedule. The migration must re-key stored grants in the same step it rewrites each file.
   - **Sunset policy for the migration code:** keep it in one dedicated module with a header naming its removal condition; open a Linear ticket at ship time with a target removal date (~6 months / by 1.0). After removal, the **migration floor** is documented in release notes: "coming from < vX? install vX once first" — the standard escape hatch for anyone who out-skips the window. An old-format file found after removal parks with a clear UI warning rather than silently breaking.
6. **Schedule-only skills and invocation flags** — a schedule-only item may set `disable-model-invocation: true`: the model won't spontaneously trigger the nightly routine, but a person can still run `/name` — the CLI twin of the cockpit's "Run it once" affordance. Gotcha to document: that flag must go on the _scheduled_ skill itself, not on skills the schedule's prompt asks the agent to _use_ (Claude Code refuses model-invocation of flagged skills). `schedule.prompt` override covers bodies written skill-style ("when asked, do X") and skills that expect `$ARGUMENTS`.
7. **Safety model for open discovery** — today only two blessed dirs can arm schedules; opening every skills root means a `git pull`, plugin install, or agent-authored skill can plant a cron. Mitigations (both required):
   - **File-discovered schedules never auto-arm.** First sighting of new schedule content lands `pending_approval` (existing approval card). Approval is a content-keyed grant that survives re-syncs of identical content — the exact mechanism already shipped for `bypassPermissions` clamping, extended to arming. `schedule.enabled` remains author intent; `status` remains operator approval — the two axes already exist.
   - **The clamp stays:** file content can never introduce `bypassPermissions`; content edits drop existing grants (already shipped, extends unchanged).
8. **Marketplace impact**
   - `flow`: zero file moves — its two schedulable skills are already skills; they get discovered automatically post-install (as `flow__flow-drain` etc. in `.agents/skills/`); `enabled: false` + never-auto-arm compose cleanly. Frontmatter migrates to `schedule:` block in the same release. `docs/bring-your-own-scheduler.mdx` mostly deletes.
   - `linear-ops`: manifest `schedules` entries **materialize as skill files** at shape-apply time (written into the project's `.agents/skills/`, stamped `origin: shape`), making skill-files-on-disk the single runtime mechanism; the manifest stays as an authoring convenience. Fix the `startDisabled`→`startEnabled` drift regardless (under the new model the bug class disappears — arming lives in DorkOS approval state, not the package).
   - The "tasks" layer opens to **all** package types, not just shapes; five stub packages currently claiming it can actually ship one.

## 5) Recommendation

Adopt the `schedule:` frontmatter block as the sole marker of schedulability; scan `.agents/skills/` per project plus a new `~/.dork/skills/` global root; never auto-arm file-discovered schedules; unify the skills/command schemas on Claude Code's field dialect with runtime adapters enforcing invocation flags for Codex/OpenCode; clean-break migrate via a state-driven idempotent boot migration that re-keys approval grants, with a documented sunset (~6 months / 1.0) and migration floor; rename user-facing surfaces to "Scheduled tasks" (full) / "Schedules" (short).

**Sequencing:**

1. Prereqs: fix code-review D1 (`TaskRegistrar` seam: every writer — watcher, reconciler, both routes — updates the scheduler) and D2 (cron/timezone validation at every schema boundary; `registerTask` never throws per-task).
2. Unified schema: merge `SkillFrontmatterSchema`/`CommandFrontmatterSchema`/`TaskFrontmatterSchema` into one CC-dialect schema + `schedule:` block in `@dorkos/skills`.
3. Discovery: point watcher/reconciler at the skills roots (realpath dedup; keep `templates/` reservation story for the template gallery), create `~/.dork/skills/`, wire the arm-approval default.
4. Migration module + grant re-keying + sunset ticket.
5. Marketplace: manifest schema opens `schedules` to all types + shape-apply materializes skill files; bump `flow` and `linear-ops` same day.
6. Language pass: UI nav, page, docs (`task-scheduler.mdx` rewrite around "schedule any skill"), MCP tool descriptions; leave REST paths and DB names alone.

## 6) Decisions

| #   | Decision                          | Choice                                                                                 | Rationale                                                                                                                                                     |
| --- | --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Schedule marker                   | Top-level `schedule:` frontmatter block; presence = schedulable                        | Location-independence is the goal; block form kills `enabled`/`permissions` ambiguity; `metadata` is string-only; unknown keys ignored everywhere             |
| 2   | `skills/scheduled/` subdirectory  | No — one flat namespace                                                                | Every scanner (ours + Claude Code) reads one level deep; nesting hides skills and re-creates a special dir (user confirmed 2026-08-23)                        |
| 3   | Migration                         | Clean break, one release; no dual-format window                                        | Pre-launch alpha, tiny install base, we control both affected packages; state-driven detector keeps version skippers safe (user leaning confirmed 2026-08-23) |
| 4   | Frontmatter dialect               | Claude Code's extension fields verbatim, on the agentskills.io base                    | Commands merged into skills upstream; CC is the de-facto superset dialect; our schemas already half-adopted it; adapters enforce for Codex/OpenCode           |
| 5   | Language                          | "Scheduled tasks" full, prefer "scheduled"-rooted single word ("Schedules")            | User preference 2026-08-23; also disambiguates from the unrelated BackgroundTask/subagent system                                                              |
| 6   | Global home for one-off schedules | **OPEN** — leaning new `~/.dork/skills/` over keeping `~/.dork/tasks/`                 | Consistent "everything is a skill"; needs confirmation before SPECIFY freezes it                                                                              |
| 7   | Migration sunset                  | **OPEN** — proposed ~6 months / by 1.0, tracked by ticket + documented migration floor | Needs a concrete date at SPECIFY time                                                                                                                         |

**Next step:** SPECIFY (`/flow:specify universal-scheduled-tasks`) once Decisions 6-7 are confirmed.
