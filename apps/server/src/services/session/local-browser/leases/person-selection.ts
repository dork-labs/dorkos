import type { BrowserPageState } from './page-state.js';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from '../errors.js';
import { PAGE_READ_RESPONSE_TIMEOUT_MS, responseDeadline } from '../lifecycle.js';

/** Person-only selection inside an already scoped Page set; never a browser enumeration. */
export async function selectPersonPage(
  state: BrowserPageState,
  id: string,
  describe: () => Promise<LocalBrowserState>
): Promise<LocalBrowserState> {
  const page = state.tabs.get(id);
  if (!page) throw new LocalBrowserError('closed', 'That tab closed. Choose another tab.');
  state.selectedTabId = id;
  state.metadata.refresh(page);
  state.invalidate();
  const revision = state.revision;
  const stale = () =>
    new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.');
  await responseDeadline(page.bringToFront(), PAGE_READ_RESPONSE_TIMEOUT_MS, () => {
    state.invalidate();
    return stale();
  });
  if (revision !== state.revision) throw stale();
  return describe();
}
