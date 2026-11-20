/**
 * A real owner account for approval tests, with no mock of the auth module: a
 * throwaway auth database whose oldest user is the owner `readOwnerAccount`
 * reports. Nobody registered is a computer with no owner yet.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { user, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { initAuth } from '../../services/core/auth/index.js';

let db: Db | undefined;

/**
 * Register `id` as this computer's owner, or `null` for nobody registered.
 *
 * @param id - The owner's account id, or `null`.
 */
export function setTestOwner(id: string | null): void {
  if (!db) {
    if (id === null) return;
    db = createTestDb();
    initAuth(db, fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-test-owner-')));
  }
  db.delete(user).run();
  if (id)
    db.insert(user)
      .values({ id, name: 'Test owner', email: `${id}@example.test` })
      .run();
}
