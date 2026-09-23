/**
 * Local non-secret community descriptors and encrypted token references.
 * Browser callers receive only {@link RemoteConnectionDescriptor}; the token
 * getter is private to the local server's remote HTTP adapter.
 *
 * @module services/communities/remote/connection-store
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  CommunityConnectionDescriptorSchema,
  type CommunityConnectionDescriptor,
} from '@dorkos/shared/community-connections';
import {
  CommunityConnectionAccessSchema,
  type CommunityConnectionAccess,
} from '@dorkos/shared/community-wire';
import {
  EncryptedFileCredentialStore,
  type CredentialStore,
} from '../../core/credential-provider.js';
import { logger } from '../../../lib/logger.js';

const RecordSchema = z.strictObject({
  ref: CommunityRefSchema,
  ownerKey: z.string().min(1),
  remoteCommunityId: z.string().min(1),
  label: z.string().min(1),
  pinnedOrigin: z.url(),
  connectedHumanMemberId: z.string().min(1).nullable(),
  status: z.enum(['pending', 'connected', 'reconnect-required']),
  pairingId: z.string().min(1).nullable(),
  expiresAt: z.iso.datetime().nullable(),
  agentIds: z.array(z.string().min(1)),
  access: CommunityConnectionAccessSchema.nullable().optional(),
});
type ConnectionRecord = z.infer<typeof RecordSchema>;

/** Non-secret status handed to the browser through the local route. */
export type RemoteConnectionDescriptor = CommunityConnectionDescriptor;

/** A local ref that is absent or belongs to another local owner. */
export class RemoteConnectionNotFoundError extends Error {
  constructor() {
    super('Community connection not found');
    this.name = 'RemoteConnectionNotFoundError';
  }
}

/** A stored personal grant that the remote community no longer accepts. */
export class RemoteConnectionAuthorizationError extends Error {
  constructor() {
    super('Community connection must be reconnected');
    this.name = 'RemoteConnectionAuthorizationError';
  }
}

/**
 * One committed change to an owner's connection list, told in-process only.
 *
 * `status` is where the row ended up; `removed` means the row is gone. Only
 * the list's shape counts — a row appearing, changing status or disappearing.
 * An access re-verification ({@link RemoteConnectionStore.updateAccess}) is
 * deliberately not a change: listing verifies every row, so announcing it
 * would make every list read ask every window to list again.
 */
export interface RemoteConnectionChange {
  /** The local owner whose list changed. */
  ownerKey: string;
  /** The connection that changed. */
  ref: CommunityRef;
  /** Where the connection is now. */
  status: ConnectionRecord['status'] | 'removed';
}

/** Subscriber to {@link RemoteConnectionStore.onChange}. */
export type RemoteConnectionChangeListener = (change: RemoteConnectionChange) => void;

const noEffectiveAccess = { read: false, post: false, enrollAgent: false, stream: false } as const;

function projectedAccess(record: ConnectionRecord): CommunityConnectionAccess | null {
  if (record.status === 'pending') return null;
  if (record.status === 'reconnect-required') {
    return CommunityConnectionAccessSchema.parse({
      state: 'reconnect-required',
      effective: noEffectiveAccess,
      lastKnown: record.access?.lastKnown ?? null,
    });
  }
  return (
    record.access ??
    CommunityConnectionAccessSchema.parse({
      state: 'unverified',
      effective: noEffectiveAccess,
      lastKnown: null,
    })
  );
}

/** Atomic, owner-scoped metadata plus the existing AES-GCM credential store. */
export class RemoteConnectionStore {
  private readonly file: string;
  private readonly directory: string;
  private readonly credentials: CredentialStore;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<RemoteConnectionChangeListener>();

