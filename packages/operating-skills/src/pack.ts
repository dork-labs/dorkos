/**
 * The Operating DorkOS skill pack — the canonical, ordered list of first-party
 * skills that teach an agent how to run DorkOS, plus the pack version stamped
 * into every seeded file.
 *
 * @module pack
 */
import { operatingDorkos } from './skills/operating-dorkos.js';
import { managingAgents } from './skills/managing-agents.js';
import { schedulingTasks } from './skills/scheduling-tasks.js';
import { usingTheMarketplace } from './skills/using-the-marketplace.js';
import { readingActivity } from './skills/reading-activity.js';
import { answeringDorkosQuestions } from './skills/answering-dorkos-questions.js';

/** One authored skill in the pack: its kebab-case name, discovery description, and body. */
export interface OperatingSkill {
  /** Kebab-case skill name; also the directory name under `.agents/skills/`. */
  name: string;
  /** Frontmatter `description` — the string that triggers skill activation. */
  description: string;
  /** Markdown body written for models (ACI-style, imperative). */
  body: string;
}

/**
 * The pack content version. Bump this (integer, monotonic) whenever any skill
 * body or description changes so the seeder re-writes unmodified on-disk copies.
 * User-modified copies are never overwritten regardless of version.
 *
 * History:
 * - 1: initial pack (spec `agents-as-operators` §1.5).
 * - 2: capability self-description pointer (spec `capability-registry` §2.2).
 * - 3: permission tiers, the `approval_required` handshake, and `dorkos call`.
 *   Version 2 taught a pre-approval world: it never mentioned tiers, approvals,
 *   or the universal `dorkos call` path, and it told agents to look for
 *   `requires_confirmation` on `marketplace_uninstall`, which now returns the
 *   approval payload instead. Same round corrected the `config_patch` shape (the
 *   required `patch` wrapper) and the `ui.statusBar` example (a `pins` list, not
 *   per-item booleans).
 * - 4: `dorkos uninstall` is gated too (DOR-467). Version 3 told agents the CLI
 *   verb was "the person's ungated path" and to stay off it. That was true when
 *   written and is not any more: the route behind it now answers to the same
 *   approval gate, so the sentence had to stop describing a hole that is closed.
 * - 5: adding and removing a marketplace SOURCE is the person's, not the agent's
 *   (DOR-502). Version 4 taught `dorkos marketplace list|add|remove|refresh|
 *   validate` as five verbs an agent could run. Two of them now answer 403 with
 *   `operator_only_marketplace_source`, and no approval unlocks them, so the pack
 *   had to stop teaching a command that cannot work and start teaching what to ask
 *   the person for instead.
 * - 6: the pack stops calling a `destructive` tool ungated (DOR-509). Version 4
 *   told every agent that `tasks_delete` "carries no gate of its own". It has been
 *   `destructive` since DOR-468 and stops for a person, so the pack was teaching
 *   agents not to warn anybody before an irreversible delete, and to read a refusal
 *   as a malfunction rather than an answer. Same round: `operating-dorkos` now says
 *   that hand-registered tools carry tiers too (the catalog not listing one is not
 *   the same as it being ungated), names `marketplace.uninstall` alongside the two
 *   destructive tools, and stops claiming every CLI verb takes `--json`;
 *   `managing-agents` gained the missing `mesh_unregister` section.
 *
 *   This entry is 6 rather than 5 because DOR-502 landed on `main` first and took
 *   5. Both corrections had to reach already-seeded agents, and a version that
 *   merely EQUALS what `main` already ships delivers neither: `seed.ts` upgrades
 *   only on a strictly lower stored stamp, so the second PR to merge must re-bump
 *   rather than resolve the conflict by keeping its own number. That is not
 *   hypothetical, it is what happened here and what review caught.
 * - 7: the pack learns to look things up (DOR-661). Versions 1 to 6 taught an
 *   agent how to ACT through DorkOS and nothing about how to ANSWER for it, so
 *   "how does Relay work?" was answered from whatever the model remembered. Every
 *   agent has always been handed two documentation URLs in its `<dorkos_context>`
 *   block with no procedure attached. The new `answering-dorkos-questions` skill
 *   is that procedure: search `<base>/api/search`, fetch the single page it names
 *   from `<base>/llms.mdx/docs/...`, never the ~875 KB `llms-full.txt` corpus, and
 *   derive every URL from the context block rather than a remembered host (DOR-660
 *   removed exactly that hardcoding one layer down, and a literal URL here would
 *   re-introduce it). It also says what to do when the docs do not answer: say so,
 *   and never vouch for a feature the page does not.
 * - 8: `list_capabilities` is not the CLI's full catalog (DOR-988). Versions 2 to 7
 *   told agents the tool "returns the same thing" as `dorkos capabilities --json`.
 *   That stopped being true at DOR-940, which made the tool answer with a bounded,
 *   compact page. An agent reading the old sentence expects every JSON Schema in
 *   one response, does not learn that `domain`, `query`, `detail` and `cursor`
 *   exist, and reads the compact summaries as the whole contract of a capability
 *   it is about to invoke. The pack now describes what the tool actually returns
 *   and how to ask for more.
 *
 *   A brand-new skill seeds itself without a bump (`seed.ts` writes any absent
 *   file), so the bump is here for the OTHER half of this change: `operating-dorkos`
 *   names the new sibling, and an already-seeded file is only rewritten on a
 *   strictly higher stamp.
 *
 * - 9: the `config_patch` example named a setting that no longer exists. Versions
 *   3 to 8 taught the patch shape with `ui.sidebar.recentsCollapsed`, one of the
 *   seven per-section keys the sidebar redesign folded into `ui.sidebar.sections`
 *   (`specs/sidebar-now-today-library` §D). Zod strips an unknown key rather than
 *   refusing it, so an agent copying that example would send a patch, be told it
 *   succeeded, and change nothing — the worst kind of wrong example. It now names
 *   `ui.theme`, which is the least likely field in the whole schema to move.
 * - 10: every skill now says how a DorkOS tool is actually named where the agent
 *   runs (DOR-1292). Versions 1 to 9 named tools bare — `mesh_list`,
 *   `marketplace_get` — but Claude Code exposes DorkOS's in-session tools as
 *   `mcp__dorkos__<name>` (and defers them, so a lookup by the bare name finds
 *   nothing), while codex and opencode reach the same tools through the external
 *   `/mcp` server under whatever prefix that harness gave it. A model that followed
 *   the prose literally got "no such tool" and gave up. The skills are projected
 *   into every harness, so they cannot spell any one prefix: each now carries one
 *   shared note (`TOOL_NAME_NOTE`) — the names below are the ENDINGS of the real
 *   tool names; find the tool whose name ends in it under your harness's prefix.
 *   `operating-dorkos` lost three restatements to stay under its line cap; the
 *   content they restated is still stated once.
 * - 11: `tasks_create` now REQUIRES a `reason` (DOR-1394), and `scheduling-tasks`
 *   says so, says it is not the description, and shows the sentence to write. The
 *   bump is what makes that reach anybody: an already-seeded file is only
 *   rewritten on a strictly higher stamp (`seed.ts` returns `unchanged` at
 *   `storedVersion >= VERSION`), so an agent seeded at 10 would have kept prose
 *   that omits a now-required argument and had its very next `tasks_create`
 *   refused by the schema parse with no idea why.
 *
 *   Be precise about who a bump reaches, because it is narrower than the History
 *   above makes it sound. Until DOR-671 it was DorkBot and nobody else:
 *   `seedOperatingSkills` ran from `ensureDorkBot` on every boot and from
 *   `agent-creator` at creation, so an agent seeded once at creation kept the pack
 *   version it was born with forever. The server now re-seeds at boot as well
 *   (`services/harness/project-agent-workspace.ts`), so a bump reaches every
 *   REGISTERED agent whose workspace lives under `<dorkHome>/agents/` on their next
 *   boot — the pass walks `meshCore.listWithPaths()`, so living under that path is
 *   necessary but not sufficient; an unregistered directory there is never visited.
 *   It still does NOT reach an agent registered at a path of the person's own — a
 *   boot is not permission to write into somebody's repository, and a user-initiated
 *   repair for those is DOR-664.
 * - 12: `tasks_create` now REQUIRES a `target` and honors `maxRuntime` (DOR-1568),
 *   and `tasks_update` refuses `target`/`agentId` instead of dropping them. Same
 *   reasoning as the bump above, and the same failure without it: the tool used to
 *   write a row with no SKILL.md and no owner, so an agent seeded at 11 would keep
 *   prose that omits a now-required argument, have its next `tasks_create` refused
 *   by the schema parse, and have no idea a task even HAS a home.
 * - 13: a task can name the runtime, model and effort its runs execute on
 *   (DOR-1615, DOR-1347), and `scheduling-tasks` says so. Unlike the two bumps
 *   above, nothing here is newly REQUIRED — the failure this one prevents is the
 *   opposite shape. An agent seeded at 12 does not know the fields exist, so a
 *   user asking for "a nightly task on Codex" gets a task on whatever its agent
 *   runs, silently. It also does not know that a runtime the user has not turned
 *   on FAILS the run rather than falling back, which is the one place guessing a
 *   value is worse than leaving it out.
 */
export const OPERATING_SKILLS_VERSION = 13;

/**
 * The canonical pack, umbrella skill first. Every entry is validated against the
 * `@dorkos/skills` SKILL.md schema by this package's tests.
 */
export const OPERATING_SKILLS_PACK: readonly OperatingSkill[] = [
  operatingDorkos,
  managingAgents,
  schedulingTasks,
  usingTheMarketplace,
  readingActivity,
  answeringDorkosQuestions,
];
