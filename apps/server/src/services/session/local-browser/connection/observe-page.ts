import type { Page } from 'playwright-core';
import type { LocalBrowserObservation } from '@dorkos/shared/local-browser';
import { classifyRefusal, localBrowserRefusalNext } from '@dorkos/shared/local-browser-refusal';
import { LocalBrowserError } from '../errors.js';
import { openedOverHttp } from '../history/opened-over-http.js';
import { observationNodes } from '../observation-nodes.js';
import { boundedPageSnapshot, boundedPageScreenshot } from '../observation-limits.js';
import { responseDeadline, PAGE_READ_RESPONSE_TIMEOUT_MS } from '../lifecycle.js';
import type { PageWorkTracker } from '../leases/page-work.js';

/** How long a page's title may take before the reading goes on without it. */
const PAGE_TITLE_TIMEOUT_MS = 1_000;

/** The page's `document.title`, or empty when it doesn't answer in time. Loads nothing. */
async function pageTitle(page: Page, track: PageWorkTracker): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(''), PAGE_TITLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([track(page.title()).catch(() => ''), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A page read holds its node identities only if navigation and the admission lease stay unchanged. */
export async function observeSelectedPage(
  page: Page,
  tabId: string,
  owner: {
    revision(): number;
    frames(): number;
    refuse(): void;
    stale(): Error;
    track?: PageWorkTracker;
  }
) {
  const track: PageWorkTracker = owner.track ?? ((operation) => operation);
  const revision = owner.revision();
  const frames = owner.frames();
  let expired = false;
  const reading = track(observationNodes(page));
  void reading
    .then((nodes) => {
      if (expired) void nodes.dispose().catch(() => undefined);
    })
    .catch(() => undefined);
  const nodes = await responseDeadline(reading, PAGE_READ_RESPONSE_TIMEOUT_MS, () => {
    expired = true;
    return owner.stale();
  });
  try {
    if (revision !== owner.revision()) throw owner.stale();
    owner.refuse();
    const snapshot = await track(boundedPageSnapshot(page, 750, owner.refuse));
    if (revision !== owner.revision() || frames !== owner.frames()) throw owner.stale();
    owner.refuse();
    const url = page.url();
    // A site refusing this browser is read from what was already read, never a new load
    // (DOR-4097). Its title tells a vendor's block page from an ordinary one (DOR-4662).
    const title = await pageTitle(page, track);
    owner.refuse();
    if (revision !== owner.revision() || frames !== owner.frames()) throw owner.stale();
    const refused = classifyRefusal({ url, title, text: snapshot });
    const observation: LocalBrowserObservation = {
      revision,
      snapshot,
      url,
      tabId,
      // The agent hears a page the http:// fallback opened is not secure (DOR-4450).
      ...(openedOverHttp(page) ? { openedOverHttp: true } : {}),
      ...(refused ? { refusal: { ...refused, next: localBrowserRefusalNext(refused.kind) } } : {}),
    };
    return { nodes, observation };
  } catch (error) {
    void nodes.dispose().catch(() => undefined);
    throw error;
  }
}

/** Capture only while the selected tab and its current document keep the same lease. */
export async function screenshotSelectedPage(
  page: Page,
  lease: () => { revision: number; tabId: string; frames: number },
  refuse: () => void,
  track: PageWorkTracker = (operation) => operation
) {
  const before = lease();
  refuse();
  const bytes = await track(boundedPageScreenshot(page, 750));
  refuse();
  const after = lease();
  if (
    before.revision !== after.revision ||
    before.tabId !== after.tabId ||
    before.frames !== after.frames
  )
    throw new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.');
  return {
    data: bytes.toString('base64'),
    mimeType: 'image/png',
    revision: before.revision,
    tabId: before.tabId,
  };
}
