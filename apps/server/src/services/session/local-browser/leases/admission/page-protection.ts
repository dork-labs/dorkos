import type { Page } from 'playwright-core';
import type { CloudOriginEntry } from '@dorkos/shared/cloud-origin';
import { protectedPageRefusal } from '../../errors.js';

/** Pause this Page before refusing any document or frame owned by DorkOS or Cloud. */
export function refusePage(
  page: Page,
  cloudOrigins: readonly CloudOriginEntry[],
  appOrigins: readonly string[],
  pause: () => void
): void {
  const urls = [page.url(), ...page.frames().map((frame) => frame.url())];
  const refusal = protectedPageRefusal(urls, cloudOrigins, appOrigins);
  if (!refusal) return;
  pause();
  throw refusal;
}
