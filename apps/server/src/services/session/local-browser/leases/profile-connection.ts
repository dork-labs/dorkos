import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { LocalBrowserBackend } from '../playwright-backend.js';
import type { BrowserPreparationListener } from '../preparation.js';
import { LocalBrowserError } from '../errors.js';
import { CLOSE_RESPONSE_TIMEOUT_MS, closingError, responseDeadline } from '../lifecycle.js';

/** A page's connection view; it cannot enumerate another chat's browser pages. */
export interface PageConnection {
  readonly generation?: string;
  pages(): Page[];
  newPage(): Promise<Page>;
  on(event: 'close', listener: () => void): unknown;
  close(): Promise<void>;
}

/** Browser acquisition at the page boundary, with the existing desktop attach path. */
export interface PageSessionBackend {
  launch(
    storage: string,
    signal?: AbortSignal,
    preparation?: BrowserPreparationListener,
    name?: string | null
  ): Promise<PageConnection>;
  connect(endpoint: string, headers?: Record<string, string>): Promise<Browser>;
}

interface ProfileConnection {
  generation: string;
  starting: Promise<BrowserContext>;
  context?: BrowserContext;
  abort: AbortController;
  pending: Set<object>;
  pages: Set<ScopedPageConnection>;
  closing?: Promise<void>;
  failed: boolean;
}

/** Exactly one owned Chrome per folder. Page release never closes a sibling's Page. */
export class BrowserProfileConnections {
  private readonly profiles = new Map<string, ProfileConnection>();

  constructor(private readonly backend: LocalBrowserBackend) {}

  /** Acquisition for one chat; profile choice and grants remain in the service. */
  forChat(
    blocked: (folder: string) => boolean = () => false,
    restorePersonFocus: (page: Page) => void = () => undefined
  ): PageSessionBackend {
    return {
      connect: (endpoint, headers) => this.backend.connect(endpoint, headers),
      launch: (folder, signal, preparation, name) =>
        this.acquire(
          folder,
          signal,
          preparation,
          name,
          () => {
            if (blocked(folder)) throw profileBusy();
          },
          restorePersonFocus
        ),
    };
  }

  /** Plain sign-in can replace the physical context only with a sole live page lease. */
  assertExclusive(connection: PageConnection | undefined): void {
    const entry = [...this.profiles.values()].find(
      (profile) => profile.generation === connection?.generation
    );
    if (!entry || entry.closing || entry.pending.size || entry.pages.size !== 1)
      throw profileBusy();
    const owned = new Set([...entry.pages].flatMap((scope) => scope.pages()));
    if (entry.context?.pages().some((page) => !page.isClosed() && !owned.has(page)))
      throw profileBusy();
  }

  /** A person-only profile operation may not replace another page connection. */
  assertAvailable(folder: string, connection: PageConnection | undefined): void {
    const entry = this.profiles.get(folder);
    if (!entry) return;
    if (entry.generation !== connection?.generation) throw profileBusy();
    this.assertExclusive(connection);
  }

  /** True until physical teardown settles; a failed close is still a reservation. */
  holds(folder: string): boolean {
    return this.profiles.has(folder);
  }

