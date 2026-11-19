import type { Page } from 'playwright-core';
import { BrowserViewerBinding } from './page-binding.js';
import {
  localBrowserCapabilities,
  type LocalBrowserHostFacts,
} from '../local-browser/presentation.js';
import { env } from '../../../env.js';

/** Only the current holder's facts cross from the browser service into its viewer adapter. */
export interface ServiceViewerFacts {
  chatId: string | null;
  profileId: string | null;
  connectionId: string | null;
  tabId: string | null;
  page: Page | undefined;
  connected: boolean;
  available: boolean;
}

/** Keep viewer selection and awaited grant checks out of the browser acquisition service. */
export function createServiceViewerBinding(
  read: () => ServiceViewerFacts,
  access: {
    requireSharedSession(chatId: string): void;
    requireProfileAccess(chatId: string): Promise<void>;
  },
  protect: () => void
): BrowserViewerBinding {
  return new BrowserViewerBinding(
    () => {
      const facts = read();
      if (
        !facts.connected ||
        !facts.available ||
        !facts.chatId ||
        !facts.connectionId ||
        !facts.tabId ||
        !facts.page ||
        facts.page.isClosed()
      )
        return undefined;
      return {
        page: facts.page,
        identity: {
          chatId: facts.chatId,
          profileId: facts.profileId,
          connectionId: facts.connectionId,
          tabId: facts.tabId,
        },
      };
    },
    async (chatId) => {
      access.requireSharedSession(chatId);
      await access.requireProfileAccess(chatId);
      access.requireSharedSession(chatId);
    },
    protect
  );
}

/** The person UI learns only whether the default-off local stream is offered. */
export function browserViewerCapabilities(embedded: boolean, host: LocalBrowserHostFacts) {
  return {
    ...localBrowserCapabilities(embedded, host),
    watchStream: env.DORKOS_AGENT_BROWSER_STREAM,
  };
}
