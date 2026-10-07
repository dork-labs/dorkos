/**
 * Config changes in the audit log (spec `audit-trail` PR2): every changed leaf
 * with its value before and after, under whoever made the change, with secret
 * values emptied. Before this, a config change left only key names in a
 * rotating server log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';

describe('config changes in the audit log', () => {
  let tmpDir: string;
  let db: Db;
  let write: typeof import('../config-write.js');
  let configManager: import('../../config-manager.js').ConfigManager;
  let runWithAuditActor: typeof import('../../../audit/audit-context.js').runWithAuditActor;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-audit-'));
    process.env.DORK_HOME = tmpDir;
    configManager = (await import('../../config-manager.js')).initConfigManager(tmpDir);
    write = await import('../config-write.js');
    ({ runWithAuditActor } = await import('../../../audit/audit-context.js'));
    const { AuditLog } = await import('../../../audit/audit-log.js');
    const { AccountIds } = await import('../../../audit/account-ids.js');
    const { initAuditTrail } = await import('../../../audit/audit-trail.js');
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const rows = () => db.select().from(auditEvents).all();

  it('records each changed setting with before and after, under the person who changed it', () => {
    const owner = {
      actor: { accountId: 'install:inst-1', kind: 'person' as const, name: 'Owner' },
      surface: 'app' as const,
    };
    const before = configManager.get('scheduler').maxConcurrentRuns;
    runWithAuditActor(owner, () =>
      write.applyGuardedConfigWrite({
        patch: { scheduler: { maxConcurrentRuns: before === 2 ? 3 : 2 } },
        authority: write.LOCAL_OPERATOR_AUTHORITY,
        source: 'settings',
        writer: { kind: 'unattributed' },
      })
    );

    const [row] = rows();
    expect(row).toMatchObject({
      action: 'config.changed',
      actorId: 'install:inst-1',
      targetId: 'config.json',
    });
    expect(JSON.parse(row!.change!)).toEqual([
      { field: 'scheduler.maxConcurrentRuns', before, after: before === 2 ? 3 : 2 },
    ]);
  });

  it('keeps a secret setting’s name and none of its values', () => {
    write.applyGuardedConfigWrite({
      patch: { mcp: { apiKey: 'supersecret-key-value' } },
      authority: write.LOCAL_OPERATOR_AUTHORITY,
      source: 'settings',
      writer: { kind: 'unattributed' },
    });
    const all = JSON.stringify(rows());
    expect(all).not.toContain('supersecret-key-value');
    expect(JSON.parse(rows()[0]!.change!)).toEqual([{ field: 'mcp.apiKey', redacted: true }]);
  });

  it('records a purpose-built writer’s change, naming the writer', () => {
    const before = configManager.get('scheduler');
    const after = { ...before, retentionCount: before.retentionCount + 1 };
    write.logConfigWrite('the task scheduler', 'scheduler', before, after);
    expect(rows()[0]).toMatchObject({
      action: 'config.changed',
      summary: expect.stringContaining('through the task scheduler'),
    });
  });

  it('records nothing when nothing changed', () => {
    const same = configManager.get('scheduler');
    write.logConfigWrite('the task scheduler', 'scheduler', same, same);
    expect(rows()).toEqual([]);
  });
});
