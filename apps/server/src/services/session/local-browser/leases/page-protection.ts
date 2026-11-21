import type { Page } from 'playwright-core';
import type { CloudOriginEntry } from '@dorkos/shared/cloud-origin';
import type { BrowserHandover } from '../handover.js';
import { protectedPageRefusal } from '../errors.js';

/** The existing origin policy over captured host metadata, without any document read. */
export class BrowserPageProtection {
  constructor(
    private readonly handover: BrowserHandover,
    private readonly profileId: () => string | null,
    private readonly cloudOrigins: () => readonly CloudOriginEntry[],
    private readonly appOrigins: () => readonly string[],
    private readonly pause: () => void
  ) {}
  private verdict(page: Page) {
    return protectedPageRefusal(
      [page.url(), ...page.frames().map((frame) => frame.url())],
      this.cloudOrigins(),
      this.appOrigins()
    );
  }
  /** Person input never attaches to a plain sign-in or protected page. */
  allowed(page: Page): boolean {
    return (
      !this.handover.signInHoldsProfile(this.profileId()) &&
      /^https?:/.test(page.url()) &&
      this.verdict(page) === null
    );
  }
  /** Watching keeps PR1's protected-origin and sign-in fences, including blank pages. */
  watch(page: Page): void {
    if (this.handover.signInHoldsProfile(this.profileId())) throw new Error('viewer_unavailable');
    this.refuse(page);
  }
  /** Agent reads retain their existing pause and invalidation behavior. */
  refuse(page: Page): void {
    const refusal = this.verdict(page);
    if (!refusal) return;
    this.pause();
    throw refusal;
  }
}
