import { logger } from '../lib/logger.js';
import { desktopBrowserPort } from '../services/session/local-browser/desktop-bridge.js';
import { LocalBrowserService } from '../services/session/local-browser/service.js';

// Consume the shell-only bridge handoff during module initialization, before harness children start.
const embedded = desktopBrowserPort();
let current: LocalBrowserService | undefined;

/** Keep the human routes, runtime tools, and test runtime on one boot-owned browser service. */
export const localBrowserHost = {
  start(dataDirectory: string): LocalBrowserService {
    current ??= new LocalBrowserService(dataDirectory, embedded);
    return current;
  },
  async close(): Promise<void> {
    try {
      await current?.disconnect();
      current = undefined;
    } catch {
      // A retained closing lease must not prevent other services from shutting down.
      // Playwright's process-exit handler still owns its launched browser processes.
      logger.warn('[Browser] Browser is still closing during shutdown');
    }
  },
};
