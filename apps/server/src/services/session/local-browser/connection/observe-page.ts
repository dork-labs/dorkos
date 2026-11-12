import type { Page } from 'playwright-core';
import type { LocalBrowserObservation } from '@dorkos/shared/local-browser';
import { LocalBrowserError } from '../errors.js';
import { observationNodes } from '../observation-nodes.js';
import { boundedPageSnapshot, boundedPageScreenshot } from '../observation-limits.js';
import { responseDeadline, PAGE_READ_RESPONSE_TIMEOUT_MS } from '../lifecycle.js';

/** A page read holds its node identities only if navigation and the admission lease stay unchanged. */
export async function observeSelectedPage(
  page: Page,
  tabId: string,
  owner: {
    revision(): number;
    frames(): number;
    refuse(): void;
    stale(): Error;
  }
) {
  const revision = owner.revision();
  const frames = owner.frames();
  let expired = false;
  const reading = observationNodes(page);
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
    const snapshot = await boundedPageSnapshot(page, 750);
    if (revision !== owner.revision() || frames !== owner.frames()) throw owner.stale();
    owner.refuse();
    const observation: LocalBrowserObservation = { revision, snapshot, url: page.url(), tabId };
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
  refuse: () => void
) {
  const before = lease();
  refuse();
  const bytes = await boundedPageScreenshot(page, 750);
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
