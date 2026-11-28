/**
 * Settings → Backups (DOR-4253): the copies of this computer's DorkOS database
 * in `<dorkHome>/backups`, and a person's Remove and Move on the older ones
 * that automatic retention never touches.
 *
 * Person-only, every route: an agent, an approval token, a program credential
 * or a request from another computer (except the owner over an encrypted
 * connection) is refused before anything is read. A copy is named by its
 * file name only; `@dorkos/db`'s `backup-copies` decides which names a writer
 * produced and re-checks the file right before it acts. A Move's destination
 * must sit inside this computer's directory boundary or on an external drive,
 * and never in the data folder.
 *
 * Mounted at `/api/config/backups`, beside the config group.
 *
 * @module routes/config-backups
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { problemBody, readJsonBody, sendProblem, type ProblemStatus } from '@dorkos/http-kit';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';
import { honoRequestFacts } from '../http/request-facts.js';
import { requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { expandTilde } from '../lib/boundary.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import {
  backupsDir,
  listDatabaseBackups,
  moveOlderDatabaseBackup,
  removeOlderDatabaseBackup,
  resolveBackupDestination,
  type BackupMoveRefusal,
} from '../services/core/config/database-backups.js';

/** A listed copy's file name: no folder part, at most a sane length. */
export const BackupNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+$/u);

/** The body of a Move. */
export const MoveBackupRequestSchema = z
  .object({ destination: z.string().min(1).max(4096) })
  .strict();

/** Refusals the route decides before `@dorkos/db` is asked. */
type RouteRefusal =
  'person_only' | 'not_at_this_computer' | 'destination_outside' | 'destination_in_data_folder';

/** What each refusal says, and the problem code it answers with. */
const REFUSAL_WORDS: Record<
  BackupMoveRefusal | RouteRefusal,
  { code: ProblemCode; detail: string; status?: ProblemStatus }
> = {
  person_only: { code: 'person_only', detail: 'Only you can do this, from DorkOS.' },
  not_at_this_computer: {
    code: 'operator_only',
    detail: 'Do this on the computer DorkOS runs on.',
  },
  destination_outside: {
    code: 'invalid_request',
    detail: 'Pick a folder DorkOS can reach, or one on an external drive.',
  },
  destination_in_data_folder: {
    code: 'invalid_request',
    detail: 'Pick a folder outside DorkOS’s data folder.',
  },
  not_found: { code: 'not_found', detail: 'That backup is no longer there.' },
  managed: { code: 'conflict', detail: 'DorkOS removes this backup on its own.' },
  busy: { code: 'conflict', detail: 'This backup is in use, so it can’t be changed now.' },
  changed: {
    code: 'precondition_failed',
    detail: 'This backup changed. Reload the list and try again.',
  },
  destination_invalid: { code: 'invalid_request', detail: 'Pick a folder that exists.' },
  destination_is_backups: {
    code: 'invalid_request',
    detail: 'Pick a folder outside the backups folder.',
  },
  destination_exists: {
    code: 'conflict',
    detail: 'That folder already has a file with this name.',
  },
  // A full disk is the server's to report, at the status HTTP names for it.
  destination_full: {
    code: 'internal_error',
    status: 507,
    detail: 'That disk is full. The original stays.',
  },
  destination_not_writable: {
    code: 'forbidden',
    detail: 'DorkOS can’t write to that folder. The original stays.',
  },
  copy_failed: {
    code: 'conflict',
    detail: 'The copy couldn’t be written there. The original stays.',
  },
  verify_failed: {
    code: 'conflict',
    detail: 'The copy didn’t check out, so the original stays. You can still remove it.',
  },
};

/** Each refusal's problem document, answered as it is. */
const REFUSALS = Object.fromEntries(
  Object.entries(REFUSAL_WORDS).map(([refusal, { code, ...options }]) => [
    refusal,
    problemBody(code, options),
  ])
) as Record<keyof typeof REFUSAL_WORDS, Problem>;

/**
 * Why this caller may not act, or `undefined` for a person at this computer
 * (or the owner over an encrypted connection). The owner on plain-http Wi-Fi is
 * told where to go, not that only they can do it.
 */
function personRefusal(c: Context<ApiEnv>): RouteRefusal | undefined {
  const refusal = requirePersonAtThisComputer(honoRequestFacts(c));
  if (refusal === undefined) return undefined;
  return refusal === 'not-at-this-computer' ? 'not_at_this_computer' : 'person_only';
}

/** Record a person's action on one copy; a Move says where it went. */
function audit(name: string, movedTo?: string): void {
  recordAudit({
    action: movedTo ? 'backups.copy.move' : 'backups.copy.remove',
    operation: 'remove',
    summary: movedTo ? 'Moved an older backup' : 'Removed an older backup',
    outcome: 'ok',
    source: { surface: 'app' },
    target: { type: 'backup', id: name },
    ...(movedTo ? { change: [{ field: 'location', before: backupsDir(), after: movedTo }] } : {}),
  });
}

/** Options for {@link createConfigBackupsRoutes}. */
export interface ConfigBackupsRoutesOptions {
  /** Where external drives are mounted; `/Volumes` (macOS). A test points it at a temp folder. */
  volumesRoot?: string;
}

/**
 * The Backups routes.
 *
 * @param options - See {@link ConfigBackupsRoutesOptions}.
 * @returns The router, mounted at `/api/config/backups`.
 */
export function createConfigBackupsRoutes(options: ConfigBackupsRoutesOptions = {}): Hono<ApiEnv> {
  const volumesRoot = options.volumesRoot ?? '/Volumes';
  const router = new Hono<ApiEnv>();

  /** GET / — every backup copy, newest first, and their total size. */
  router.get('/', (c) => {
    const refused = personRefusal(c);
    if (refused) return sendProblem(c, REFUSALS[refused]);
    return c.json(listDatabaseBackups());
  });

  /** DELETE /:name — remove one older copy. */
  router.delete('/:name', (c) => {
    const refused = personRefusal(c);
    if (refused) return sendProblem(c, REFUSALS[refused]);
    const name = BackupNameSchema.safeParse(c.req.param('name'));
    if (!name.success) return sendProblem(c, REFUSALS.not_found);
    const result = removeOlderDatabaseBackup(name.data);
    if (result !== 'removed') return sendProblem(c, REFUSALS[result]);
    audit(name.data);
    return c.json({ success: true });
  });

  /** PATCH /:name `{ destination }` — copy one older backup to a folder the person chose, check it, then remove the original. */
  router.patch('/:name', async (c) => {
    const refused = personRefusal(c);
    if (refused) return sendProblem(c, REFUSALS[refused]);
    const name = BackupNameSchema.safeParse(c.req.param('name'));
    if (!name.success) return sendProblem(c, REFUSALS.not_found);
    const body = MoveBackupRequestSchema.safeParse(readJsonBody(c));
    if (!body.success) return sendProblem(c, REFUSALS.destination_invalid);
    const destination = resolveBackupDestination(expandTilde(body.data.destination), volumesRoot);
    if ('refused' in destination) return sendProblem(c, REFUSALS[destination.refused]);
    const result = await moveOlderDatabaseBackup(name.data, destination.folder);
    if (result.status !== 'moved') return sendProblem(c, REFUSALS[result.status]);
    audit(name.data, result.destinationPath);
    return c.json({ destinationPath: result.destinationPath });
  });

  return router;
}