  /** Shutdown owns these contexts, including person/unowned pages; failed closes keep reservations. */
  async closeAll(): Promise<void> {
    const entries = [...this.profiles];
    for (const [, profile] of entries) profile.abort.abort();
    const results = await Promise.allSettled(
      entries.map(([folder, profile]) =>
        responseDeadline(this.close(folder, profile), CLOSE_RESPONSE_TIMEOUT_MS, () =>
          closingError(profile.failed)
        )
      )
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private async acquire(
    folder: string,
    signal: AbortSignal | undefined,
    preparation: BrowserPreparationListener | undefined,
    name: string | null | undefined,
    admit: () => void,
    restorePersonFocus: (page: Page) => void
  ): Promise<PageConnection> {
    signal?.throwIfAborted();
    admit();
    let profile = this.profiles.get(folder);
    if (profile?.closing) throw profileBusy();
    if (!profile) {
      const abort = new AbortController();
      profile = {
        generation: randomUUID(),
        abort,
        pending: new Set(),
        pages: new Set(),
        failed: false,
        starting: Promise.resolve().then(() =>
          this.backend.launch(folder, abort.signal, preparation, name, () => {
            abort.signal.throwIfAborted();
            admit();
            if (current.closing || this.profiles.get(folder) !== current) throw profileBusy();
          })
        ),
      };
      this.profiles.set(folder, profile);
      const current = profile;
      void current.starting
        .then((context) => {
          current.context = context;
          context.on('page', () => {
            if (current.closing || this.profiles.get(folder) !== current) return;
            for (const scope of current.pages) scope.pageOpened();
          });
          context.on('close', () => {
            for (const scope of current.pages) scope.connectionClosed();
            // A protocol close is not proof of cookie flush. A requested close keeps its tombstone.
            if (!current.closing && this.profiles.get(folder) === current)
              this.profiles.delete(folder);
          });
        })
        .catch(() => {
          if (this.profiles.get(folder) === current) this.profiles.delete(folder);
        });
    }
    const current = profile;
    const request = {};
    current.pending.add(request);
    const abort = () => {
      current.pending.delete(request);
      if (!current.pending.size && !current.pages.size) current.abort.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    let page: Page | undefined;
    try {
      const context = await current.starting;
      signal?.throwIfAborted();
      admit();
      if (current.closing || current.abort.signal.aborted) throw profileBusy();
      // Restored or person-created tabs stay unowned. Never pick context.pages()[0].
      page = await context.newPage();
      signal?.throwIfAborted();
      admit();
      if (current.closing || this.profiles.get(folder) !== current) throw profileBusy();
      const scope: ScopedPageConnection = new ScopedPageConnection(
        page,
        current.generation,
        () => this.release(folder, current, scope),
        restorePersonFocus
      );
      current.pages.add(scope);
      return scope;
    } catch (error) {
      await page?.close().catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      current.pending.delete(request);
      if (!current.pending.size && !current.pages.size && !current.closing) {
        await this.close(folder, current);
      }
    }
  }

  private async release(
    folder: string,
    profile: ProfileConnection,
    scope: ScopedPageConnection
  ): Promise<void> {
    profile.pages.delete(scope);
    // Unowned popups never become grants. The last lease releases the whole
    // owned context, including those pages, rather than stranding its profile.
    if (!profile.pages.size && !profile.pending.size) await this.close(folder, profile);
  }

  private async close(folder: string, profile: ProfileConnection): Promise<void> {
    profile.closing ??= profile.starting.then((context) => context.close());
    try {
      await profile.closing;
      if (this.profiles.get(folder) === profile) this.profiles.delete(folder);
    } catch (error) {
      profile.failed = true;
      throw error;
    }
  }
}

/** A connection exposes only the registered Page; foreign and person popup pages are excluded. */
class ScopedPageConnection implements PageConnection {
  private readonly events = new EventEmitter();
  private closing?: Promise<void>;

  constructor(
    private readonly page: Page,
    readonly generation: string,
    private readonly release: () => Promise<void>,
    private readonly restorePersonFocus: (page: Page) => void
  ) {
    page.on('close', () => this.connectionClosed());
  }

  pageOpened(): void {
    this.restorePersonFocus(this.page);
  }
  pages(): Page[] {
    return this.page.isClosed() ? [] : [this.page];
  }
  async newPage(): Promise<Page> {
    if (this.page.isClosed())
      throw new LocalBrowserError('tab_gone', 'This chat’s browser tab closed. Open it again.');
    return this.page;
  }
  on(event: 'close', listener: () => void): void {
    this.events.on(event, listener);
  }
  connectionClosed(): void {
    this.events.emit('close');
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      await this.page.close();
      await this.release();
    });
    return this.closing;
  }
}

/** Agent-safe: no other chat's identity, count or page information. */
function profileBusy(): LocalBrowserError {
  return new LocalBrowserError(
    'profile_busy',
    'This browser is busy. Ask the person to finish using it.'
  );
}