  /**
   * Hear about every committed change to any owner's connection list: a row
   * added, connected, told to reconnect, or removed.
   *
   * Every path that changes a connection's state ends in this store — pairing,
   * cancel, expiry, disconnect, and a Community refusing the grant from any
   * route, stream or verification — so subscribing here covers them all by
   * construction. Listeners run after the write is on disk, so a reader that
   * lists in response sees the new state.
   *
   * @param listener - Called synchronously, once per change.
   * @returns An unsubscribe function.
   */
  onChange(listener: RemoteConnectionChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tell every listener; one that throws never fails the write it reports. */
  private announce(changes: readonly RemoteConnectionChange[]): void {
    for (const change of changes)
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (error) {
          logger.warn('[RemoteConnectionStore] A connection change listener failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writing.then(action, action);
    this.writing = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Create the metadata store beside the local encrypted credential store.
   *
   * @param dorkHome - The resolved local DorkOS data directory.
   * @param credentials - Protected store, injected in tests or built from dorkHome.
   */
  constructor(
    dorkHome: string,
    credentials: CredentialStore = new EncryptedFileCredentialStore(dorkHome)
  ) {
    this.directory = path.join(dorkHome, 'communities', 'remote');
    this.file = path.join(this.directory, 'connections.json');
    this.credentials = credentials;
  }

  private async read(): Promise<ConnectionRecord[]> {
    try {
      return z.array(RecordSchema).parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async write(records: ConnectionRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.connections-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** List only this locally authenticated owner's connections. */
  async list(ownerKey: string): Promise<RemoteConnectionDescriptor[]> {
    return (await this.read()).filter((record) => record.ownerKey === ownerKey).map(this.project);
  }

  /** Remove expired pending proof before list/status can display it after restart. */
  async sweepExpired(ownerKey: string, busy: ReadonlySet<CommunityRef> = new Set()): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.read();
      const expired = records.filter(
        (record) =>
          record.ownerKey === ownerKey &&
          record.status === 'pending' &&
          record.expiresAt !== null &&
          Date.parse(record.expiresAt) <= Date.now() &&
          !busy.has(record.ref)
      );
      if (!expired.length) return;
      for (const record of expired)
        await this.credentials.delete(`community:${record.ref}:pairing`);
      const refs = new Set(expired.map((record) => record.ref));
      await this.write(records.filter((record) => !refs.has(record.ref)));
      this.announce(
        expired.map((record) => ({ ownerKey, ref: record.ref, status: 'removed' as const }))
      );
    });
  }

  /** Read one matching record for server-side pairing; other owners appear absent. */
  async get(ref: CommunityRef, ownerKey: string): Promise<ConnectionRecord> {
    const record = (await this.read()).find(
      (item) => item.ref === ref && item.ownerKey === ownerKey
    );
    if (!record) throw new RemoteConnectionNotFoundError();
    return record;
  }

  /** Public projection, never containing an owner key, verifier, code or token. */
  project(record: ConnectionRecord): RemoteConnectionDescriptor {
    const {
      ref,
      remoteCommunityId,
      label,
      pinnedOrigin,
      connectedHumanMemberId,
      status,
      expiresAt,
    } = record;
    return CommunityConnectionDescriptorSchema.parse({
      ref,
      remoteCommunityId,
      label,
      pinnedOrigin,
      connectedHumanMemberId,
      status,
      expiresAt,
      access: projectedAccess(record),
      attention:
        status === 'pending'
          ? null
          : { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    });
  }

  /** Persist a pending pairing after its verifier was protected. */
  async addPending(
    input: Omit<ConnectionRecord, 'status' | 'connectedHumanMemberId' | 'agentIds'>,
    verifier: string
  ): Promise<RemoteConnectionDescriptor> {
    return this.exclusive(async () => {
      const record = RecordSchema.parse({
        ...input,
        status: 'pending',
        connectedHumanMemberId: null,
        agentIds: [],
      });
      const name = `community:${record.ref}:pairing`;
      await this.credentials.put(name, verifier);
      try {
        const records = await this.read();
        if (records.some((item) => item.ref === record.ref))
          throw new Error('Community ref collision');
        await this.write([...records, record]);
      } catch (error) {
        await this.credentials.delete(name);
        throw error;
      }
      this.announce([{ ownerKey: record.ownerKey, ref: record.ref, status: 'pending' }]);
      return this.project(record);
    });
  }

  /** Read a pending verifier only for its local owner. */
  async verifier(ref: CommunityRef, ownerKey: string): Promise<string> {
    const record = await this.get(ref, ownerKey);
    if (record.status !== 'pending') throw new RemoteConnectionNotFoundError();
    const value = await this.credentials.get(`community:${ref}:pairing`);
    if (!value) throw new RemoteConnectionNotFoundError();
    return value;
  }

  /** Store a one-time grant privately and replace the pending descriptor. */
  async complete(
    ref: CommunityRef,
    ownerKey: string,
    memberId: string,
    token: string,
    access: CommunityConnectionAccess
  ): Promise<RemoteConnectionDescriptor> {
    return this.exclusive(async () => {
      const record = await this.get(ref, ownerKey);
      if (record.status !== 'pending') throw new RemoteConnectionNotFoundError();
      const name = `community:${ref}:personal`;
      await this.credentials.put(name, token);
      let updated: ConnectionRecord;
      try {
        const records = await this.read();
        const index = records.findIndex(
          (item) => item.ref === ref && item.ownerKey === ownerKey && item.status === 'pending'
        );
        if (index < 0) throw new RemoteConnectionNotFoundError();
        updated = RecordSchema.parse({
          ...records[index],
          status: 'connected',
          connectedHumanMemberId: memberId,
          pairingId: null,
          expiresAt: null,
          access,
        });
        records[index] = updated;
        await this.write(records);
      } catch (error) {
        await this.credentials.delete(name);
        throw error;
      }
      await this.credentials.delete(`community:${ref}:pairing`);
      this.announce([{ ownerKey, ref, status: 'connected' }]);
      return this.project(updated);
    });
  }

  /** Persist the latest exact-grant verification or bounded outage snapshot. */
  async updateAccess(
    ref: CommunityRef,
    ownerKey: string,
    access: CommunityConnectionAccess
  ): Promise<RemoteConnectionDescriptor> {
    return this.exclusive(async () => {
      const records = await this.read();
      const index = records.findIndex(
        (item) => item.ref === ref && item.ownerKey === ownerKey && item.status === 'connected'
      );
      if (index < 0) throw new RemoteConnectionNotFoundError();
      records[index] = RecordSchema.parse({ ...records[index], access });
      await this.write(records);
      return this.project(records[index]!);
    });
  }

  /** Resolve a personal bearer inside the local server; never return it to a route DTO. */
  async personalToken(ref: CommunityRef, ownerKey: string): Promise<string> {
    const record = await this.get(ref, ownerKey);
    if (record.status === 'reconnect-required') throw new RemoteConnectionAuthorizationError();
    if (record.status !== 'connected') throw new RemoteConnectionNotFoundError();
    const token = await this.credentials.get(`community:${ref}:personal`);
    if (!token) throw new RemoteConnectionNotFoundError();
    return token;
  }

  /**
   * Read the personal bearer still stored for a connection in any state, or
   * null. Only disconnect uses it, to revoke a grant the Community may still
   * hold after local state stopped trusting it; every other caller goes
   * through {@link personalToken}, which fails closed.
   */
  async storedPersonalToken(ref: CommunityRef, ownerKey: string): Promise<string | null> {
    // Owner check first; a pending record never received a personal bearer.
    await this.get(ref, ownerKey);
    return this.credentials.get(`community:${ref}:personal`);
  }

  /** Persist a rejected personal grant so every later read fails closed with a useful status. */
  async requireReconnect(ref: CommunityRef, ownerKey: string): Promise<void> {
    return this.exclusive(async () => {
      const records = await this.read();
      const index = records.findIndex((item) => item.ref === ref && item.ownerKey === ownerKey);
      if (index < 0 || records[index]!.status === 'pending')
        throw new RemoteConnectionNotFoundError();
      const record = records[index]!;
      if (record.status !== 'reconnect-required') {
        records[index] = RecordSchema.parse({
          ...record,
          status: 'reconnect-required',
          access: {
            state: 'reconnect-required',
            effective: noEffectiveAccess,
            lastKnown: record.access?.lastKnown ?? null,
          },
        });
        await this.write(records);
        // Announced once, on the transition. The credentials below are still
        // being deleted, but every read already fails closed on the status
        // just written, so a window that re-lists now sees the truth.
        this.announce([{ ownerKey, ref, status: 'reconnect-required' }]);
      }
      await this.credentials.delete(`community:${ref}:personal`);
      for (const agentId of record.agentIds)
        await this.credentials.delete(`community:${ref}:agent:${agentId}`);
    });
  }

  /** Protect a newly enrolled agent's one-time bearer under this connection. */
  async saveAgentToken(
    ref: CommunityRef,
    ownerKey: string,
    agentId: string,
    token: string
  ): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.get(ref, ownerKey);
      if (record.status !== 'connected' || !z.uuid().safeParse(agentId).success || !token)
        throw new RemoteConnectionNotFoundError();
      const name = `community:${ref}:agent:${agentId}`;
      await this.credentials.put(name, token);
      try {
        const records = await this.read();
        const index = records.findIndex(
          (item) => item.ref === ref && item.ownerKey === ownerKey && item.status === 'connected'
        );
        if (index < 0) throw new RemoteConnectionNotFoundError();
        records[index] = RecordSchema.parse({
          ...records[index],
          agentIds: [...new Set([...record.agentIds, agentId])],
        });
        await this.write(records);
      } catch (error) {
        await this.credentials.delete(name);
        throw error;
      }
    });
  }

  /** Resolve only an agent previously enrolled through this owner's connection. */
  async agentToken(ref: CommunityRef, ownerKey: string, agentId: string): Promise<string> {
    const record = await this.get(ref, ownerKey);
    if (record.status !== 'connected' || !record.agentIds.includes(agentId))
      throw new RemoteConnectionNotFoundError();
    const token = await this.credentials.get(`community:${ref}:agent:${agentId}`);
    if (!token) throw new RemoteConnectionNotFoundError();
    return token;
  }

  /** Revoke a local agent credential without widening another agent's access. */
  async deleteAgentToken(ref: CommunityRef, ownerKey: string, agentId: string): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.get(ref, ownerKey);
      if (!record.agentIds.includes(agentId)) throw new RemoteConnectionNotFoundError();
      await this.credentials.delete(`community:${ref}:agent:${agentId}`);
      const records = await this.read();
      const index = records.findIndex((item) => item.ref === ref && item.ownerKey === ownerKey);
      if (index < 0) throw new RemoteConnectionNotFoundError();
      records[index] = RecordSchema.parse({
        ...records[index],
        agentIds: record.agentIds.filter((id) => id !== agentId),
      });
      await this.write(records);
    });
  }

  /** Delete local metadata, encrypted credentials and this ref's derived cache. */
  async disconnect(ref: CommunityRef, ownerKey: string): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.get(ref, ownerKey);
      for (const agentId of record.agentIds)
        await this.credentials.delete(`community:${ref}:agent:${agentId}`);
      await this.credentials.delete(`community:${ref}:pairing`);
      await this.credentials.delete(`community:${ref}:personal`);
      const records = (await this.read()).filter((item) => item.ref !== ref);
      await this.write(records);
      this.announce([{ ownerKey, ref, status: 'removed' }]);
      await rm(path.join(this.directory, 'cache', ref), { recursive: true, force: true });
    });
  }
}
