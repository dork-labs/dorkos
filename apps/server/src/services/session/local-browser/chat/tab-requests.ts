import type { LocalBrowserOpen, LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import type { TabBroker } from '../broker/tab-broker.js';
import { CHAT_TAB_LIMIT_MESSAGE } from '../broker/tab-broker.js';
import { LocalBrowserError } from '../errors.js';

/** Server facts, never values supplied by an agent or a website. Unknown activity is busy. */
export type BrowserChatLookup = (sessionId: string) => Promise<{ title: string; active: boolean }>;
interface Ports {
  broker: TabBroker;
  canOpen(): boolean;
  open(input: LocalBrowserOpen): Promise<unknown>;
  busy(sessionId: string): boolean;
  waitingForPerson(sessionId: string): boolean;
  origin(pageId: string): string;
}

/** Person-authorized requests wait in insertion order; nothing is evicted to satisfy them. */
export class ChatTabRequests {
  private readonly pending = new Map<string, LocalBrowserOpen>();
  private draining?: Promise<void>;
  private lookup: BrowserChatLookup = async () => ({ title: 'Untitled chat', active: true });
  constructor(private readonly ports: Ports) {}
  useLookup(lookup: BrowserChatLookup): void {
    this.lookup = lookup;
  }
  waiting(id: string): boolean {
    return this.pending.has(id);
  }
  enqueue(input: LocalBrowserOpen): void {
    if (input.sessionId && !this.pending.has(input.sessionId))
      this.pending.set(input.sessionId, { ...input });
  }
  cancel(id?: string): void {
    if (id === undefined) this.pending.clear();
    else this.pending.delete(id);
  }
  assertAgent(id: string): void {
    if (this.waiting(id)) throw new LocalBrowserError('tab_limit', CHAT_TAB_LIMIT_MESSAGE);
  }
  /** A freed slot is assigned without selecting a tab or raising the browser. */
  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (const [id, input] of this.pending) {
        if (!this.ports.canOpen() || !this.ports.broker.hasCapacity()) break;
        try {
          await this.ports.open(input);
        } catch {
          break;
        } // A later state read retries; a failed allocation never consumes the request.
        if (this.pending.get(id) === input) this.pending.delete(id);
      }
    })();
    try {
      await this.draining;
    } finally {
      this.draining = undefined;
    }
  }
  async personState(
    id?: string
  ): Promise<Pick<LocalBrowserPersonState, 'waitingForTab' | 'openChatTabs' | 'idleTabToClose'>> {
    const records = this.ports.broker.chatRecords();
    const rows = await Promise.all(
      records
        .filter((row) => row.ownerId !== 'person')
        .map(async (row) => {
          let facts: Awaited<ReturnType<BrowserChatLookup>>;
          try {
            facts = await this.lookup(row.ownerId!);
          } catch {
            facts = { title: 'Untitled chat', active: true };
          }
          return {
            sessionId: row.ownerId!,
            title: facts.title,
            origin: this.ports.origin(row.pageId),
            state: row.held
              ? this.ports.waitingForPerson(row.ownerId!)
                ? ('Waiting' as const)
                : ('You' as const)
              : ('Agent' as const),
            idle: !row.held && !facts.active && !this.ports.busy(row.ownerId!),
            lastActiveAt: row.lastActiveAt,
          };
        })
    );
    const other = rows.filter((row) => row.sessionId !== id);
    const idle = other.filter((row) => row.idle).sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    return {
      waitingForTab: !!id && this.waiting(id),
      openChatTabs: other.map(({ lastActiveAt: _at, ...row }) => row),
      idleTabToClose: idle ? { sessionId: idle.sessionId, title: idle.title } : null,
    };
  }
  async requireIdle(target: string, requester: string): Promise<void> {
    const before = this.ports.broker.chatRecords().find((row) => row.ownerId === target);
    let active = true;
    try {
      active = (await this.lookup(target)).active;
    } catch {
      /* Unknown activity stays busy. */
    }
    const current = this.ports.broker.chatRecords().find((row) => row.ownerId === target);
    if (
      !this.waiting(requester) ||
      !before ||
      !current ||
      before.pageId !== current.pageId ||
      current.held ||
      active ||
      this.ports.busy(target)
    )
      throw new LocalBrowserError(
        'tab_busy',
        'That chat is using its tab. Choose another idle tab.'
      );
  }
}
