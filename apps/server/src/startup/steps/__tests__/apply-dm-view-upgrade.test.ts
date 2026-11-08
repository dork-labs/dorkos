/**
 * The DM view upgrade's startup step over the real config, audit log and done
 * file (DOR-3074): what it writes is recorded as DorkOS rather than a person, and
 * the done file is only ever a way to skip the step. Taking it away, or planting
 * one, cannot overwrite a person's choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { createServerRefs } from '../../server-refs.js';

const refs = {
  ...createServerRefs(),
  stopDocDelivery: undefined,
  testComposioFixture: undefined,
  docNotificationCleanup: undefined,
};

describe('applyDmViewUpgradeOnBoot', () => {
  let home: string;
  let db: Db;
  let boot: () => void;
  let configManager: import('../../../services/core/config-manager.js').ConfigManager;
  let write: typeof import('../../../services/core/operator/config-write.js');
  let runWithAuditActor: typeof import('../../../services/audit/audit-context.js').runWithAuditActor;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-view-step-'));
    process.env.DORK_HOME = home;
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        version: 1,
        ui: { dmView: false, showSessions: false },
        __internal__: { migrations: { version: '0.130.0' } },
      })
    );
    configManager = (await import('../../../services/core/config-manager.js')).initConfigManager(
      home
    );
    write = await import('../../../services/core/operator/config-write.js');
    ({ runWithAuditActor } = await import('../../../services/audit/audit-context.js'));
    const { AuditLog } = await import('../../../services/audit/audit-log.js');
    const { AccountIds } = await import('../../../services/audit/account-ids.js');
    const { initAuditTrail } = await import('../../../services/audit/audit-trail.js');
    const { applyDmViewUpgradeOnBoot } = await import('../apply-dm-view-upgrade.js');
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    boot = () => applyDmViewUpgradeOnBoot(refs, { dorkHome: home, db });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  const doneFile = () => path.join(home, 'upgrades', 'dm-view-on.json');
  const uiOnDisk = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).ui;

  /** Turn the DM view off the way Settings does, under a person. */
  function personTurnsOff(): void {
    runWithAuditActor(
      {
        actor: { accountId: 'install:inst-1', kind: 'person', name: 'Owner' },
        surface: 'app',
      },
      () =>
        write.applyGuardedConfigWrite({
          patch: { ui: { dmView: false } },
          authority: write.LOCAL_OPERATOR_AUTHORITY,
          source: 'settings',
          writer: { kind: 'unattributed' },
        })
    );
  }

  /** Change the file behind the app's back, as a hand edit does. */
  function handEditOff(): void {
    const file = path.join(home, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.ui.dmView = false;
    fs.writeFileSync(file, JSON.stringify(config));
  }

  it('records its change as DorkOS, not a person, and names the upgrade', () => {
    boot();
    const rows = db.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'config.changed',
      actorKind: 'system',
      actorName: 'DorkOS',
      outcome: 'ok',
      summary: expect.stringContaining('the DM view upgrade'),
    });
    expect(JSON.parse(rows[0]!.source)).toEqual({ surface: 'system' });
    expect(JSON.parse(rows[0]!.change!)).toEqual([
      { field: 'ui.dmView', before: false, after: true },
    ]);
  });

  it('keeps a person’s choice when the done file is taken away and the step runs again', () => {
    boot();
    personTurnsOff();
    fs.rmSync(doneFile());
    boot();
    expect(uiOnDisk()).toMatchObject({ dmView: false });
  });

  it('keeps a hand edit too, because its own record stops a second run', () => {
    boot();
    handEditOff();
    fs.rmSync(doneFile());
    boot();
    expect(uiOnDisk()).toMatchObject({ dmView: false });
  });

  it('keeps a choice made before the upgrade, with no done file at all', () => {
    personTurnsOff(); // A no-op write: stored off already, so no row yet.
    configManager.setDot('ui.dmView', true);
    personTurnsOff();
    boot();
    expect(uiOnDisk()).toMatchObject({ dmView: false });
  });

  it('only skips when a done file is planted: it changes nothing and writes no record', () => {
    fs.mkdirSync(path.dirname(doneFile()), { recursive: true });
    fs.writeFileSync(doneFile(), 'not even json');
    boot();
    expect(uiOnDisk()).toMatchObject({ dmView: false, showSessions: false });
    expect(db.select().from(auditEvents).all()).toEqual([]);
  });

  it('never throws, and stays not done, when a record cannot be read', () => {
    const brokenBoot = async () => {
      const { applyDmViewUpgradeOnBoot } = await import('../apply-dm-view-upgrade.js');
      applyDmViewUpgradeOnBoot(refs, { dorkHome: home, db: {} as Db });
    };
    return expect(brokenBoot())
      .resolves.toBeUndefined()
      .then(() => {
        expect(fs.existsSync(doneFile())).toBe(false);
        expect(uiOnDisk()).toMatchObject({ dmView: false });
      });
  });
});
