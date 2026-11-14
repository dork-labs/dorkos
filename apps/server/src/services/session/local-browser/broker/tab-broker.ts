import { randomUUID } from 'node:crypto';
import { HeldSignInPopup } from './signin-popup.js';
import type { Frame, Page } from 'playwright-core';
import { TabBrokerError, pageHeld, tabGone, tabLocked } from './errors.js';
import type {
  TabAuditEvent,
  TabLease,
  TabOwnershipRecord,
  TabOwnershipStore,
  TabPrincipal,
  TabTakeover,
} from './types.js';

/** Limits and host-owned persistence/audit ports. No DorkOS services enter this boundary. */
export interface TabBrokerOptions {
  readonly store: TabOwnershipStore;
  readonly audit: (event: TabAuditEvent) => void;
  readonly now?: () => number;
  readonly maxPagesPerOwner?: number;
  readonly maxPages?: number;
  readonly maxQueuedPerPage?: number;
}

interface Entry {
  readonly page: Page;
  record: TabOwnershipRecord;
  lease: TabLease | null;
  generation: number;
  tail: Promise<void>;
  queued: number;
  unwatch: () => void;
}
const DEFAULT_PAGES_PER_OWNER = 1;
export const MAX_CHAT_TABS = 6;
export const CHAT_TAB_LIMIT_MESSAGE =
  'All 6 chat tabs are in use. Wait for one to free up, or ask the person to close one.';
const DEFAULT_PAGES = MAX_CHAT_TABS;
const DEFAULT_QUEUE = 32;

function sameOwner(record: TabPrincipal | TabOwnershipRecord, principal: TabPrincipal): boolean {
  return record.ownerId === principal.ownerId && record.agentId === principal.agentId;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('Broker limits must be positive integers.');
  return value;
}

/**
 * Owns page grants, takeover and queues over existing Playwright pages. It never launches a browser.
 * Only trusted person-facing host code calls bind/register/hold; agent code gets scoped leases and run.
 */
