import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { eraseAccount, eraseMembership, type ErasureOptions } from './erasure.js';

/** One erasure to run again after a backup restore. */
export type ErasureRecord =
  { kind: 'member'; communityId: string; memberId: string } | { kind: 'account'; userId: string };

/** A journal line that is not an erasure record. Its message names only the line number. */
export class JournalLineError extends Error {
  constructor(number: number, options?: { cause: unknown }) {
    super(`Line ${number} is not an erasure record.`, options);
    this.name = 'JournalLineError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

function parseLine(line: string, number: number): ErasureRecord {
  if (line.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new JournalLineError(number, { cause: error });
    }
    const value = parsed as Record<string, unknown>;
    if (value.event === 'community.member_erased')
      line = `member ${String(value.communityId)} ${String(value.memberId)}`;
    else if (value.event === 'community.account_erased') line = `account ${String(value.userId)}`;
    else throw new JournalLineError(number);
  }
  const [kind, ...ids] = line.split(/\s+/);
  if (kind === 'member' && ids.length === 2 && UUID.test(ids[0]) && UUID.test(ids[1]))
    return { kind: 'member', communityId: ids[0], memberId: ids[1] };
  if (kind === 'account' && ids.length === 1 && USER_ID.test(ids[0]))
    return { kind: 'account', userId: ids[0] };
  throw new JournalLineError(number);
}

/**
 * Read erasure journal or log lines: the JSON lines the server writes
 * (`{"event":"community.member_erased",…}`), or the short forms
 * `member <communityId> <memberId>` and `account <userId>`. Blank lines are skipped.
 */
export function parseErasureJournal(text: string): ErasureRecord[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line, index) => (line ? [parseLine(line, index + 1)] : []));
}

/**
 * Run each recorded erasure again, in order, against a database restored from a backup, then
 * give every community it touched a new random redaction epoch so cursors saved before the
 * restore stop working. Each procedure is idempotent, so a record that already holds is a
 * no-op. Run it with the web service stopped.
 */
export async function reapplyErasures(
  pool: Pool,
  records: readonly ErasureRecord[],
  options: ErasureOptions = {}
): Promise<{ members: number; accounts: number; communities: number }> {
  const quiet: ErasureOptions = { ...options, log: options.log ?? (() => undefined) };
  const touched = new Set<string>();
  let members = 0;
  let accounts = 0;
  for (const record of records) {
    if (record.kind === 'member') {
      const outcome = await eraseMembership(pool, record.communityId, record.memberId, quiet);
      if (outcome !== 'gone') touched.add(record.communityId);
      members++;
    } else {
      const communities = await pool.query<{ community_id: string }>(
        'SELECT DISTINCT community_id FROM members WHERE user_id=$1',
        [record.userId]
      );
      for (const row of communities.rows) touched.add(row.community_id);
      await eraseAccount(pool, record.userId, quiet);
      accounts++;
    }
  }
  for (const communityId of touched) {
    // A new random value, never an increment: a second restore would rewind an increment to a
    // value that cursors saved before it already carry.
    await pool.query('UPDATE communities SET redaction_epoch=$2 WHERE id=$1', [
      communityId,
      randomBytes(8).readBigInt64BE().toString(),
    ]);
  }
  return { members, accounts, communities: touched.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const databaseUrl = process.env.COMMUNITY_DATABASE_URL;
  if (!databaseUrl || process.argv.length !== 2 || process.stdin.isTTY) {
    process.stderr.write(
      'Stop the community service, then pipe the erasure journal or log lines to erasure/reapply.js. COMMUNITY_DATABASE_URL is required.\n'
    );
    process.exitCode = 1;
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const result = await reapplyErasures(
        pool,
        parseErasureJournal(Buffer.concat(chunks).toString('utf8'))
      );
      process.stdout.write(
        `Re-applied ${result.members} member erasures and ${result.accounts} account erasures across ${result.communities} communities.\n`
      );
    } catch (error) {
      // Database errors can carry row content. Report only a parse error, which names a line.
      process.stderr.write(
        error instanceof JournalLineError
          ? `${error.message}\n`
          : 'Re-applying erasures failed. Check database access and applied migrations, then run it again.\n'
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
