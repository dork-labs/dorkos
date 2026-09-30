import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { transaction } from '../data.js';
import { ApiError } from '../http.js';
import { releaseHeldEvidence, retryTakedownEvidence, type TakedownRow } from './takedowns.js';

const usage = `Usage:
  takedown/commands.js evidence-retry <takedown id>
  takedown/commands.js release-held <takedown id>

evidence-retry sends a failed or held evidence copy back to the worker; the server needs an
evidence store (COMMUNITY_EVIDENCE_DRIVER) to copy it.
release-held gives up a copy that has not been saved yet and queues the held bytes for deletion.
COMMUNITY_DATABASE_URL is required.
`;

/** One parsed offline takedown command. */
export type TakedownCommand = { kind: 'evidence-retry' | 'release-held'; takedownId: string };

/** Parse the offline command's arguments, or throw a message fit for standard error. */
export function parseTakedownCommand(argv: readonly string[]): TakedownCommand {
  const [command, id, ...rest] = argv;
  if ((command !== 'evidence-retry' && command !== 'release-held') || rest.length) {
    throw new Error(usage);
  }
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Give the id of the takedown, as the host page or the host API shows it.');
  }
  return { kind: command, takedownId: id.toLowerCase() };
}

/**
 * Run one offline takedown command against the host database.
 *
 * Anyone who can run this already controls the database, so it needs no further proof. Each
 * command writes a host audit row whose actor is the offline command. `release-held` may give up
 * any copy not yet saved, which is how a host drains held bytes before rolling back a release.
 */
export async function runTakedownCommand(
  pool: Pool,
  command: TakedownCommand,
  options: { evidenceStore: boolean; now?: Date }
): Promise<TakedownRow> {
  const now = options.now ?? new Date();
  return transaction(pool, (client) =>
    command.kind === 'evidence-retry'
      ? retryTakedownEvidence(client, {
          takedownId: command.takedownId,
          actor: { kind: 'offline' },
          evidenceStore: options.evidenceStore,
          now,
        })
      : releaseHeldEvidence(client, {
          takedownId: command.takedownId,
          actor: { kind: 'offline' },
          now,
        })
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Like the key command, this needs only the database, not the web app's other secrets.
  // eslint-disable-next-line no-restricted-syntax -- This standalone command has a separate, minimal environment contract.
  const env = process.env;
  const url = env.COMMUNITY_DATABASE_URL;
  let command: TakedownCommand | undefined;
  try {
    if (!url) throw new Error(usage);
    command = parseTakedownCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
    process.exitCode = 1;
  }
  if (url && command) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
    try {
      const row = await runTakedownCommand(pool, command, {
        evidenceStore: Boolean(env.COMMUNITY_EVIDENCE_DRIVER),
      });
      process.stdout.write(`Takedown ${row.id}: evidence is now ${row.evidence_state}.\n`);
    } catch (error) {
      // Driver errors can carry connection details. Say only what the command refused.
      process.stderr.write(
        error instanceof ApiError
          ? `${error.message}\n`
          : 'The command failed. Check database access and that migrations are applied.\n'
      );
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
