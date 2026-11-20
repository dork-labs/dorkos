import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { LocalBrowserError } from '../errors.js';
import { PAGE_READ_RESPONSE_TIMEOUT_MS, responseDeadline } from '../lifecycle.js';
import type { PageWorkTracker } from './page-work.js';

export interface BrowserLeaseIdentity {
  sessionId: string | null;
  agentId: string | null;
  profileId: string | null;
  connectionId: string;
  leaseId: string;
}
export type BrowserLeaseEvent =
  | { event: 'opened' | 'closed'; actor: 'person' | 'server' }
  | { event: 'held' | 'handed-back' | 'paused' | 'resumed'; actor: 'person' }
  | { event: 'origin'; actor: 'server' | 'person'; origin: string }
  | { event: 'person-input'; actor: 'person'; input: string };
export type BrowserLeaseAuditRecord = BrowserLeaseIdentity & BrowserLeaseEvent & { at: string };
export type BrowserLeaseAuditWriter = (record: BrowserLeaseAuditRecord) => Promise<void>;

/** Metadata-only lifecycle journal; callers never supply page text, input values or URL paths. */
export class BrowserLeaseJournal {
  private identity?: BrowserLeaseIdentity;
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private pending = 0;
  private origins = new Set<string>();
  constructor(
    directory: string,
    private readonly track: PageWorkTracker,
    private readonly writer: BrowserLeaseAuditWriter = leaseAuditWriter(directory),
    private readonly originActor: () => 'server' | 'person' = () => 'server'
  ) {}

  async open(identity: BrowserLeaseIdentity, page: Page): Promise<void> {
    // Recovery starts a new persisted grant only after every prior physical
    // write has settled; late failure cannot poison the new identity.
    await this.tail;
    this.failed = false;
    this.identity = Object.freeze({ ...identity });
    this.origins.clear();
    await this.record({ event: 'opened', actor: 'person' });
    this.addresses(page);
    await this.ready();
  }
  get isReady(): boolean {
    return !this.failed && this.pending === 0;
  }
  get healthy(): boolean {
    return !this.failed;
  }
  assertHealthy(): void {
    if (this.failed) throw unavailable();
  }
  async close(): Promise<void> {
    void this.record({ event: 'closed', actor: 'server' }).catch(() => undefined);
    this.identity = undefined;
    // Native-close and explicit shutdown can meet here. Every caller drains the
    // physical write, including writes whose response deadline already expired.
    await this.tail;
  }
  assertAdmitted(): void {
    if (this.failed || this.pending) throw unavailable();
  }
  async ready(): Promise<void> {
    await responseDeadline(this.tail, PAGE_READ_RESPONSE_TIMEOUT_MS, unavailable);
    this.assertAdmitted();
  }
  /** Playwright's cached addresses are sufficient; no document read is started. */
  addresses(page: Page): void {
    if (!this.identity || page.isClosed()) return;
    const origins = new Set(
      [page.url(), ...page.frames().map((frame) => frame.url())].flatMap((url) => {
        try {
          const parsed = new URL(url);
          return /^https?:$/.test(parsed.protocol) ? [parsed.origin] : [];
        } catch {
          return [];
        }
      })
    );
    for (const origin of origins) {
      if (!this.origins.has(origin))
        void this.record({ event: 'origin', actor: this.originActor(), origin }).catch(
          () => undefined
        );
    }
    this.origins = origins;
  }
  record(event: BrowserLeaseEvent): Promise<void> {
    if (!this.identity) return Promise.resolve();
    const record = { ...this.identity, ...event, at: new Date().toISOString() };
    this.pending++;
    const writing = this.tail.then(async () => {
      if (this.failed) throw unavailable();
      await this.writer(record);
    });
    this.tail = writing
      .catch(() => {
        this.failed = true;
      })
      .finally(() => {
        this.pending--;
      });
    this.track(this.tail);
    return responseDeadline(writing, PAGE_READ_RESPONSE_TIMEOUT_MS, unavailable).catch(() => {
      throw unavailable();
    });
  }
}
function unavailable(): LocalBrowserError {
  return new LocalBrowserError(
    'audit_unavailable',
    'Couldn’t record this browser change. Try again shortly.'
  );
}
function leaseAuditWriter(directory: string): BrowserLeaseAuditWriter {
  const folder = path.join(directory, 'local-browser');
  return async (record) => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await appendFile(path.join(folder, 'leases.jsonl'), JSON.stringify(record) + '\n', {
      mode: 0o600,
      flush: true,
    });
  };
}
