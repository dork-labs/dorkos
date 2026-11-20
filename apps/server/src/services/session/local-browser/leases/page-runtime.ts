import type { BrowserActionFlight } from '../lifecycle.js';
import { BrowserPageCustody } from './page-custody.js';
import { BrowserPageOperations } from './page-operations.js';
import { BrowserPageWork } from './page-work.js';

/** Physical work and admission belong to one exact Page, independent of the profile host. */
export class BrowserPageRuntime {
  readonly work = new BrowserPageWork();
  readonly custody: BrowserPageCustody;
  operations: BrowserPageOperations;
  constructor(
    invalidate: () => void,
    actions: BrowserActionFlight,
    drainProfile?: () => Promise<void>
  ) {
    const drain = () => this.work.drainWith(actions);
    this.custody = new BrowserPageCustody(invalidate, async () => {
      await Promise.all([drain(), drainProfile?.()]);
    });
    this.operations = new BrowserPageOperations(drain);
  }
  /** Called only once old-Page closure acknowledged and the new Page was acquired. */
  beginPage(actions: BrowserActionFlight): void {
    this.work.beginPage();
    this.operations = new BrowserPageOperations(() => this.work.drainWith(actions));
    this.custody.beginPage();
  }
}
