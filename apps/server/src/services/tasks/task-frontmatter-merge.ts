/**
 * Turning a task write request into SKILL.md frontmatter (DOR-1481).
 *
 * `POST /api/tasks` and `PATCH /api/tasks/:id` both have to get request fields
 * into the frontmatter object that gets written to disk, and both used to do it
 * by hand — a run of `if` statements each, with different rules. The update
 * path's rule was wrong in a way that broke the file permanently:
 *
 * A write says "clear this field" by sending `null`. Copying the value in on
 * `!== undefined` put that `null` straight into the YAML, and
 * the frontmatter schema rejects `null` for every one of the four clearable
 * fields (`display-name`, `cron`, `timezone`, `max-runtime`). A file that does
 * not parse is a file the watcher logs as invalid and stops syncing, the
 * reconciler keeps rebuilding the row from, and this route silently skips
 * writing ever again — it only rewrites a file that parsed. So one cleared
 * field desynced the file from its row for good.
 *
 * The rule this module states once, for both callers:
 *
 * - `undefined` — the request did not mention the field. Leave it alone.
 * - `null` — the request cleared the field. **Remove the key**, never write null.
 * - anything else — set it.
 *
 * Keys it knows nothing about are carried through untouched, so provenance the
 * route does not manage (`origin`, `shape` on a Shape-installed task) survives
 * a rewrite.
 *
 * **One thing this deliberately does not fight.** The `base` an update passes in
 * is the frontmatter as PARSED, which means the schema's defaults
 * have already been filled in — so rewriting a file that omitted `timezone`,
 * `enabled` or `permissions` materializes them into the YAML as `UTC`, `true`
 * and `acceptEdits`. That is a cosmetic change to a file a person may have
 * written by hand, and it is left alone on purpose: the values are exactly what
 * the omitted keys already meant, and reconstructing "which keys were absent
 * before" would mean re-reading the raw YAML alongside the parsed form for no
 * behavioral gain. Noted so the next reader does not mistake it for a bug.
 *
 * @module services/tasks/task-frontmatter-merge
 */

/**
 * The frontmatter key each request field is written to.
 *
 * The two names differ for three of them — YAML frontmatter is kebab-case and
 * the request body is camelCase — and `permissionMode` lands on `permissions`,
 * which is the name the frontmatter gives it (inside the `schedule:` block
 * since DOR-1486 — `task-file-update.ts` is what puts it there). Keeping the
 * mapping
 * in one table is what lets the merge below be a loop rather than eight
 * hand-written branches that can each be wrong in their own way.
 */
const FRONTMATTER_KEY = {
  name: 'name',
  displayName: 'display-name',
  description: 'description',
  cron: 'cron',
  timezone: 'timezone',
  enabled: 'enabled',
  maxRuntime: 'max-runtime',
  permissionMode: 'permissions',
} as const satisfies Record<string, string>;

/**
 * The task fields a create or update request may write into frontmatter.
 *
 * A field typed `| null` is one a caller may CLEAR. The four of them are
 * exactly the four the frontmatter schema treats as optional-or-defaulted, and
 * exactly the four that reject a literal `null` — which is the whole reason
 * this module exists.
 *
 * `prompt` is deliberately absent: it is the SKILL.md body, not frontmatter.
 */
export interface TaskFrontmatterWrite {
  /** The task's slug, which is also its directory name. */
  name?: string;
  /** The name a person reads. Clearable. */
  displayName?: string | null;
  /** What the task is for. */
  description?: string;
  /** The cron line. Clearable — a task with no cron is on-demand only. */
  cron?: string | null;
  /** The IANA timezone the cron is read in. Clearable, back to the default. */
  timezone?: string | null;
  /** Whether the schedule is armed. */
  enabled?: boolean;
  /**
   * Whether every run resumes one persistent session (DOR-1571). Lives inside
   * the `schedule:` block, so it is written through `SCHEDULE_FIELD` in
   * `task-file-update.ts`, not the top-level {@link FRONTMATTER_KEY} table here.
   */
  sticky?: boolean;
  /** How long a run may take, as `30s`/`10m`/`2h30m`. Clearable — no cap. */
  maxRuntime?: string | null;
  /** How much an unattended run may do without asking. */
  permissionMode?: string;
}

/**
 * Apply a task write request to a frontmatter object.
 *
 * @param base - The frontmatter to start from: the parsed file's own
 *   frontmatter on an update, or just `name` and `description` on a create.
 *   Never mutated.
 * @param write - The fields the request carries. See {@link TaskFrontmatterWrite}
 *   for the three-way `undefined` / `null` / value rule.
 * @returns A new frontmatter object, ready for `writeSkillFile`.
 */
export function mergeTaskFrontmatter(
  base: Readonly<Record<string, unknown>>,
  write: TaskFrontmatterWrite
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [field, key] of Object.entries(FRONTMATTER_KEY)) {
    const value = write[field as keyof TaskFrontmatterWrite];
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }

  return merged;
}
