import { afterEach, expect, it, vi } from 'vitest';
import { BrowserHandover, type OutsideTurnReason } from '../handover.js';
import { LocalBrowserError } from '../errors.js';
import { SignInWindow } from '../sign-in-window.js';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function setup(
  profileId = 'agent-atlas',
  seam: 'close' | 'prepare' | 'executable' = 'close'
) {
  const f = await leaseFixture();
  fixtures.push(f);
  f.signIn.mockRestore();
  let granted = true;
  let mark: OutsideTurnReason | null = null;
  const access = vi.fn(async (profile: string, chat: string) => {
    expect(profile).toBe(profileId);
    expect(chat).toBe('chat-a');
    if (!granted) throw new LocalBrowserError('profile_not_allowed', 'Grant revoked.');
  });
  f.service.useProfileAccess(access, () => true);
  await f.open('chat-a', profileId);
  const session = f.service.personSession('chat-a');
  const gate = heldProtocolCall();
  const context = f.contexts[0].context;
  if (seam === 'close') vi.mocked(context.close).mockImplementationOnce(gate.run);
  const spawner = vi.fn(() => ({
    pid: 12345,
    exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {}),
    quit: vi.fn(),
    forceQuit: vi.fn(),
  }));
  const signIns = new SignInWindow({
    prepare: seam === 'prepare' ? gate.run : async () => undefined,
    executable: async () => {
      if (seam === 'executable') await gate.run();
      return '/made-up/Chromium';
    },
    installedChrome: () => undefined,
    held: () => false,
    lockOwner: () => 12345,
    spawner,
  });
  const handover = new BrowserHandover(session, signIns, () => f.directory);
  handover.useOutsideTurnCheck(async () => mark);
  const asking = handover.ask('chat-a', 'password');
  // Observe rejection now, so adversarial changes never cause an unhandled rejection.
  const outcome = asking.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await gate.started;
  return {
    ...f,
    session,
    handover,
    signIns,
    spawner,
    access,
    gate,
    outcome,
    revoke: () => {
      granted = false;
    },
    mark: (next: OutsideTurnReason) => {
      mark = next;
    },
  };
}

async function refuses(f: Awaited<ReturnType<typeof setup>>, code: string) {
  f.gate.release();
  expect(await f.outcome).toMatchObject({ error: { code } });
  expect(f.spawner).not.toHaveBeenCalled();
  expect(f.signIns.active).toBe(false);
  expect(f.handover.isOpenFor('chat-a')).toBe(false);
}

it('launches once at the frozen admitted URL after its own successful close', async () => {
  const f = await setup();
  f.gate.release();
  expect(await f.outcome).toHaveProperty('value.handoffId');
  expect(f.spawner).toHaveBeenCalledOnce();
  expect(f.spawner).toHaveBeenCalledWith(
    '/made-up/Chromium',
    expect.arrayContaining(['https://page-1-0.example.test/'])
  );
  expect(f.access).toHaveBeenCalledWith('agent-atlas', 'chat-a');
  expect(f.contexts[0].context.close).toHaveBeenCalledOnce();
});

it.each(['default', 'agent-atlas'])('rechecks the %s binding after the close', async (profile) => {
  const f = await setup(profile);
  f.revoke();
  await refuses(f, 'profile_not_allowed');
});

it.each(['close', 'prepare', 'executable'] as const)(
  'refuses a turn marked during %s, before any physical launch',
  async (seam) => {
    const f = await setup('agent-atlas', seam);
    f.mark('outsider_turn');
    await refuses(f, 'outside_turn');
  }
);
it('refuses a stranger chat arriving while the close waits', async () => {
  const f = await setup();
  f.mark('stranger_chat');
  await refuses(f, 'outside_turn');
});
it('a new page-read mark needs an admitted refusal, never an unrelated live page', async () => {
  const f = await setup();
  f.mark('read_outside_text');
  await refuses(f, 'outside_turn');
});

it.each(['prepare', 'executable'] as const)(
  'rechecks bindings after %s completes',
  async (seam) => {
    const f = await setup('default', seam);
    f.revoke();
    await refuses(f, 'profile_not_allowed');
  }
);

it('an unshare and rebind cannot revive a revoked birth lease', async () => {
  const f = await setup('default');
  await f.service.revokeProfileAccess('default');
  await refuses(f, 'site_changed');
});

it('refuses a replacement page even when it reopens the same profile and URL', async () => {
  const f = await setup('agent-atlas', 'prepare');
  await f.open('chat-a');
  await refuses(f, 'site_changed');
});

it('preserves the sibling person-held refusal without closing the sibling', async () => {
  const f = await setup('agent-atlas', 'prepare');
  await f.open('chat-b');
  const sibling = f.service.personSession('chat-b');
  await sibling.handover.takeOver();
  await refuses(f, 'profile_held');
  expect(f.contexts[1].context.close).not.toHaveBeenCalled();
});
it('preserves exclusive profile custody when another chat opens during preparation', async () => {
  const f = await setup('agent-atlas', 'prepare');
  await f.open('chat-b');
  await refuses(f, 'profile_busy');
  expect(f.contexts[1].context.close).not.toHaveBeenCalled();
});

it('retains a sibling sign-in refusal without rejecting its own launch reservation', async () => {
  const f = await setup('agent-atlas', 'prepare');
  await f.open('chat-b');
  const sibling = f.service.personSession('chat-b');
  vi.spyOn(sibling.handover, 'signInHoldsProfile').mockReturnValue(true);
  await refuses(f, 'signing_in');
});

it('rechecks identity synchronously after the asynchronous launch admission returns', async () => {
  const f = await setup('agent-atlas', 'prepare');
  const authority = f.session.requireHandoffAuthority;
  f.session.requireHandoffAuthority = async (chat) => {
    await authority(chat);
    // The final admission read yields once; revoke before physical spawn resumes.
    queueMicrotask(() => {
      void f.service.revokeProfileAccess('agent-atlas');
    });
  };
  await refuses(f, 'site_changed');
});