export class TabBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly pages = new WeakMap<Page, string>();
  private readonly origins = new Map<string, string>();
  originFor(pageId: string): string {
    return this.origins.get(pageId) ?? '';
  }
  private readonly now: () => number;
  private readonly perOwner: number;
  private readonly total: number;
  private readonly queueLimit: number;
  private takeover?: { entry: Entry; token: object; taken: boolean; popup: HeldSignInPopup };
  private readonly serverPopups = new WeakSet<Page>();
  private readonly blocked = new Set<string>();

  constructor(private readonly options: TabBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.perOwner = positive(options.maxPagesPerOwner ?? DEFAULT_PAGES_PER_OWNER);
    this.total = positive(options.maxPages ?? DEFAULT_PAGES);
    this.queueLimit = positive(options.maxQueuedPerPage ?? DEFAULT_QUEUE);
  }

  /** Register a person's page or reconnect one using its host-stamped id. Grants are never inferred. */
  register(page: Page, pageId: string = randomUUID()): string {
    return this.registerPage(page, pageId).record.pageId;
  }

  /** An explicit grant from the person; never call this from an agent-supplied page id. */
  bind(page: Page, principal: TabPrincipal): TabLease {
    if (this.serverPopups.has(page)) throw pageHeld();
    const knownId = this.pages.get(page);
    const known = knownId ? this.entries.get(knownId) : undefined;
    if (known?.record.held) throw pageHeld();
    if (known?.lease) {
      if (!sameOwner(known.record, principal)) throw tabLocked();
      return known.lease;
    }
    if (known?.record.ownerId && !sameOwner(known.record, principal)) throw tabLocked();
    if (!known?.record.ownerId) this.assertCapacity(principal);
    const entry = known ?? this.registerPage(page, randomUUID(), principal);
    if (entry.page.isClosed()) throw tabGone();
    // Pick identity fields explicitly: an opener's lease also carries its own page id.
    const identity = { ownerId: principal.ownerId, agentId: principal.agentId };
    const lease = Object.freeze({ pageId: entry.record.pageId, ...identity });
    this.update(entry, { ...identity, held: false });
    entry.lease = lease;
    entry.generation++;
    this.emit(entry, 'bind');
    this.origin(entry, page.url());
    return lease;
  }

  /** A person's Hand back can restore this chat's reserved, revoked held page only. */
  personResume(page: Page, principal: TabPrincipal): TabLease {
    const id = this.pages.get(page);
    const entry = id ? this.entry(id) : undefined;
    if (!entry || !sameOwner(entry.record, principal)) throw tabLocked();
    if (entry.record.held && !entry.lease) this.update(entry, { held: false });
    return this.bind(page, principal);
  }

  /** Resolve a page solely against the host's authenticated caller, without leaking other owners. */
  leaseFor(principal: TabPrincipal, pageId: string): TabLease {
    const entry = this.entry(pageId);
    if (!sameOwner(entry.record, principal)) throw tabLocked();
    if (entry.record.held) throw pageHeld();
    if (!entry.lease) throw tabLocked();
    return entry.lease;
  }

  /** Pages an agent may see; held and unowned pages are excluded. */
  list(principal: TabPrincipal): TabLease[] {
    const leases: TabLease[] = [];
    for (const entry of this.entries.values()) {
      if (entry.page.isClosed()) {
        this.closed(entry);
        continue;
      }
      if (entry.lease && !entry.record.held && sameOwner(entry.record, principal))
        leases.push(entry.lease);
    }
    return leases;
  }

  /** A restarted host may recover only that same principal's registered orphan pages. */
  adopt(principal: TabPrincipal): TabLease[] {
    return this.list(principal);
  }

  /** Return the page to the person. Existing handles and queued work are permanently revoked. */
  release(lease: TabLease): void {
    const entry = this.checked(lease, true);
    this.revoke(entry);
  }

  /**
   * Run any read, screenshot or action through the same page queue. Admission is checked again
   * after every queued wait and before returning data. Multi-step effects must call assertActive.
   */
  async run<T>(
    lease: TabLease,
    operation: (page: Page, assertActive: () => void) => Promise<T>
  ): Promise<T> {
    const entry = this.checked(lease);
    const generation = entry.generation;
    if (entry.queued >= this.queueLimit)
      throw new TabBrokerError('queue_full', 'This tab is busy. Wait before trying again.');
    const assertActive = () => {
      this.checked(lease);
      if (entry.generation !== generation) throw tabLocked();
    };
    entry.queued++;
    const result = entry.tail.then(async () => {
      assertActive();
      this.update(entry, {});
      const answer = await operation(entry.page, assertActive);
      assertActive();
      this.update(entry, {});
      return answer;
    });
    // Keep the physical effect's queue slot until it settles, even if the caller stops waiting.
    entry.tail = result.then(
      () => undefined,
      () => undefined
    );
    try {
      return await result;
    } finally {
      entry.queued--;
    }
  }

  /** Only one person takeover is active in the browser. Other owners' pages keep running. */
  hold(lease: TabLease): TabTakeover {
    const entry = this.checked(lease);
    if (this.takeover)
      throw new TabBrokerError(
        'handoff_active',
        'Another tab needs the person. Wait until they finish.'
      );
    const token = {};
    this.update(entry, { held: true });
    entry.generation++;
    this.takeover = {
      entry,
      token,
      taken: false,
      popup: new HeldSignInPopup(lease.pageId, lease.ownerId, this.options.audit, this.now),
    };
    this.emit(entry, 'hold');
    const current = () => {
      if (this.takeover?.token !== token) throw tabLocked();
      this.checked(lease, true);
    };
    return Object.freeze({
      pageId: lease.pageId,
      take: () => {
        current();
        this.takeover!.taken = true;
      },
      handBack: () => {
        current();
        this.update(entry, { held: false });
        entry.generation++;
        this.takeover = undefined;
        this.emit(entry, 'hand_back');
      },
      abandon: () => {
        current();
        this.revoke(entry);
      },
    });
  }

  /** Disconnect never gives a held page to an agent. The person keeps the live tab. */
  disconnect(principal: TabPrincipal): void {
    for (const entry of this.entries.values())
      if (sameOwner(entry.record, principal)) this.revoke(entry);
  }

  /** A closed window invalidates every handle and removes listeners, without closing any other resource. */
  close(): void {
    for (const entry of [...this.entries.values()]) this.closed(entry);
  }

  private registerPage(page: Page, pageId: string, principal?: TabPrincipal): Entry {
    if (this.serverPopups.has(page)) throw pageHeld();
    if (page.isClosed()) throw tabGone();
    const known = this.pages.get(page);
    if (known) return this.entry(known);
    if (this.entries.has(pageId)) throw tabLocked();
    const saved = this.options.store.get(pageId);
    // A persisted person takeover cannot become an agent grant on reconnect.
    const owner = saved?.held ? null : (saved ?? principal);
    const record: TabOwnershipRecord = {
      pageId,
      ownerId: owner?.ownerId ?? null,
      agentId: owner?.agentId ?? null,
      held: false,
      lastActiveAt: this.now(),
    };
    if (record.ownerId && record.agentId)
      this.assertCapacity({ ownerId: record.ownerId, agentId: record.agentId });
    this.options.store.save(record);
    const lease =
      record.ownerId && record.agentId
        ? Object.freeze({ pageId, ownerId: record.ownerId, agentId: record.agentId })
        : null;
    const entry: Entry = {
      page,
      record,
      lease,
      generation: 0,
      tail: Promise.resolve(),
      queued: 0,
      unwatch: () => undefined,
    };
    this.entries.set(pageId, entry);
    this.pages.set(page, pageId);
    this.watch(entry);
    this.emit(entry, saved ? 'adopt' : 'open');
    return entry;
  }

  private watch(entry: Entry): void {
    const closed = () => this.closed(entry);
    const navigated = (frame: Frame) => {
      if (entry.record.ownerId) this.origin(entry, frame.url(), frame === entry.page.mainFrame());
    };
    const popup = (page: Page) => {
      // No popup, including a handoff child, can ever be rebound as an agent page.
      if (!entry.record.ownerId) return;
      this.serverPopups.add(page);
      if (entry.record.held && this.takeover?.entry === entry && this.takeover.taken)
        this.takeover.popup.accept(page);
      else if (entry.record.ownerId) {
        this.blocked.add(entry.record.pageId);
        void page.close().catch(() => undefined);
      }
    };
    entry.page.on('close', closed);
    entry.page.on('framenavigated', navigated);
    entry.page.on('popup', popup);
    entry.unwatch = () => {
      entry.page.off('close', closed);
      entry.page.off('framenavigated', navigated);
      entry.page.off('popup', popup);
    };
  }

  personHasTaken(ownerId: string): boolean {
    return this.takeover?.entry.record.ownerId === ownerId && this.takeover.taken;
  }
  async showSignIn(pageId: string): Promise<boolean> {
    return this.takeover?.entry.record.pageId === pageId ? this.takeover.popup.show() : false;
  }
  async closeSignIn(pageId: string): Promise<void> {
    if (this.takeover?.entry.record.pageId === pageId) await this.takeover.popup.close();
  }
  popupBlocked(pageId: string): void {
    this.blocked.add(pageId);
  }
  requireNoBlockedPopup(pageId: string): void {
    if (this.blocked.delete(pageId))
      throw new TabBrokerError(
        'popup_blocked',
        "This tab can't open new windows. The page tried to open one and it was blocked."
      );
  }

  private checked(lease: TabLease, allowHeld = false): Entry {
    const entry = this.entry(lease.pageId);
    if (entry.lease !== lease) throw tabLocked();
    if (entry.record.held && !allowHeld) throw pageHeld();
    return entry;
  }

  private entry(pageId: string): Entry {
    const entry = this.entries.get(pageId);
    if (!entry) throw tabGone();
    if (entry.page.isClosed()) {
      this.closed(entry);
      throw tabGone();
    }
    return entry;
  }

  /** Held chat pages keep their slot. Personal pages never spend one. */
  hasCapacity(): boolean {
    return (
      [...this.entries.values()].filter(
        (entry) => entry.record.ownerId !== null && entry.record.ownerId !== 'person'
      ).length < this.total
    );
  }

  /** Metadata for person controls only. No page addresses, titles or personal pages. */
  chatRecords(): TabOwnershipRecord[] {
    return [...this.entries.values()]
      .filter((entry) => entry.record.ownerId !== null && entry.record.ownerId !== 'person')
      .map((entry) => ({ ...entry.record }));
  }

  private assertCapacity(principal: TabPrincipal): void {
    if (principal.ownerId === 'person') return;
    const count = [...this.entries.values()].filter(
      (entry) => entry.record.ownerId === principal.ownerId
    ).length;
    if (count >= this.perOwner)
      throw new TabBrokerError('tab_limit', 'This chat already has a tab. Use its existing tab.');
    if (!this.hasCapacity()) throw new TabBrokerError('tab_limit', CHAT_TAB_LIMIT_MESSAGE);
  }

  private update(entry: Entry, patch: Partial<TabOwnershipRecord>): void {
    const record = { ...entry.record, ...patch, lastActiveAt: this.now() };
    this.options.store.save(record);
    entry.record = record;
  }

  private revoke(entry: Entry): void {
    this.emit(entry, 'release');
    // A stopped handoff is still this chat's tab, held by the person. Its slot is
    // reserved until that person closes it; revocation never makes room by eviction.
    this.update(
      entry,
      entry.record.held ? { held: true } : { ownerId: null, agentId: null, held: false }
    );
    entry.lease = null;
    entry.generation++;
    if (this.takeover?.entry === entry) {
      void this.takeover.popup.close().catch(() => undefined);
      this.takeover = undefined;
    }
  }

  private closed(entry: Entry): void {
    if (this.entries.get(entry.record.pageId) !== entry) return;
    entry.unwatch();
    this.entries.delete(entry.record.pageId);
    this.pages.delete(entry.page);
    entry.generation++;
    if (this.takeover?.entry === entry) {
      void this.takeover.popup.close().catch(() => undefined);
      this.takeover = undefined;
    }
    this.options.store.delete(entry.record.pageId);
    this.origins.delete(entry.record.pageId);
    this.emit(entry, 'close');
  }

  private origin(entry: Entry, value: string, main = true): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (!entry.record.ownerId) return;
    if (main) this.origins.set(entry.record.pageId, url.origin);
    this.emit(entry, 'origin', url.origin);
  }

  private emit(entry: Entry, kind: TabAuditEvent['kind'], origin?: string): void {
    const { pageId, ownerId, agentId, held } = entry.record;
    this.options.audit({
      kind,
      at: this.now(),
      pageId,
      ownerId,
      agentId: held ? null : agentId,
      held,
      ...(origin ? { origin } : {}),
    });
  }
}
