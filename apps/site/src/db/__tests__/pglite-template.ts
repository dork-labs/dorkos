/**
 * Build a PGlite database once, then hand out independent copies of it.
 *
 * Booting PGlite runs `initdb` and replaying migrations on top of that costs
 * seconds; loading a data directory dumped from an already-built database costs
 * a fraction of it. The template is built by the caller's own provisioning
 * function — the same migrations, through the same migrator — and every
 * `fresh()` is a separate in-memory database: nothing a test writes reaches the
 * template or any other copy. Never share one copy across tests (DOR-4190).
 *
 * @module db/__tests__/pglite-template
 */
import { PGlite } from '@electric-sql/pglite';

/** A built database every test copies instead of building its own. */
export interface PGliteTemplate {
  /** A new, independent database in exactly the template's state. */
  fresh(): Promise<PGlite>;
}

/**
 * Build a database with `provision`, dump its data directory, and close it.
 *
 * Copies load the uncompressed dump: measured locally at ~0.4–0.7s per copy
 * against ~2.5–3.5s for boot plus the managed migrations, and below PGlite's
 * own `clone()`, which re-dumps the source on every call.
 *
 * @param provision - Brings an empty database to the state every test starts from.
 */
export async function createPGliteTemplate(
  provision: (client: PGlite) => Promise<void>
): Promise<PGliteTemplate> {
  const builder = new PGlite();
  try {
    await provision(builder);
    // Flush every page to disk first. Without it the copy starts by replaying WAL,
    // and a sequence comes back at its WAL-logged lookahead (+32), not its value.
    await builder.exec('CHECKPOINT');
    const dataDir = await builder.dumpDataDir('none');
    return { fresh: () => PGlite.create({ loadDataDir: dataDir }) };
  } finally {
    await builder.close();
  }
}
