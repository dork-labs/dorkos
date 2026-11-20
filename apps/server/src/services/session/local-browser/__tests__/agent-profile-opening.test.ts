import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { profileLeaseFixture } from './agent-profile-fixture.js';
import { heldProtocolCall } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof profileLeaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await profileLeaseFixture();
  fixtures.push(f);
  return f;
}

it('opens every agent request in its own window, never attaching the embedded bridge', async () => {
  const f = await setup();
  const personal = path.join(f.directory, 'browser-profiles', 'default');
  await mkdir(personal, { recursive: true });
  await writeFile(path.join(personal, 'Cookies'), 'example-person-data');
  for (const sessionId of ['atlas', 'bolt']) {
    const result = await f.personOpen(sessionId);
    expect(result.mode).toBe('new-window');
    expect(result.profile?.id).toBe(`agent-${sessionId}`);
    await expect(
      readFile(path.join(f.directory, 'browser-profiles', `agent-${sessionId}`, 'Cookies'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(personal, 'Cookies'), 'utf8')).toBe('example-person-data');
  }
  expect(f.backend.connect).not.toHaveBeenCalled();
});

it('keeps the person-alone browser and existing saved data', async () => {
  const f = await setup();
  const folder = path.join(f.directory, 'browser-profiles', 'default');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Cookies'), 'example-person-data');
  const result = await f.service.openForPerson({ mode: 'new-window' });
  expect(result).toMatchObject({
    mode: 'new-window',
    profile: { id: 'default', label: 'Your browser', agentId: null },
  });
  expect(f.profiles.get('default')?.agentIds).toEqual([]);
  expect(await readFile(path.join(folder, 'Cookies'), 'utf8')).toBe('example-person-data');
});

it('closes only its owned late launch before switching to a shared profile', async () => {
  const f = await setup();
  const launch = vi.mocked(f.backend.launch).getMockImplementation()!;
  const gate = heldProtocolCall();
  vi.mocked(f.backend.launch).mockImplementationOnce(async (...args) => {
    await gate.run();
    return launch(...args);
  });
  const opening = f.personOpen('atlas');
  const outcome = opening.catch((error: unknown) => error);
  await gate.started;
  const closing = f.service.personSession('atlas').disconnect();
  gate.release();
  await closing;
  expect(await outcome).toMatchObject({ code: 'cancelled' });
  expect(f.contexts[0]!.context.close).toHaveBeenCalled();
  f.profiles.bind('default', 'atlas', '/agents/atlas');
  const shared = await f.personOpen('atlas', 'default');
  expect(shared.profile?.id).toBe('default');
  expect(shared.mode).toBe('new-window');
  expect(f.backend.connect).not.toHaveBeenCalled();
});

it('owns setup while profile resolution is pending and cancels before launching anything', async () => {
  const f = await setup();
  const gate = heldProtocolCall();
  f.service.useProfileSelection(f.selection.select, async (input) => {
    await gate.run();
    return f.selection.initialize(input);
  });
  const opening = f.personOpen('atlas');
  const outcome = opening.catch((error: unknown) => error);
  await gate.started;
  await expect(f.personOpen('atlas')).rejects.toMatchObject({ code: 'busy' });
  await f.service.personSession('atlas').disconnect();
  gate.release();
  expect(await outcome).toMatchObject({ code: 'cancelled' });
  expect(f.backend.launch).not.toHaveBeenCalled();
});

it('service.open and capability calls cannot initialize or bind an unopened agent profile', async () => {
  const f = await setup();
  await expect(f.service.open({ mode: 'embedded', sessionId: 'atlas' })).rejects.toMatchObject({
    code: 'profile_not_allowed',
  });
  await expect(f.state('bolt')).rejects.toBeDefined();
  expect(f.profiles.list()).toEqual([]);
  expect(await readdir(f.directory)).not.toContain('browser-profiles');
});

it('shares sign-ins between two chats of one agent but keeps every chat page isolated', async () => {
  const f = await setup();
  const first = await f.personOpen('atlas');
  const second = await f.personOpen('atlas-two');
  const third = await f.personOpen('bolt');
  await f.service.openForPerson({ mode: 'new-window' });
  expect(first.profile?.id).toBe(second.profile?.id);
  expect(third.profile?.id).not.toBe(first.profile?.id);
  expect(f.contexts).toHaveLength(3);
  const a = await f.observe('atlas');
  const b = await f.observe('atlas-two');
  expect(a.tabId).not.toBe(b.tabId);
  await expect(
    f.act('atlas', {
      kind: 'click',
      revision: a.revision,
      tabId: b.tabId,
      role: 'button',
      name: 'Save',
    } as never)
  ).rejects.toBeDefined();
  await f.act('atlas', { kind: 'scroll', revision: a.revision, deltaX: 0, deltaY: 10 });
  expect(f.contexts[0]!.pages[0]!.wheel).toHaveBeenCalledExactlyOnceWith(0, 10);
  expect(f.contexts[0]!.pages[1]!.wheel).not.toHaveBeenCalled();
  expect((await f.state('atlas')).tabs).toHaveLength(1);
  expect(JSON.stringify(await f.state('atlas'))).not.toContain('bolt');
});

it('captures a birth proof for default and refuses the captured lease synchronously after unshare', async () => {
  const f = await setup();
  await f.personOpen('atlas');
  f.profiles.bind('default', 'atlas', '/agents/atlas');
  await f.personOpen('atlas', 'default');
  const lease = f.service.leaseFor('atlas');
  f.profiles.unbind('default', 'atlas');
  expect(() => lease.assertCurrent()).toThrow();
  await expect(f.state('atlas')).rejects.toMatchObject({
    payload: { code: 'profile_not_allowed' },
  });
});

it('refuses a client-selected foreign profile before replacing its live page', async () => {
  const f = await setup();
  await f.personOpen('atlas');
  await f.personOpen('bolt');
  const before = await f.state('atlas');
  await expect(f.personOpen('atlas', 'agent-bolt')).rejects.toMatchObject({
    code: 'profile_not_allowed',
  });
  expect((await f.state('atlas')).connectionId).toBe(before.connectionId);
  expect(f.backend.launch).toHaveBeenCalledTimes(2);
});

it('checks the default birth proof synchronously even without a revocation notification', async () => {
  const f = await setup();
  await f.personOpen('atlas');
  f.profiles.bind('default', 'atlas', '/agents/atlas');
  await f.personOpen('atlas', 'default');
  const lease = f.service.leaseFor('atlas');
  f.profiles.bind('default', 'atlas', '/agents/changed');
  expect(() => lease.assertCurrent()).toThrow();
});

it('person custody blocks sibling chats on the same profile but never another agent profile', async () => {
  const f = await setup();
  await f.personOpen('atlas');
  await f.personOpen('atlas-two');
  await f.personOpen('bolt');
  await f.service.personSession('atlas').handover.takeOver();
  const observed = await f.observe('atlas-two');
  await expect(
    f.act('atlas-two', { kind: 'scroll', revision: observed.revision, deltaX: 0, deltaY: 10 })
  ).rejects.toMatchObject({ payload: { code: 'profile_held' } });
  await expect(f.observe('bolt')).resolves.toBeDefined();
  const result = await f.state('missing').catch((error: unknown) => error);
  for (const foreign of ['atlas', 'bolt', 'page-'])
    expect(JSON.stringify(result)).not.toContain(foreign);
});

it('sign-in retains exclusive profile admission when two chats share an agent profile', async () => {
  const f = await setup();
  await f.personOpen('atlas');
  await f.personOpen('atlas-two');
  await f.personOpen('bolt');
  await expect(
    f.service.personSession('atlas').handover.signIn({ url: 'https://login.example.test/' })
  ).rejects.toMatchObject({ code: 'profile_busy' });
  expect(f.signIn).not.toHaveBeenCalled();
  await expect(f.observe('bolt')).resolves.toBeDefined();
});

it('unsharing default synchronously revokes its live session without another agent call', async () => {
  const f = await setup();
  await f.personOpen('atlas');
  f.profiles.bind('default', 'atlas', '/agents/atlas');
  await f.personOpen('atlas', 'default');
  const session = f.service.personSession('atlas');
  const viewer = await f.service.pageBroker.captureViewerLease('atlas', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'view',
  });
  const revoked = vi.fn();
  viewer.onRevoked(revoked);
  expect((await session.state()).paused).toBe(false);
  f.profiles.unbind('default', 'atlas');
  // No isCurrent/assertCurrent/agent call may supply a lazy proof check here.
  expect(revoked).toHaveBeenCalledExactlyOnceWith();
  expect((await session.state()).paused).toBe(true);
  await viewer.close();
});
