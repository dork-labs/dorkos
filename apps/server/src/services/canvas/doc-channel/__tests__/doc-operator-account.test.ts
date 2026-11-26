/**
 * The document channel's operator rule for a signed-in account (DOR-4978): a
 * chat canvas's file save (`files.save`, through the mount's `ownerOrNoAccount`)
 * and its recovery ask the same rule, and a signed-in account that is not the
 * owner is refused with login off, as before.
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { user, type Db } from '@dorkos/db';
import { initAuth } from '../../../core/auth/index.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { capabilityRequestFacts } from '../../../../routes/capability-dispatch.js';
import type { RequestFacts } from '../../../../http/request-facts.js';
import { isDocOperatorAccount } from '../doc-source-policy.js';

let db: Db;
let home: string;
beforeEach(() => {
  db = createTestDb();
  home = mkdtempSync(join(tmpdir(), 'dorkos-doc-operator-'));
  // Real config and a real auth store: login off, as on a fresh install.
  initConfigManager(home);
  initAuth(db, home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Make this install have an owner account: a real row in the auth store. */
function addOwner(): void {
  db.insert(user)
    .values({
      id: 'user_owner',
      name: 'Owner',
      email: 'owner@doc-operator.test',
      createdAt: new Date(1),
      updatedAt: new Date(1),
    })
    .run();
}

/** The mount's answer for a request signed in as `userId`, or as nobody. */
function mountAnswer(userId?: string): boolean {
  const facts = {
    headers: {},
    ...(userId ? { user: { userId, credential: 'cookie' } } : {}),
  } as unknown as RequestFacts;
  return capabilityRequestFacts(facts).ownerOrNoAccount;
}

describe('the document channel operator rule', () => {
  it('lets in no account, and refuses any account while there is no owner', () => {
    expect(isDocOperatorAccount(undefined)).toBe(true);
    expect(isDocOperatorAccount({ userId: 'someone' })).toBe(false);
    expect(mountAnswer()).toBe(true);
    expect(mountAnswer('someone')).toBe(false);
  });

  it('refuses a signed-in account that is not the owner, with login off', () => {
    addOwner();
    expect(isDocOperatorAccount({ userId: 'user_owner' })).toBe(true);
    expect(isDocOperatorAccount({ userId: 'user_other' })).toBe(false);
    expect(mountAnswer('user_owner')).toBe(true);
    expect(mountAnswer('user_other')).toBe(false);
  });
});
