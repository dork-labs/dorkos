import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';

/** Reset an existing active member's password through privileged offline database access. */
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
    // All community mutations take the member lock before sessions or credentials.
    // Run this command with the web service stopped, including every replica.
    const result = await client.query<{ id: string; user_id: string; community_id: string }>(
      `SELECT m.id,m.user_id,m.community_id FROM members m JOIN "user" u ON u.id=m.user_id
       WHERE u.email=$1 AND m.active FOR UPDATE OF m`,
      [email.toLowerCase()]
    );
    const member = result.rows[0];
    if (!member) throw new Error('No active member has that email address.');
    const updated = await client.query(
      `UPDATE account SET password=$1,"updatedAt"=now()
       WHERE "userId"=$2 AND "providerId"='credential' RETURNING id`,
      [hashed, member.user_id]
    );
    if (!updated.rowCount) {
      await client.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password)
         VALUES($1,$2,'credential',$2,$3)`,
        [randomUUID(), member.user_id, hashed]
      );
    }
    await client.query('DELETE FROM session WHERE "userId"=$1', [member.user_id]);
    await client.query(
      'UPDATE connection_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE member_id=$1',
      [member.id]
    );
    await client.query(
      `UPDATE agent_credentials SET revoked_at=COALESCE(revoked_at,now())
       WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=$1)`,
      [member.id]
    );
    await client.query(
      'UPDATE connection_pairings SET cancelled_at=COALESCE(cancelled_at,now()) WHERE member_id=$1',
      [member.id]
    );
    await client.query(
      `INSERT INTO audit_events(community_id,action,subject_id)
       VALUES($1,'member.password_recovery',$2)`,
      [member.community_id, member.id]
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
