import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { CommunityAdminHostApiKeyScopeSchema } from '@dorkos/shared/community-admin-wire';
import type { HostApiKeyScope } from './host/authority.js';
import {
  issueHostApiKey,
  listHostApiKeys,
  revokeHostApiKey,
  type HostApiKeyProjection,
} from './host/key-store.js';

const usage = `Usage:
  host-keys.js issue --label <text> --scope <scope> [--scope <scope>...] [--expires-in-days <1-365>]
  host-keys.js list
  host-keys.js revoke <key id>

Scopes: ${CommunityAdminHostApiKeyScopeSchema.options.join(', ')}
COMMUNITY_DATABASE_URL is required.
`;

/** One parsed offline key command. */
export type HostKeyCommand =
  | { kind: 'issue'; label: string; scopes: HostApiKeyScope[]; expiresInDays: number | null }
  | { kind: 'list' }
  | { kind: 'revoke'; keyId: string };

/** Parse the offline command's arguments, or throw a message fit for standard error. */
export function parseHostKeyCommand(argv: readonly string[]): HostKeyCommand {
  const [command, ...rest] = argv;
  if (command === 'list' && rest.length === 0) return { kind: 'list' };
  if (command === 'revoke' && rest.length === 1) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest[0])) {
      throw new Error('Give the id of the key to revoke, as `list` shows it.');
    }
    return { kind: 'revoke', keyId: rest[0].toLowerCase() };
  }
  if (command !== 'issue') throw new Error(usage);
  let label: string | undefined;
  let expiresInDays: number | null = null;
  const scopes: HostApiKeyScope[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.\n\n${usage}`);
    if (flag === '--label') label = value.trim();
    else if (flag === '--scope') {
      const scope = CommunityAdminHostApiKeyScopeSchema.safeParse(value);
      if (!scope.success) throw new Error(`Unknown scope ${JSON.stringify(value)}.\n\n${usage}`);
      scopes.push(scope.data);
    } else if (flag === '--expires-in-days') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 365) {
        throw new Error('--expires-in-days must be a whole number from 1 to 365.');
      }
      expiresInDays = Number(value);
    } else throw new Error(`Unknown option ${JSON.stringify(flag)}.\n\n${usage}`);
  }
  if (!label || label.length > 80) throw new Error('--label needs 1 to 80 characters.');
  if (scopes.length === 0) throw new Error(`Give at least one --scope.\n\n${usage}`);
  return { kind: 'issue', label, scopes, expiresInDays };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run one offline key command against the host database.
 *
 * Anyone who can run this already controls the database, so it needs no further proof. Every
 * issue and revoke writes a host audit row whose actor is the offline command.
 */
export async function runHostKeyCommand(
  pool: Pool,
  command: HostKeyCommand,
  now = new Date()
): Promise<
  | { kind: 'issue'; key: HostApiKeyProjection; secret: string }
  | { kind: 'list'; keys: HostApiKeyProjection[] }
  | { kind: 'revoke'; key: HostApiKeyProjection }
> {
  if (command.kind === 'list') return { kind: 'list', keys: await listHostApiKeys(pool) };
  if (command.kind === 'revoke') {
    const key = await inTransaction(pool, (client) =>
      revokeHostApiKey(client, { keyId: command.keyId, revoker: { kind: 'offline' }, now })
    );
    return { kind: 'revoke', key };
  }
  const issued = await inTransaction(pool, (client) =>
    issueHostApiKey(client, {
      label: command.label,
      scopes: command.scopes,
      expiresAt:
        command.expiresInDays === null
          ? null
          : new Date(now.getTime() + command.expiresInDays * 24 * 60 * 60_000),
      issuer: { kind: 'offline' },
      now,
    })
  );
  return { kind: 'issue', ...issued };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Offline key management needs only the database, not the web app's other secrets.
  // eslint-disable-next-line no-restricted-syntax -- This standalone command has a separate, minimal environment contract.
  const url = process.env.COMMUNITY_DATABASE_URL;
  let command: HostKeyCommand | undefined;
  try {
    if (!url) throw new Error(usage);
    command = parseHostKeyCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
    process.exitCode = 1;
  }
  if (url && command) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
    try {
      const result = await runHostKeyCommand(pool, command);
      if (result.kind === 'issue') {
        // The secret alone goes to standard output, so it can be piped straight into a secret store.
        process.stdout.write(`${result.secret}\n`);
        process.stderr.write(
          `Issued key ${result.key.id} (${result.key.prefix}…). This is the only time the key is shown.\n`
        );
      } else if (result.kind === 'list') {
        for (const key of result.keys) process.stdout.write(`${JSON.stringify(key)}\n`);
      } else {
        process.stdout.write(`Revoked key ${result.key.id}.\n`);
      }
    } catch (error) {
      // Driver errors can carry connection details. Name only a key the command could not find.
      const notFound = error instanceof Error && error.message === 'Host API key not found.';
      process.stderr.write(
        notFound
          ? 'No host API key has that id.\n'
          : 'The command failed. Check database access and that migrations are applied.\n'
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
