/**
 * The two things that must happen to handles before an install serves a request
 * (spec `handles` §4, §4a): the reservations are seeded, and every author row
 * that predates the column gets one.
 *
 * @module server/services/rooms/handles/ensure-handles
 */
import { and, asc, authors, isNull, type Db } from '@dorkos/db';
import { BROADCAST_RESERVATIONS, SYSTEM_HANDLE, deriveHandle } from '@dorkos/shared/handle';
import { logger } from '../../../lib/logger.js';
import { isExternalNaturalKey, type AuthorRegistry } from '../author-registry.js';

// The room's own voice (`SYSTEM_HANDLE`) and the broadcast words
// (`BROADCAST_RESERVATIONS`) live in `@dorkos/shared/handle`, with the reasons
// for each, so the client can keep them out of a handle it SUGGESTS (DOR-677).
// This module is still the only thing that enforces them: it seeds them as
// tombstones at boot.

/**
 * Seed the reservations and backfill every author that has no handle yet.
 *
 * **Seeding cannot be lazy, and the ordering is why.** `AuthorRegistry.system()`
 * routes through the same mint-on-first-use path as everything else, and it has
 * exactly one production caller: the `kind: 'notice'` write path. On a fresh
 * install the system author's row therefore does not exist until the first
 * notice fires — so an agent whose manifest `name` is `DorkOS` (legal, because
 * `AgentManifestSchema.name` is `z.string().min(1)`) that joins a room before
 * any notice has been written would mint first, take `dorkos`, and leave the
 * room's own voice to de-collide to `dorkos-2`. A reservation that fails open on
 * ordering is not a reservation. So this mints the system author EAGERLY,
 * beside `ensureDorkBot`, which is already the boot-time hook for "this install
 * must have this entity".
 *
 * **The backfill is idempotent and `created_at`-ordered.** It skips a row that
 * already has a handle, never writes an empty string, and walks oldest-first so
 * any de-collision suffix it assigns is reproducible across a re-run.
 *
 * It is TypeScript at boot rather than SQL in a migration, deliberately. The
 * grammar and the derivation live in exactly one module
 * (`@dorkos/shared/handle`) and a SQL backfill would be a second implementation
 * of both — the one thing the spec's G2 forbids. What a migration buys instead
 * is running once; this buys the same thing with `handle IS NULL`, and it
 * self-heals a row that somehow arrives without one.
 *
 * Never throws: a boot that cannot backfill a handle is an install where some
 * authors are un-addressable, which is a degraded room and not a broken server.
 *
 * **The two halves fail separately, and that is the point.** One `try` around
 * both would let a seeding failure — a locked database, a `dorkos` somehow
 * already held — silently cancel the backfill that had not run yet, so an
 * install would lose every agent's address to a problem with one reserved word.
 * They are independent repairs of independent state; each degrades to a warning
 * naming what it lost, and the other still runs. The ORDER still matters, so
 * seeding goes first: a reservation taken after a backfill has derived past it
 * is a reservation that failed open.
 *
 * @param db - The database.
 * @param registry - The author registry, for its mint and claim paths.
 */
export function ensureHandles(db: Db, registry: AuthorRegistry): void {
  try {
    seedReservations(registry);
  } catch (err) {
    logger.warn('[rooms] could not seed the reserved handles', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    backfillHandles(db, registry);
  } catch (err) {
    logger.warn('[rooms] could not backfill author handles', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mint the system author and give it `dorkos`, plus the three broadcast
 * tombstones.
 *
 * @param registry - The author registry.
 */
function seedReservations(registry: AuthorRegistry): void {
  const system = registry.system();
  if (system.handle !== SYSTEM_HANDLE) {
    registry.setHandle(system.id, SYSTEM_HANDLE);
  }
  for (const word of BROADCAST_RESERVATIONS) {
    registry.handles.reserve(word, system.id);
  }
}

/**
 * Give a handle to every active author that has none and can derive one.
 *
 * The local human is deliberately skipped: there is no honest string to derive
 * from. `'You'` is the defect this feature exists to remove, the OS username is
 * personal data, and `'Someone'` is a placeholder for a state that should not
 * arise. Where there is nothing honest, the right answer is to ask rather than
 * to invent.
 *
 * **Nothing asks yet.** The write path exists — `PATCH
 * /api/rooms/authors/:id/handle` — and the surface that puts the question in
 * front of somebody ships with the profile work (DOR-979). Until then the
 * operator simply has no handle, which every reader already renders honestly:
 * the picker shows them disabled, and the roster an agent is handed names them
 * without an `@`.
 *
 * @param db - The database.
 * @param registry - The author registry.
 */
function backfillHandles(db: Db, registry: AuthorRegistry): void {
  const pending = db
    .select()
    .from(authors)
    .where(and(isNull(authors.handle), isNull(authors.retiredAt)))
    .orderBy(asc(authors.createdAt))
    .all();

  let filled = 0;
  for (const row of pending) {
    const derived = backfillHandleFor(row, registry);
    if (derived === null) continue;
    try {
      registry.setHandle(row.id, derived);
      filled += 1;
    } catch (err) {
      // One row that cannot take its derived handle — a race, or a value
      // somebody already claimed — must not stop the rest of the table.
      logger.warn('[rooms] could not backfill a handle', {
        authorId: row.id,
        handle: derived,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (filled > 0) logger.info('[rooms] backfilled author handles', { filled });
}

/**
 * The handle one row backfills to, or `null` when it gets none.
 *
 * **Keyed on `agents.name`, reached through the author's `natural_key`** — not
 * on `authors.display_name`, which is what a reader glancing at the rows would
 * assume. For most agent rows the two columns differ, so a backfill written off
 * the wrong column produces wrong handles for most of the table.
 *
 * @param row - The stored author row.
 * @param registry - The author registry, for the agent lookup and taken set.
 */
function backfillHandleFor(
  row: typeof authors.$inferSelect,
  registry: AuthorRegistry
): string | null {
  const claimant = {
    id: row.id,
    kind: row.kind as 'human' | 'agent' | 'system',
    naturalKey: row.naturalKey,
  };
  if (row.kind === 'system') return null;
  if (row.kind === 'human' && !isExternalNaturalKey(row.naturalKey)) return null;
  const taken = registry.handles.spokenFor(claimant);
  if (row.kind === 'agent') {
    const agentName = registry.agentNameOf(row.naturalKey);
    return (
      (agentName ? deriveHandle(agentName, taken) : undefined) ??
      deriveHandle(row.displayName, taken) ??
      null
    );
  }
  return deriveHandle(row.displayName, taken) ?? null;
}
