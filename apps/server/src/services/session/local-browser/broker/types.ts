/** Identity supplied by the host, never accepted from page text or tool arguments. */
export interface TabPrincipal {
  readonly ownerId: string;
  readonly agentId: string;
}

/** Opaque handle: the broker also checks object identity before admitting an operation. */
export interface TabLease extends TabPrincipal {
  readonly pageId: string;
}

/** Persisted ownership only; addresses, page text and authentication data never enter this store. */
export interface TabOwnershipRecord {
  readonly pageId: string;
  readonly ownerId: string | null;
  readonly agentId: string | null;
  readonly held: boolean;
  readonly lastActiveAt: number;
}

/** Host-owned durable storage, keyed by a host-stamped page id on reconnect. */
export interface TabOwnershipStore {
  get(pageId: string): TabOwnershipRecord | undefined;
  save(record: TabOwnershipRecord): void;
  delete(pageId: string): void;
}

/** Minimal lifecycle audit; the origin field can never contain a path, query or user info. */
export interface TabAuditEvent {
  readonly kind:
    | 'open'
    | 'bind'
    | 'adopt'
    | 'release'
    | 'close'
    | 'hold'
    | 'hand_back'
    | 'origin'
    | 'popup_open'
    | 'popup_close';
  readonly at: number;
  readonly pageId: string;
  readonly ownerId: string | null;
  readonly agentId: string | null;
  /** Person-held events retain chat context but never name an agent as their actor. */
  readonly held: boolean;
  readonly origin?: string;
}

/** Only the host's person-facing controls receive this handle. Agents never do. */
export interface TabTakeover {
  readonly pageId: string;
  handBack(): void;
  abandon(): void;
}
