import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { ChatWindowPolicy } from './window-policy.js';
import { TabBroker } from '../broker/tab-broker.js';
import type { TabOwnershipRecord } from '../broker/types.js';
import { LocalBrowserError } from '../errors.js';

/** Host-owned page handles and audit storage; the broker itself has no server dependencies. */
export class BrowserTabRegistry {
  readonly pages = new Map<string, Page>();
  readonly broker: TabBroker;
  readonly windows = new Map<string, ChatWindowPolicy>();
  async prepare(page: Page, id: string): Promise<void> {
    const policy = new ChatWindowPolicy(page);
    await policy.install(() => this.broker.popupBlocked(id));
    this.windows.set(id, policy);
  }
  private registered = new WeakMap<Page, string>();
  private auditUnavailable = false;
  onClosed: (id: string) => void = () => undefined;

  constructor(dataDirectory: string) {
    const rows = new Map<string, TabOwnershipRecord>();
    const directory = path.join(dataDirectory, 'local-browser');
    this.broker = new TabBroker({
      // A chat restart keeps this host alive. A server restart never infers ownership from
      // restored browser tabs: the person must explicitly share those pages again.
      store: {
        get: (id) => rows.get(id),
        save: (row) => {
          rows.set(row.pageId, { ...row });
        },
        delete: (id) => {
          rows.delete(id);
        },
      },
      audit: (event) => {
        try {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          appendFileSync(
            path.join(directory, 'tabs.jsonl'),
            JSON.stringify({
              ...event,
              agentId: event.agentId === 'unidentified' ? null : event.agentId,
            }) + '\n',
            { mode: 0o600, flush: true }
          );
        } catch {
          // Page events must not throw into Playwright. No agent read or effect can pass
          // assertAvailable after a receipt is lost, including an in-flight answer.
          this.auditUnavailable = true;
        }
      },
    });
  }

  /** Register a page as the person's first; only a person's Open grants an owner. */
  track(page: Page): string {
    const known = this.registered.get(page);
    if (known) return known;
    const id = this.broker.register(page);
    this.pages.set(id, page);
    this.registered.set(page, id);
    page.on('close', () => {
      this.windows.delete(id);
      this.pages.delete(id);
      this.registered.delete(page);
      this.onClosed(id);
    });
    return id;
  }

  /** Durable audit failure stops admission across the window rather than losing receipts silently. */
  assertAvailable(): void {
    if (this.auditUnavailable)
      throw new LocalBrowserError(
        'audit_unavailable',
        'Couldn’t record browser activity. Restart DorkOS before continuing.'
      );
  }

  /** A closed window invalidates all leases, including those waiting in queues. */
  close(): void {
    this.broker.close();
    this.pages.clear();
    this.windows.clear();
    this.registered = new WeakMap();
  }
}
