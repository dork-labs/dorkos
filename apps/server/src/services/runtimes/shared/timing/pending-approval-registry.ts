import {
  armPendingApprovalExpiry,
  type PendingApprovalProfile,
} from './pending-approval-timing.js';

type ApprovalScope = string | symbol;

interface Registration<Entry> {
  entry: Entry;
  cancelExpiry: () => void;
}

/** Own one expiry timer per live request. Each adapter still decides how to answer it. */
export class PendingApprovalRegistry<Entry> {
  private readonly scopes = new Map<ApprovalScope, Map<string, Registration<Entry>>>();

  /**
   * Register a live request. A duplicate cannot replace its owner implicitly.
   * The returned function only removes this registration, even if the ID is reused.
   */
  insert(
    scope: ApprovalScope,
    id: string,
    entry: Entry,
    profile: PendingApprovalProfile,
    onExpiry: (entry: Entry) => void
  ): (() => boolean) | undefined {
    const records = this.scopes.get(scope) ?? new Map<string, Registration<Entry>>();
    if (records.has(id)) return undefined;

    const registration: Registration<Entry> = {
      entry,
      cancelExpiry: armPendingApprovalExpiry(profile, () => {
        if (this.remove(scope, id, registration)) onExpiry(entry);
      }),
    };
    records.set(id, registration);
    this.scopes.set(scope, records);
    return () => this.remove(scope, id, registration);
  }

  /** Look up a live record in the request's own scope. */
  peek(scope: ApprovalScope, id: string): Entry | undefined {
    return this.scopes.get(scope)?.get(id)?.entry;
  }

  /** Claim a record for manual resolution and disarm its timer. */
  take(scope: ApprovalScope, id: string): Entry | undefined {
    const registration = this.scopes.get(scope)?.get(id);
    if (!registration) return undefined;
    this.remove(scope, id, registration);
    return registration.entry;
  }

  /** Snapshot the records an adapter still needs to settle on cleanup. */
  values(scope: ApprovalScope): Entry[] {
    return Array.from(this.scopes.get(scope)?.values() ?? [], ({ entry }) => entry);
  }

  /** Disarm a scope's timers when its runtime has already stopped waiting. */
  clear(scope: ApprovalScope): void {
    const records = this.scopes.get(scope);
    if (!records) return;
    this.scopes.delete(scope);
    for (const record of records.values()) record.cancelExpiry();
  }

  private remove(scope: ApprovalScope, id: string, registration: Registration<Entry>): boolean {
    const records = this.scopes.get(scope);
    if (!records || records.get(id) !== registration) return false;
    records.delete(id);
    if (records.size === 0) this.scopes.delete(scope);
    registration.cancelExpiry();
    return true;
  }
}
