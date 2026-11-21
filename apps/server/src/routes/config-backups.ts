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
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  listBackupCopies,
  moveOlderBackupCopy,
  removeOlderBackupCopy,
  type BackupMoveRefusal,
} from '@dorkos/db';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { expandTilde, getBoundary, isContained } from '../lib/boundary.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { recordAudit } from '../services/audit/audit-trail.js';

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

/** Where the backup copies live; read per request so a test's data folder applies. */
function backupsDir(): string {
  return path.join(resolveDorkHome(), 'backups');
}

/** Refusals the route decides before `@dorkos/db` is asked. */
type RouteRefusal =
  'person_only' | 'not_at_this_computer' | 'destination_outside' | 'destination_in_data_folder';

/** Why a Move's destination was refused before the copy, as a code the table answers. */
type DestinationRefusal =
  'destination_invalid' | 'destination_outside' | 'destination_in_data_folder';

/** What each refusal says, and the status it answers with. */
const REFUSALS: Record<
  BackupMoveRefusal | RouteRefusal,
  { status: 400 | 403 | 404 | 409 | 507; error: string }
> = {
  person_only: { status: 403, error: 'Only you can do this, from DorkOS.' },
  not_at_this_computer: { status: 403, error: 'Do this on the computer DorkOS runs on.' },
  destination_outside: {
    status: 400,
    error: 'Pick a folder DorkOS can reach, or one on an external drive.',
  },
  destination_in_data_folder: { status: 400, error: 'Pick a folder outside DorkOS’s data folder.' },
  not_found: { status: 404, error: 'That backup is no longer there.' },
  managed: { status: 409, error: 'DorkOS removes this backup on its own.' },
  busy: { status: 409, error: 'This backup is in use, so it can’t be changed now.' },
  changed: { status: 409, error: 'This backup changed. Reload the list and try again.' },
  destination_invalid: { status: 400, error: 'Pick a folder that exists.' },
  destination_is_backups: { status: 400, error: 'Pick a folder outside the backups folder.' },
  destination_exists: { status: 409, error: 'That folder already has a file with this name.' },
  destination_full: { status: 507, error: 'That disk is full. The original stays.' },
  destination_not_writable: {
    status: 403,
    error: 'DorkOS can’t write to that folder. The original stays.',
  },
  copy_failed: { status: 409, error: 'The copy couldn’t be written there. The original stays.' },
  verify_failed: {
    status: 409,
    error: 'The copy didn’t check out, so the original stays. You can still remove it.',
  },
};

/** Whether `child` is strictly below `parent` (both already real paths). */
function strictlyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Where a Move may write, decided once on the destination's real path, so a
 * link is followed exactly once and every check reads the folder that will be
 * written to. Allowed: an existing folder inside the directory boundary, or on
 * an external drive (`<volumesRoot>/<drive>/…`, which is what Security chose
 * for backups). Never the data folder or anything in it, wherever the path
 * that named it lives: that would only rename the copy to where retention
 * can't see it.
 *
 * @returns The real folder, or why it is refused.
 */
function resolveDestination(
  asked: string,
  volumesRoot: string
): { folder: string } | { refused: DestinationRefusal } {
  const decided = decideDestination(asked, volumesRoot);
  // A real folder is always absolute; a refusal code never is.
  return path.isAbsolute(decided)
    ? { folder: decided }
    : { refused: decided as DestinationRefusal };
}

/** {@link resolveDestination}'s decision: a real absolute folder, or a refusal code. */
function decideDestination(asked: string, volumesRoot: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(asked);
    if (!fs.statSync(real).isDirectory()) return 'destination_invalid';
  } catch {
    return 'destination_invalid';
  }
  let home: string;
  try {
    home = fs.realpathSync.native(resolveDorkHome());
  } catch {
    // No data folder to compare with: refuse rather than guess.
    return 'destination_in_data_folder';
  }
  if (real === home || strictlyInside(real, home)) return 'destination_in_data_folder';
  if (isContained(real, getBoundary())) return real;
  let volumes: string | undefined;
  try {
    volumes = fs.realpathSync.native(volumesRoot);
  } catch {
    volumes = undefined;
  }
  return volumes !== undefined && strictlyInside(real, volumes) ? real : 'destination_outside';
}

/** Answer a refusal with its sentence and code. */
function refuse(c: Context<ApiEnv>, code: keyof typeof REFUSALS) {
  const { status, error } = REFUSALS[code];
  return c.json({ error, code }, status);
}

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
    if (refused) return refuse(c, refused);
    const folder = backupsDir();
    return c.json({ folder, ...listBackupCopies(folder) });
  });

  /** DELETE /:name — remove one older copy. */
  router.delete('/:name', (c) => {
    const refused = personRefusal(c);
    if (refused) return refuse(c, refused);
    const name = BackupNameSchema.safeParse(c.req.param('name'));
    if (!name.success) return refuse(c, 'not_found');
    const result = removeOlderBackupCopy(backupsDir(), name.data);
    if (result !== 'removed') return refuse(c, result);
    audit(name.data);
    return c.json({ success: true });
  });

  /** POST /:name/move — copy one older backup to a folder the person chose, check it, then remove the original. */
  router.post('/:name/move', async (c) => {
    const refused = personRefusal(c);
    if (refused) return refuse(c, refused);
    const name = BackupNameSchema.safeParse(c.req.param('name'));
    if (!name.success) return refuse(c, 'not_found');
    const body = MoveBackupRequestSchema.safeParse(readJsonBody(c));
    if (!body.success) return refuse(c, 'destination_invalid');
    const destination = resolveDestination(expandTilde(body.data.destination), volumesRoot);
    if ('refused' in destination) return refuse(c, destination.refused);
    const result = await moveOlderBackupCopy(backupsDir(), name.data, destination.folder);
    if (result.status !== 'moved') return refuse(c, result.status);
    audit(name.data, result.destinationPath);
    return c.json({ destinationPath: result.destinationPath });
  });

  return router;
}
