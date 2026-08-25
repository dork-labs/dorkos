/**
 * Opening the index must never take the panel down with it (DOR-1563).
 *
 * **This file exists because that contract was broken the first time it was
 * written.** `openEmbeddedIndex` guarded the database open and nothing else, so
 * a `TypeError` two lines later — `timer.unref()` on an interval handle that is
 * Blink's, not Node's, in Obsidian's renderer — escaped through `CopilotView`
 * and blanked the whole panel on every machine that HAD a database. The bug was
 * invisible to every test here because nothing asked what happens when a line
 * that is not the database open throws.
 *
 * So the degradation is asserted directly, by making a dependency throw, rather
 * than inferred from the shape of the code.
 *
 * @module obsidian-plugin/__tests__/embedded-index
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDb, openReadOnlyDb, runMigrations } from '@dorkos/db';
import { readOwnerAccount } from '../../../server/src/services/core/auth/index.js';
import { logger } from '../../../server/src/lib/logger.js';
import { createRoomSubsystem } from '../../../server/src/services/rooms/index.js';
import { openEmbeddedIndex } from '../lib/embedded-index';

const rooms = vi.hoisted(() => ({ throws: false }));

vi.mock('../../../server/src/services/rooms/index.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../server/src/services/rooms/index.js')>();
  return {
    ...original,
    createRoomSubsystem: (opts: Parameters<typeof original.createRoomSubsystem>[0]) => {
      if (rooms.throws) throw new TypeError('handle.unref is not a function');
      return original.createRoomSubsystem(opts);
    },
  };
});

let dorkHome: string;

/**
 * Put a real, migrated `dork.db` where the plugin will look for it.
 *
 * @param withOperator - Whether the operator's own author row exists, which a
 *   booted DorkOS always mints. `false` is a database migrated and never used.
 */
function seedDatabase(withOperator = true): void {
  const db = createDb(path.join(dorkHome, 'dork.db'));
  runMigrations(db);
  if (withOperator) createRoomSubsystem({ db }).authors.localHuman();
  db.$client.close();
}

beforeEach(() => {
  rooms.throws = false;
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-embed-index-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('deciding whether there is an index here', () => {
  it('answers null when DorkOS has never run, and does not leave a database behind', () => {
    // The second half is the assertion that matters. `createDb` creates on open
    // — that is how a real install gets its first database — so a reader using
    // it would leave a schemaless `dork.db` for the real DorkOS to boot into.
    expect(openEmbeddedIndex(dorkHome)).toBeNull();
    expect(fs.existsSync(path.join(dorkHome, 'dork.db'))).toBe(false);
  });

  it('answers null when the database predates message search', () => {
    const db = createDb(path.join(dorkHome, 'dork.db'));
    db.$client.exec('CREATE TABLE something_else (x)');
    db.$client.close();

    expect(openEmbeddedIndex(dorkHome)).toBeNull();
  });

  it('opens a real database and hands back a working seam', () => {
    seedDatabase();

    const index = openEmbeddedIndex(dorkHome);

    expect(index).not.toBeNull();
    expect(index?.search.search({ q: 'narwhal' })).toEqual({
      ok: true,
      response: { results: [], warnings: [] },
    });
    index?.close();
  });

  it('refuses in a sentence on a database no DorkOS has ever run against', () => {
    // Migrated but never used: the index tables are there and the operator's own
    // author row is not. A reader may not mint one — that is a write — so it
    // says so rather than inventing an identity to search as, and rather than
    // answering "no matches" to every query forever.
    seedDatabase(false);

    const index = openEmbeddedIndex(dorkHome);
    const answer = index?.search.search({ q: 'scheduler' });

    expect(answer).toMatchObject({ ok: false, code: 'SEARCH_OPERATOR_UNKNOWN', status: 503 });
    index?.close();
  });
});

describe('what happens when something other than the open throws', () => {
  it('answers null instead of taking the panel down', () => {
    // The regression. Before this, a throw from anywhere past `createDb`
    // escaped `openEmbeddedIndex`, escaped `CopilotView.onOpen`, and the panel
    // rendered nothing at all — on precisely the machines that HAD a database,
    // which is to say the ones where search was supposed to work.
    seedDatabase();
    rooms.throws = true;

    expect(() => openEmbeddedIndex(dorkHome)).not.toThrow();
    expect(openEmbeddedIndex(dorkHome)).toBeNull();
  });

  it('does not leave the account reader pointing at a database it closed', () => {
    // A failed open that attached the reader and then threw would leave every
    // later `readOwnerAccount()` reading a closed handle.
    seedDatabase();
    rooms.throws = true;

    openEmbeddedIndex(dorkHome);

    expect(() => readOwnerAccount()).not.toThrow();
    expect(readOwnerAccount()).toBeNull();
  });
});

describe('letting go', () => {
  it('releases the account reader, so a closed handle is never read again', () => {
    seedDatabase();
    const index = openEmbeddedIndex(dorkHome);

    index?.close();

    // Not merely "does not throw": the reader must answer `null`, which is what
    // a detached reader answers. A second panel opening and closing would
    // otherwise poison the first one's still-open database.
    expect(readOwnerAccount()).toBeNull();
  });

  it('is safe to close twice', () => {
    seedDatabase();
    const index = openEmbeddedIndex(dorkHome);

    index?.close();

    expect(() => index?.close()).not.toThrow();
  });
});

describe('what the embed may write', () => {
  it('nothing during the open either — the rooms domain is built read-only', () => {
    // `createRoomSubsystem` normally seeds the reserved handles at construction,
    // which is a write. It is the ONLY thing construction writes, and on a
    // readonly connection it fails and reports itself — so a subsystem built
    // without `readOnly: true` announces the attempt in the log. Silence here is
    // the assertion: nothing tried.
    seedDatabase();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const index = openEmbeddedIndex(dorkHome);

    expect(index).not.toBeNull();
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('reserved handles'))
    ).toEqual([]);
    index?.close();
  });

  it('nothing — the connection itself refuses a write', () => {
    // The dual-writer guarantee, asserted rather than documented. DorkOS may be
    // running against this exact file, and two programs writing one index is the
    // risk this whole iteration is shaped to avoid. Asserted on the CONNECTION,
    // not on the seam: "the seam happens not to write" is a much weaker fact.
    seedDatabase();
    const reader = openReadOnlyDb(path.join(dorkHome, 'dork.db'));

    try {
      expect(() =>
        reader.$client.exec("INSERT INTO authors (id, kind, natural_key) VALUES ('a','human','b')")
      ).toThrowError(/readonly/i);
    } finally {
      reader.$client.close();
    }
  });
});
