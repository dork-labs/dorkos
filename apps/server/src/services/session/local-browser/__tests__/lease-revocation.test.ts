import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { createLocalBrowserProfileStore } from '../profile-store.js';
import { LocalBrowserError } from '../errors.js';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  return f;
}
it('an unbind fences pending input before dispatch and leaves sibling pages running', async () => {
  const f = await setup();
  const store = createLocalBrowserProfileStore(
    createTestDb(),
    () => Buffer.alloc(32),
    (id, agent) => {
      void f.service.revokeProfileAccess(id, agent);
    }
  );
  const profile = store.create('Work');
  store.bind(profile.id, 'agent-atlas', '/agents/atlas');
  await f.open('chat-a', profile.id);
  await f.open('chat-b', 'other');
  const a = f.contexts[0].pages[0];
  const observation = await f.observe('chat-a');
  const gate = heldProtocolCall();
  const element = await a.locator.elementHandle();
  a.locator.elementHandle.mockImplementationOnce(async () => {
    await gate.run();
    return element;
  });
  const action = f
    .act('chat-a', { kind: 'scroll', revision: observation.revision, deltaX: 0, deltaY: 10 })
    .then(
      () => 'resolved',
      () => 'refused'
    );
  await gate.started;
  store.unbind(profile.id, 'agent-atlas');
  gate.release();
  expect(await action).toBe('refused');
  expect(a.wheel).not.toHaveBeenCalled();
  await expect(f.observe('chat-b')).resolves.toBeDefined();
});

it('unsharing a held page retains it for the person without restoring an agent grant', async () => {
  const f = await setup();
  await f.open('chat-a');
  const page = f.contexts[0].pages[0].page;
  const session = f.service.personSession('chat-a');
  await session.handover.takeOver();
  await f.service.revokeProfileAccess('agent-atlas', 'agent-atlas');
  expect(page.isClosed()).toBe(false);
  await expect(session.handover.resume()).rejects.toMatchObject({ code: 'profile_not_allowed' });
  await expect(session.observe()).rejects.toMatchObject({ code: 'profile_not_allowed' });
});

it('a removed chat closes only agent-held pages and keeps person-held pages ungranted', async () => {
  const f = await setup();
  await f.open('chat-a');
  await f.open('chat-b');
  const held = f.service.personSession('chat-b');
  await held.handover.takeOver();
  await f.service.sessionRemoved('chat-a');
  await f.service.sessionRemoved('chat-b');
  expect(f.contexts[0].pages[0].page.isClosed()).toBe(true);
  expect(f.contexts[0].pages[1].page.isClosed()).toBe(false);
  await expect(held.handover.resume()).rejects.toMatchObject({ code: 'profile_not_allowed' });
  await expect(held.observe()).rejects.toMatchObject({ code: 'profile_not_allowed' });
});

it('rechecks birth identity immediately before an effect following protocol waits', async () => {
  const f = await setup();
  let current = 'agent-atlas';
  f.service.useProfileAccess(
    async () => undefined,
    () => true,
    (_profile, _chat, birth) => () => {
      if (!birth || birth !== current)
        throw new LocalBrowserError('profile_not_allowed', 'This browser is unavailable.');
    }
  );
  await f.open('chat-a');
  const a = f.contexts[0].pages[0];
  const observation = await f.observe('chat-a');
  const gate = heldProtocolCall();
  const element = await a.locator.elementHandle();
  a.locator.elementHandle.mockImplementationOnce(async () => {
    await gate.run();
    return element;
  });
  const action = f
    .act('chat-a', { kind: 'scroll', revision: observation.revision, deltaX: 0, deltaY: 10 })
    .then(
      () => 'resolved',
      () => 'refused'
    );
  await gate.started;
  current = 'agent-other';
  gate.release();
  expect(await action).toBe('refused');
  expect(a.wheel).not.toHaveBeenCalled();
});

it('a viewer stops being current when its birth identity changes without an agent call', async () => {
  const f = await setup();
  let allowed = true;
  f.service.useProfileAccess(
    async () => undefined,
    () => true,
    () => () => {
      if (!allowed)
        throw new LocalBrowserError('profile_not_allowed', 'This browser is unavailable.');
    }
  );
  await f.open('chat-a');
  const viewer = await f.service.pageBroker.captureViewerLease('chat-a', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'view',
  });
  const revoked = vi.fn();
  viewer.onRevoked(revoked);
  allowed = false;
  expect(viewer.isCurrent()).toBe(false);
  expect(revoked).toHaveBeenCalledTimes(1);
});
