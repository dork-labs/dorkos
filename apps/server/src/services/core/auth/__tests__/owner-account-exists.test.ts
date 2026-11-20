/**
 * `ownerAccountExists` (DOR-3832): the owner lookup that person bars read must fail closed. A
 * lookup that throws answers "an owner exists", so no bar treats a broken store as an install
 * with nobody to prove.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { initAuth } from '../index.js';
import { ownerAccountExists } from '../gate-policy.js';

describe('ownerAccountExists', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  // This case relies on running first in this file: auth state is module-wide, and the next case
  // starts it. Vitest runs a file's cases in order, in their own module registry.
  it('reads as no owner before auth starts, which startup runs before any route (see its comment)', () => {
    expect(ownerAccountExists()).toBe(false);
  });

  it('answers no owner on a store with no account, and an owner when the lookup throws', () => {
    const db = createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-owner-lookup-'));
    initAuth(db, tmpDir);
    expect(ownerAccountExists()).toBe(false);

    // A store the lookup can't read: the accounts table is gone.
    db.run(sql`DROP TABLE user`);
    expect(ownerAccountExists()).toBe(true);
  });
});
