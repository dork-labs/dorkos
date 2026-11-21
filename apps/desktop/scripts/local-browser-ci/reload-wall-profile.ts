import type { LocalBrowserBackend } from '../../../server/src/services/session/local-browser/playwright-backend.js';
import type { LocalBrowserPageSession } from '../../../server/src/services/session/local-browser/leases/page-session.js';
import { createPublicChromeBrowser, PUBLIC_CHROME_CHAT } from './public-chrome-profile.js';

/** Initialize the invented chat as a person before the reload witness uses its page. */
export async function openReloadWallBrowser(
  directory: string,
  backend: LocalBrowserBackend,
  url: string
): Promise<
  Awaited<ReturnType<typeof createPublicChromeBrowser>> & { session: LocalBrowserPageSession }
> {
  const fixture = await createPublicChromeBrowser(directory, backend);
  try {
    await fixture.browser.openForPerson({ mode: 'new-window', sessionId: PUBLIC_CHROME_CHAT });
    await fixture.browser.open({ mode: 'new-window', sessionId: PUBLIC_CHROME_CHAT, url });
    return { ...fixture, session: fixture.browser.personSession(PUBLIC_CHROME_CHAT) };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
