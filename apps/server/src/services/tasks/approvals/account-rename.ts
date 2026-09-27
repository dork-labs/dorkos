/**
 * Move every schedule that names a renamed Claude account onto its new id,
 * keeping each approval (spec `claude-account-fleet` §6 R "`default` is
 * reserved", task 1.3's hand-off to 2.1).
 *
 * The `'0.87.0'` config migration renames a registry row called `default` to
 * `default-N`. A schedule naming it lives in three places, and all three move:
 *
 * 1. the row's `account`;
 * 2. its approval grant (`approved_content_key`), whose account part is
 *    rewritten in the SAME transaction, as `upgradeLegacyContentKey` does for
 *    older key formats, so an approved schedule is not parked for a change
 *    nobody made;
 * 3. its `SKILL.md` frontmatter (`schedule.account`), rewritten last, because
 *    file sync reads the account back from the file: left saying `default`, the
 *    next sync would put `default` back, which under contract rev 6d names the
 *    machine default, a different account.
 *
 * Idempotent and crash-safe: steps 1 and 2 are one transaction, and step 3 is
 * re-derived on every run from rows that already say the new id, so a run cut
 * short between them finishes cleanly next time.
 *
 * @module services/tasks/approvals/account-rename
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseContentKey, scheduleContentKey } from '../schedule-permission-clamp.js';
import { planTaskFileUpdate } from '../task-file-update.js';

/** What {@link renameScheduleAccount} moved. */
export interface ScheduleAccountRename {
  /** Rows whose `account` (and approval, when it named the old id) moved. */
  rows: number;
  /** `SKILL.md` files rewritten to the new id. */
  files: number;
}

/**
 * The grant with its account part moved from `from` to `to`, or the grant as it
 * was when it does not record `from` (another account, or a key this build
 * cannot read, which is left exactly as written).
 */
function renamedGrant(key: string | null, from: string, to: string): string | null {
  if (key === null) return null;
  const approved = parseContentKey(key);
  if (approved === null || approved.account !== from) return key;
  return scheduleContentKey({ ...approved, account: to });
}

/** The `schedule.account` a SKILL.md's frontmatter names, or `undefined`. */
function fileAccount(content: string): string | undefined {
  const raw = readRawFrontmatter(content);
  const schedule = raw?.data.schedule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return undefined;
  const account = (schedule as Record<string, unknown>).account;
  return typeof account === 'string' ? account : undefined;
}

/**
 * Move every schedule naming account `from` to `to`: rows and their approval
 * in one transaction, then each schedule file that still says `from`.
 *
 * @param db - The database holding `pulse_schedules`.
 * @param from - The old registry id (`default`).
 * @param to - The id the migration gave the row (`default-N`).
 * @returns What moved. Throws when a file cannot be rewritten, so the caller
 *   keeps its rename marker and tries again.
 */
export async function renameScheduleAccount(
  db: Db,
  from: string,
  to: string
): Promise<ScheduleAccountRename> {
  let rows = 0;
  db.transaction((tx) => {
    const named = tx.select().from(pulseSchedules).where(eq(pulseSchedules.account, from)).all();
    for (const row of named) {
      tx.update(pulseSchedules)
        .set({
          account: to,
          approvedContentKey: renamedGrant(row.approvedContentKey, from, to),
        })
        .where(eq(pulseSchedules.id, row.id))
        .run();
      rows++;
    }
  });

  let files = 0;
  const moved = db
    .select({ filePath: pulseSchedules.filePath })
    .from(pulseSchedules)
    .where(eq(pulseSchedules.account, to))
    .all();
  for (const { filePath } of moved) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      // No file, no reference to move: a DB-only or deleted schedule.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (fileAccount(content) !== from) continue;
    const plan = planTaskFileUpdate(filePath, content, { account: to });
    if (plan.kind === 'refuse') {
      throw new Error(`Could not rewrite the account in ${filePath}: ${plan.message}`);
    }
    const dir = path.dirname(filePath);
    await writeSkillFile(path.dirname(dir), path.basename(dir), plan.frontmatter, plan.body);
    files++;
  }
  return { rows, files };
}
