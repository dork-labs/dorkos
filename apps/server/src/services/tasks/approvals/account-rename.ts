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
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseContentKey, scheduleContentKey } from '../schedule-permission-clamp.js';
import { planTaskFileUpdate } from '../task-file-update.js';
import { logger } from '../../../lib/logger.js';

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
 * Replace the `account:` value inside the `schedule:` block of a SKILL.md's
 * frontmatter, touching nothing else: quoting style, a trailing comment, every
 * other line (comments, flow lists, `enabled: true`, the blank line before the
 * body) stay byte for byte. `null` when that edit is not possible (no
 * frontmatter, a flow-style `schedule: { ... }`, or not exactly one match).
 *
 * @param content - The file's bytes.
 * @param from - The account value to replace.
 * @param to - The new value.
 */
export function rewriteScheduleAccountInPlace(
  content: string,
  from: string,
  to: string
): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?\r?\n)---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) return null;
  const start = frontmatter[0].indexOf(frontmatter[1]);
  const lines = frontmatter[1].split('\n');
  let inSchedule = false;
  let blockIndent: number | null = null;
  const hits: number[] = [];
  lines.forEach((line, index) => {
    const bare = line.replace(/\r$/, '');
    if (/^schedule:\s*(#.*)?$/.test(bare)) {
      inSchedule = true;
      return;
    }
    if (!inSchedule || bare.trim() === '' || /^\s*#/.test(bare)) return;
    const indent = /^ */.exec(bare)![0].length;
    if (indent === 0) {
      inSchedule = false;
      return;
    }
    blockIndent ??= indent;
    if (indent !== blockIndent) return;
    const match = /^(\s*account\s*:\s*)(['"]?)(.*?)\2(\s*(?:#.*)?)$/.exec(bare);
    if (match && match[3] === from) hits.push(index);
  });
  if (hits.length !== 1) return null;
  const at = hits[0]!;
  lines[at] = lines[at]!.replace(
    /^(\s*account\s*:\s*)(['"]?)(.*?)\2(\s*(?:#.*)?)(\r?)$/,
    (_all, prefix: string, quote: string, _value: string, rest: string, cr: string) =>
      `${prefix}${quote}${to}${quote}${rest}${cr}`
  );
  const absoluteStart = frontmatter.index + start;
  return (
    content.slice(0, absoluteStart) +
    lines.join('\n') +
    content.slice(absoluteStart + frontmatter[1].length)
  );
}

/**
 * Replace a file's contents so a crash leaves the old file or the new one,
 * never half of one: a temp file in the same folder, `fsync`, then `rename`
 * over the target, keeping its mode. A symlink is resolved first and the real
 * file replaced, so the link itself stays a link.
 *
 * @param filePath - The file to replace (a symlink is followed).
 * @param content - Its new contents.
 */
async function replaceFileAtomically(filePath: string, content: string): Promise<void> {
  const target = await fs.realpath(filePath);
  const { mode } = await fs.stat(target);
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  const handle = await fs.open(tmp, 'wx', mode & 0o7777);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(tmp, mode & 0o7777);
    await fs.rename(tmp, target);
  } catch (err) {
    // Any failure (a full disk mid-write included) leaves the person's file as
    // it was and no temp file behind.
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Whether an installed package owns a schedule's file (never written by DorkOS). */
export type ScheduleOwnershipCheck = (schedule: {
  filePath: string;
  agentId: string | null;
}) => Promise<boolean>;

/** Schedules already reported as skipped, so each is logged once per process. */
const loggedSkips = new Set<string>();

/**
 * Move every schedule naming account `from` to `to`: rows and their approval
 * in one transaction, then each schedule file that still says `from`, edited in
 * place.
 *
 * A schedule whose file an installed package owns is skipped entirely, row and
 * file: DorkOS never writes a package's file, and moving the row alone would
 * only be undone by the next sync. It keeps `default`, which once the rename
 * marker is dropped means the machine default (contract rev 6d). Logged once.
 *
 * @param db - The database holding `pulse_schedules`.
 * @param from - The old registry id (`default`).
 * @param to - The id the migration gave the row (`default-N`).
 * @param isPackageOwned - Whether a schedule's file belongs to an installed package.
 * @returns What moved. Throws when a file cannot be rewritten, so the caller
 *   keeps its rename marker and tries again.
 */
export async function renameScheduleAccount(
  db: Db,
  from: string,
  to: string,
  isPackageOwned: ScheduleOwnershipCheck
): Promise<ScheduleAccountRename> {
  const owned = new Set<string>();
  const candidates = db
    .select({
      id: pulseSchedules.id,
      filePath: pulseSchedules.filePath,
      agentId: pulseSchedules.agentId,
      account: pulseSchedules.account,
    })
    .from(pulseSchedules)
    .all()
    .filter((row) => row.account === from || row.account === to);
  for (const row of candidates) {
    if (!(await isPackageOwned(row))) continue;
    owned.add(row.id);
    if (row.account === from && !loggedSkips.has(row.id)) {
      loggedSkips.add(row.id);
      logger.info(
        '[account-usage] left a schedule an installed package owns on `default`, which now means the machine default',
        { scheduleId: row.id, filePath: row.filePath }
      );
    }
  }

  let rows = 0;
  db.transaction((tx) => {
    const named = tx.select().from(pulseSchedules).where(eq(pulseSchedules.account, from)).all();
    for (const row of named) {
      if (owned.has(row.id)) continue;
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
    .select({ id: pulseSchedules.id, filePath: pulseSchedules.filePath })
    .from(pulseSchedules)
    .where(eq(pulseSchedules.account, to))
    .all();
  for (const { id, filePath } of moved) {
    if (owned.has(id)) continue;
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      // No file, no reference to move: a DB-only or deleted schedule.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (fileAccount(content) !== from) continue;
    const edited = rewriteScheduleAccountInPlace(content, from, to);
    if (edited !== null) {
      await replaceFileAtomically(filePath, edited);
      files++;
      continue;
    }
    // A shape the in-place edit does not handle: rewrite through the planner,
    // which re-serializes the frontmatter (comments and quoting are lost).
    logger.warn('[account-usage] rewrote a schedule file whole to move its account', { filePath });
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
