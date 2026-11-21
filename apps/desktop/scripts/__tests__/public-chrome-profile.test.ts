import { expect, it, vi } from 'vitest';
import { leaseFixture } from '../../../server/src/services/session/local-browser/__tests__/page-leases-fixture.js';
import {
  createPublicChromeBrowser,
  PUBLIC_CHROME_CHAT,
} from '../local-browser-ci/public-chrome-profile.js';

it('requires the person to initialize the invented agent profile before an agent can reuse it', async () => {
  vi.stubEnv('CI', 'true');
  vi.stubEnv('DISPLAY', ':0'); // The backend below is fake, including on headless CI.
  const page = await leaseFixture();
  const fixture = await createPublicChromeBrowser(page.directory, page.backend);
  try {
    const input = { mode: 'new-window' as const, sessionId: PUBLIC_CHROME_CHAT };
    await expect(fixture.browser.open(input)).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
    expect(fixture.profiles.list()).toEqual([]);
    expect(page.backend.launch).not.toHaveBeenCalled();
    const initialized = await fixture.browser.openForPerson(input);
    expect(initialized.profile?.id).toBe('agent-made-up-ci-agent');
    expect(fixture.profiles.get(initialized.profile!.id)?.agentIds).toEqual(['made-up-ci-agent']);
    expect(fixture.profiles.get('default')?.agentIds).toEqual([]);
    const reused = await fixture.browser.open(input);
    expect(reused.connectionId).toBe(initialized.connectionId);
    expect(page.backend.launch).toHaveBeenCalledOnce();
    await expect(
      fixture.browser.openForPerson({ ...input, sessionId: 'unregistered-chat' })
    ).rejects.toMatchObject({ code: 'profile_not_allowed' });
    const lease = fixture.browser.leaseFor(PUBLIC_CHROME_CHAT);
    fixture.profiles.unbind(initialized.profile!.id, 'made-up-ci-agent');
    expect(() => lease.assertCurrent()).toThrow();
  } finally {
    await fixture.close();
    await page.cleanup();
    vi.unstubAllEnvs();
  }
});
