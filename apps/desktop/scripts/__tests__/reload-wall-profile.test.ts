import { expect, it, vi } from 'vitest';
import { leaseFixture } from '../../../server/src/services/session/local-browser/__tests__/page-leases-fixture.js';
import { PUBLIC_CHROME_CHAT } from '../local-browser-ci/public-chrome-profile.js';
import { openReloadWallBrowser } from '../local-browser-ci/reload-wall-profile.js';
import { browserProofPage } from '../local-browser-ci/proof-page.js';

// The native reload witness must also work with Electron's SQLite ABI installed.
vi.mock('better-sqlite3', () => ({
  default: class {
    constructor() {
      throw new Error('The native reload witness cannot construct SQLite.');
    }
  },
}));

it('initializes the reload witness as a person and keeps its work on the same chat page', async () => {
  vi.stubEnv('CI', 'true');
  vi.stubEnv('DISPLAY', ':0'); // The backend is fake, including on headless CI.
  const page = await leaseFixture();
  const url = 'http://127.0.0.1:12345/'; // Navigation is fake; no listener or browser runs.
  const fixture = await openReloadWallBrowser(page.directory, page.backend, url);
  try {
    expect(fixture.profiles.get('agent-made-up-ci-agent')?.agentIds).toEqual(['made-up-ci-agent']);
    expect(fixture.profiles.get('default')?.agentIds).toEqual([]);
    expect(page.backend.launch).toHaveBeenCalledOnce();
    expect(fixture.session).toBe(fixture.browser.personSession(PUBLIC_CHROME_CHAT));
    expect(fixture.session).not.toBe(fixture.browser.personSession(null));
    expect((await browserProofPage(fixture.session.pageConnection())).url()).toBe(url);
    const reused = await fixture.browser.open({
      mode: 'new-window',
      sessionId: PUBLIC_CHROME_CHAT,
    });
    expect(reused.connectionId).toBe((await fixture.session.state()).connectionId);
    expect(page.backend.launch).toHaveBeenCalledOnce();
    await expect(
      fixture.browser.openForPerson({ mode: 'new-window', sessionId: 'unregistered-chat' })
    ).rejects.toMatchObject({ code: 'profile_not_allowed' });
    const lease = fixture.browser.leaseFor(PUBLIC_CHROME_CHAT);
    fixture.profiles.unbind('agent-made-up-ci-agent', 'made-up-ci-agent');
    expect(() => lease.assertCurrent()).toThrow();
  } finally {
    await fixture.close();
    await page.cleanup();
    vi.unstubAllEnvs();
  }
});
