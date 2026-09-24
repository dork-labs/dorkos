import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { recordHostAudit } from './authority.js';

/**
 * Delete one host account that nobody has shown they own, so the email is free again.
 *
 * Anyone can create a password account for an email address they do not control, as long as they
 * hold an invitation, and Better Auth never checks that address. When the real owner of that email
 * later signs in through the host's single sign-on, the existing account blocks them: single
 * sign-on never attaches itself to an account that already exists. This command clears that
 * collision, and nothing else. It refuses unless the account:
 *
 * - has an unverified email,
 * - signs in only with a password (no Google, GitHub or single sign-on link), and
 * - has no membership in any community, active or ended, and has never operated the host, and
 * - is not in the middle of joining one (a live join attempt bound to it).
 *
 * An account that already finished joining is a member, and leaves through member erasure or
 * removal by an owner, not this command. Its sessions, its password and any expired join attempts
 * bound to it go with it. One host audit
 * row with the offline actor records that it ran; the email is not written to the log.
 */
export async function releaseUnverifiedAccount(pool: Pool, email: string): Promise<void> {
  if (!email || email.length > 320 || email !== email.trim()) {
    throw new Error('Provide the account email address.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query<{ id: string; emailVerified: boolean }>(
      'SELECT id,"emailVerified" FROM "user" WHERE email=$1 FOR UPDATE',
      [email.toLowerCase()]
    );
    const user = account.rows[0];
    if (!user) throw new Error('No host account has that email address.');
    if (user.emailVerified)
      throw new Error('That account has a verified email address, so it is kept.');
    const links = await client.query<{ providerId: string }>(
      'SELECT "providerId" FROM account WHERE "userId"=$1',
      [user.id]
    );
    if (links.rows.some((row) => row.providerId !== 'credential'))
      throw new Error('That account signs in through another service, so it is kept.');
    const ties = await client.query<{ memberships: number; operator: number; uses: number }>(
      `SELECT (SELECT count(*)::int FROM members WHERE user_id=$1) AS memberships,
              (SELECT count(*)::int FROM host_operators WHERE user_id=$1) AS operator,
              (SELECT count(*)::int FROM invite_uses WHERE user_id=$1) AS uses`,
      [user.id]
    );
    const { memberships, operator, uses } = ties.rows[0];
    if (memberships || uses) throw new Error('That account has joined a community, so it is kept.');
    if (operator) throw new Error('That account has operated this host, so it is kept.');
    // A join attempt bound to this account and still live is someone joining right now; release
    // could race it. Expired ones are only leftovers.
    const joining = await client.query(
      `SELECT 1 FROM pending_admissions
       WHERE account_id=$1 AND consumed_at IS NULL AND expires_at>now()`,
      [user.id]
    );
    if (joining.rowCount)
      throw new Error(
        'That account is joining a community right now. Wait 10 minutes for the join attempt to expire, then try again.'
      );
    await client.query(
      'DELETE FROM pending_admissions WHERE account_id=$1 AND consumed_at IS NULL',
      [user.id]
    );
    await client.query('DELETE FROM session WHERE "userId"=$1', [user.id]);
    await client.query('DELETE FROM account WHERE "userId"=$1', [user.id]);
    // Any other row still naming the account fails this delete, and the whole release with it.
    await client.query('DELETE FROM "user" WHERE id=$1', [user.id]);
    await recordHostAudit(
      client,
      { kind: 'offline' },
      {
        action: 'account.unverified_released',
        priorState: 'unverified',
        nextState: 'released',
      }
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const email = process.argv[2];
  const databaseUrl = process.env.COMMUNITY_DATABASE_URL;
  if (!email || process.argv.length !== 3 || !databaseUrl) {
    process.stderr.write(
      'Usage: host/release-unverified-account.js <email>. COMMUNITY_DATABASE_URL is required.\n'
    );
    process.exitCode = 1;
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await releaseUnverifiedAccount(pool, email);
      process.stdout.write(
        'Account removed. The email address can now be used to sign up, including through single sign-on.\n'
      );
    } catch (error) {
      // Refusals above are written for the operator; a database error may carry connection
      // details, so it is reported without its text.
      const message =
        error instanceof Error && /^(No host account|That account|Provide)/u.test(error.message)
          ? error.message
          : 'Release failed. Check database access and applied migrations.';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
