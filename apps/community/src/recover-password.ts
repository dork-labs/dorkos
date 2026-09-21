import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';

/** Reset one host account and revoke credentials derived from every membership. */
export async function recoverPassword(pool: Pool, email: string, password: string): Promise<void> {
  if (!email || email.length > 320 || email !== email.trim()) {
    throw new Error('Provide the account email address.');
  }
  if (password.length < 12 || password.length > 128 || /[\r\n\0]/.test(password)) {
    throw new Error('Use a password with 12 to 128 characters and no line breaks.');
  }
  const hashed = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Recovery is host-wide. Lock the account first, then every membership in a stable order so
    // concurrent tenant mutations cannot leave one community's derived credentials valid.
    // Run this command with the web service stopped, including every replica.
    const account = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email=$1 FOR UPDATE`,
      [email.toLowerCase()]
    );
    const userId = account.rows[0]?.id;
    if (!userId) throw new Error('No host account has that email address.');
    const memberships = await client.query<{ id: string; community_id: string }>(
      `SELECT id,community_id FROM members WHERE user_id=$1
       ORDER BY community_id,id FOR UPDATE`,
      [userId]
    );
    const memberIds = memberships.rows.map((member) => member.id);

    const updated = await client.query(
      `UPDATE account SET password=$1,"updatedAt"=now()
       WHERE "userId"=$2 AND "providerId"='credential' RETURNING id`,
      [hashed, userId]
    );
    if (!updated.rowCount) {
      await client.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password)
         VALUES($1,$2,'credential',$2,$3)`,
        [randomUUID(), userId, hashed]
      );
    }
    await client.query('DELETE FROM session WHERE "userId"=$1', [userId]);
    await client.query(
      `UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now())
       WHERE member_id=ANY($1::uuid[])`,
      [memberIds]
    );
    await client.query(
      `UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at,now())
       WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=ANY($1::uuid[]))`,
      [memberIds]
    );
    await client.query(
      `UPDATE connection_pairings SET cancelled_at=COALESCE(cancelled_at,now())
       WHERE member_id=ANY($1::uuid[])`,
      [memberIds]
    );
    await client.query(
      `INSERT INTO audit_events(community_id,action,subject_id)
       SELECT community_id,'member.password_recovery',id FROM members
       WHERE id=ANY($1::uuid[]) ORDER BY community_id,id`,
      [memberIds]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Read one bounded password from a pipe without putting it in shell arguments or logs. */
export async function readRecoveryPassword(
  input: AsyncIterable<Uint8Array | string>
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024) throw new Error('Password input is too long.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const email = process.argv[2];
  const databaseUrl = process.env.COMMUNITY_DATABASE_URL;
  if (!email || process.argv.length !== 3 || !databaseUrl || process.stdin.isTTY) {
    process.stderr.write(
      'Stop the community service, then pipe a password to recover-password.js <email>. COMMUNITY_DATABASE_URL is required.\n'
    );
    process.exitCode = 1;
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await recoverPassword(pool, email, await readRecoveryPassword(process.stdin));
      process.stdout.write(
        'Password changed. Existing sessions, local connections, and agent credentials have been revoked.\n'
      );
    } catch {
      // Database errors can carry connection details. Report no secret or raw error.
      process.stderr.write(
        'Recovery failed. Check the account email, password length, database access, and applied migrations.\n'
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
