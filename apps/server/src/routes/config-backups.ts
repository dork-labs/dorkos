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
 * must sit inside this computer's directory boundary.
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
import { BoundaryError, expandTilde, validateBoundary } from '../lib/boundary.js';
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
  | 'person_only'
  | 'not_at_this_computer'
  | 'destination_outside'
  | 'destination_in_data_folder'
  | 'destination_is_link';

/** What each refusal says, and the status it answers with. */
const REFUSALS: Record<
  BackupMoveRefusal | RouteRefusal,
  { status: 400 | 403 | 404 | 409 | 507; error: string }
> = {
  person_only: { status: 403, error: 'Only you can do this, from DorkOS.' },
  not_at_this_computer: { status: 403, error: 'Do this on the computer DorkOS runs on.' },
  destination_outside: { status: 400, error: 'That folder is outside what DorkOS can reach.' },
  destination_in_data_folder: { status: 400, error: 'Pick a folder outside DorkOS’s data folder.' },
  destination_is_link: { status: 400, error: 'Pick the folder itself, not a link to it.' },
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

/** Whether the path itself is a symbolic link (a missing path is not). */
function isLink(folder: string): boolean {
  try {
    return fs.lstatSync(folder).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether a resolved folder is the data folder or sits anywhere inside it, by
 * real path. A folder that can't be resolved counts as inside: refused.
 */
function insideDataFolder(folder: string): boolean {
  try {
    const home = fs.realpathSync.native(resolveDorkHome());
    const relative = path.relative(home, fs.realpathSync.native(folder));
    const outside =
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    return !outside;
  } catch {
    return true;
  }
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

/**
 * The Backups routes.
 *
 * @returns The router, mounted at `/api/config/backups`.
 */
export function createConfigBackupsRoutes(): Hono<ApiEnv> {
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
    const asked = expandTilde(body.data.destination);
    // The folder the person named, not one a link at that name points to.
    if (isLink(asked)) return refuse(c, 'destination_is_link');
    let destination: string;
    try {
      destination = await validateBoundary(asked);
    } catch (err) {
      if (err instanceof BoundaryError)
        return refuse(
          c,
          err.code === 'OUTSIDE_BOUNDARY' ? 'destination_outside' : 'destination_invalid'
        );
      throw err;
    }
    // Anywhere in the data folder is only a rename to where retention can't see it.
    if (insideDataFolder(destination)) return refuse(c, 'destination_in_data_folder');
    const result = await moveOlderBackupCopy(backupsDir(), name.data, destination);
    if (result.status !== 'moved') return refuse(c, result.status);
    audit(name.data, result.destinationPath);
    return c.json({ destinationPath: result.destinationPath });
  });

  return router;
}
