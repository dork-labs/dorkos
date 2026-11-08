/**
 * The person's notice, and their choice to go on without the check (DOR-3300). The children here
 * can't start, for real: the file to fork isn't there.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { childFile, notify, resolveStanding, armEscalation, unresolvedStanding } = vi.hoisted(
  () => ({
    childFile: vi.fn(),
    notify: vi.fn(async () => undefined),
    resolveStanding: vi.fn(async () => undefined),
    armEscalation: vi.fn(),
    unresolvedStanding: vi.fn(() => [] as { createdAt: string }[]),
  })
);

vi.mock('../guard-child-file.js', () => ({ resolveGuardChild: childFile }));
vi.mock('../../../../notifications/notification-service.js', () => ({
  notify,
  resolveStanding,
  unresolvedStanding,
}));
vi.mock('../../../../notifications/escalation-service.js', () => ({ armEscalation }));

const ROOTS = {
  cwd: '/',
  dorkHome: '/made-up/data',
  home: '/made-up/home',
  accounts: [],
  env: {},
  agentHomes: () => [],
};

/** A fresh copy of the module, as a restart gives. */
async function freshService() {
  vi.resetModules();
  const service = await import('../guard-service.js');
  // Past the wait between failed starts, three commands' worth.
  const host = service.guardHost() as unknown as { tuning: { startRetryMs: number } };
  host.tuning.startRetryMs = 0;
  return service;
}

/** Enough commands for the third failed start. */
async function failThrice(service: Awaited<ReturnType<typeof freshService>>, reads = false) {
  await service.guardHost().check('ls', ROOTS, reads);
  await service.guardHost().check('ls', ROOTS, reads);
}

beforeEach(() => {
  vi.clearAllMocks();
  childFile.mockRejectedValue(new Error('not in this build'));
  unresolvedStanding.mockReturnValue([]);
});

describe('guard-service', () => {
  it('says nothing before the third failed start', async () => {
    const service = await freshService();
    await service.guardHost().check('ls', ROOTS, false);
    expect(notify).not.toHaveBeenCalled();
    expect(service.shellCheckStatus().down).toBe(false);
  });

  it('tells the person, on the row and the phone, at the level that found it', async () => {
    const service = await freshService();
    await failThrice(service);
    const payload = { since: expect.any(String), full: true };
    expect(notify).toHaveBeenCalledWith('shell.check_down', payload);
    expect(armEscalation).toHaveBeenCalledWith('shell.check_down', payload);
    expect(service.shellCheckStatus()).toEqual({
      down: true,
      full: true,
      canContinue: false,
      continuing: false,
    });
  });

  it('won’t let a person go on before a restart has been tried', async () => {
    const service = await freshService();
    await failThrice(service);
    expect(service.continueWithoutCheck()).toBe(false);
    expect(service.goingOnWithoutCheck()).toBe(false);
  });

  it('won’t let a person go on while the check works', async () => {
    const service = await freshService();
    expect(service.continueWithoutCheck()).toBe(false);
  });

  it('lets a person go on once a restart hasn’t helped, and a restart ends the choice', async () => {
    unresolvedStanding.mockReturnValue([{ createdAt: '2026-11-04T03:00:00.000Z' }]);
    const service = await freshService();
    await failThrice(service);
    expect(service.shellCheckStatus().canContinue).toBe(true);
    expect(service.continueWithoutCheck()).toBe(true);
    expect(service.goingOnWithoutCheck()).toBe(true);
    expect(service.shellCheckStatus().continuing).toBe(true);

    const restarted = await freshService();
    expect(restarted.goingOnWithoutCheck()).toBe(false);
  });

  it('closes a notice a restart fixed, on the first working start', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'guard-service-')), 'works.cjs');
    writeFileSync(
      file,
      `process.on('disconnect', () => process.exit(0)); process.send({ type: 'ready' });
       process.on('message', (m) => process.send({ type: 'answer', id: m.id, answer: { write: 'none', reaches: false } }));`
    );
    childFile.mockResolvedValue(file);
    unresolvedStanding.mockReturnValue([{ createdAt: '2026-11-04T03:00:00.000Z' }]);
    const service = await freshService();
    expect(await service.guardHost().check('ls', ROOTS, false)).toMatchObject({
      outcome: 'checked',
    });
    expect(resolveStanding).toHaveBeenCalledWith(
      'shell.check_down',
      expect.objectContaining({ since: '2026-11-04T03:00:00.000Z', clearedAt: expect.any(String) }),
      { outcome: 'cleared' }
    );
    service.guardHost().stop();
  });
});
