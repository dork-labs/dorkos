import { afterEach, expect, it, vi } from 'vitest';
import { profileLeaseFixture } from './agent-profile-fixture.js';

const principal = { ownerId: 'owner', sessionId: 'app', clientId: 'client' };
const fixtures: Awaited<ReturnType<typeof profileLeaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function setup(profileId: string) {
  const f = await profileLeaseFixture();
  fixtures.push(f);
  await f.personOpen('atlas');
  if (profileId === 'default') {
    f.profiles.bind('default', 'atlas', '/agents/atlas');
    await f.personOpen('atlas', 'default');
  }
  return f;
}

it.each(['default', 'agent-atlas'])(
  'unsharing %s revokes an already captured production viewer immediately',
  async (profileId) => {
    const f = await setup(profileId);
    const authorize = vi.spyOn(f.service.personSession('atlas'), 'requireProfileAccess');
    const viewer = await f.service.viewerPages.resolve('atlas', principal, 'view');
    expect(authorize).toHaveBeenCalledWith('atlas');
    await expect(viewer.assertCurrent()).resolves.toBeUndefined();
    expect(viewer.signal.aborted).toBe(false);
    f.profiles.unbind(profileId, 'atlas');
    // Revocation must notify the live viewer without an agent call or lazy viewer check.
    expect(viewer.signal.aborted).toBe(true);
    await expect(viewer.assertCurrent()).rejects.toMatchObject({ code: 'viewer_unavailable' });
    await expect(f.service.viewerPages.resolve('atlas', principal, 'later')).rejects.toMatchObject({
      code: 'viewer_unavailable',
    });
    await viewer.close();
  }
);

it('the default birth proof fences a viewer when binding facts change without an unshare', async () => {
  const f = await setup('default');
  const viewer = await f.service.viewerPages.resolve('atlas', principal, 'view');
  // Rebinding supplies no unshare notification; the immutable birth proof must still refuse.
  f.profiles.bind('default', 'atlas', '/agents/changed');
  expect(() => viewer.assertLive()).toThrow(
    expect.objectContaining({ code: 'viewer_unavailable' })
  );
  expect(viewer.signal.aborted).toBe(true);
  await viewer.close();
});
