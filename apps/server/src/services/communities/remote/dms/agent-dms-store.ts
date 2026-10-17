/**
 * Which of this install's enrolled agents take direct messages in each space, as the owner last
 * set it here (DOR-2955): `agent-dms.json`, beside `connections.json` and keyed by owner and ref
 * like the other side records.
 *
 * The space holds the setting itself and decides by it; this copy is only what the owner's own
 * switch shows, since the space offers no read of it. A change made from another installation
 * shows here once it is made from this one. Owner-only by construction: the one route that
 * writes it refuses every caller but this install's owner.
 *
 * @module services/communities/remote/dms/agent-dms-store
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../../lib/logger.js';
import type { RemoteConnectionStore } from '../connection-store.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { getRemoteConnectionStore } from '../state.js';

const AgentDmsFileSchema = z.record(z.string(), z.array(z.string().min(1)));

/** The `agent-dms.json` side record, owner-scoped through the connection store. */
export class AgentDmsStore {
  private readonly file: string;
  private readonly directory: string;
  private writing: Promise<void> = Promise.resolve();

  /**
   * Keep the record beside the connection store's own files, and forget a connection's entry
   * when that connection is removed.
   *
   * @param dorkHome - The resolved local DorkOS data directory.
   * @param connections - The connection store that decides which connections exist and whose.
   */
  constructor(
    dorkHome: string,
    private readonly connections: RemoteConnectionStore
  ) {
    this.directory = path.join(dorkHome, 'communities', 'remote');
    this.file = path.join(this.directory, 'agent-dms.json');
    connections.onChange((changes) => {
      const removed = changes.filter((change) => change.status === 'removed');
      if (!removed.length) return;
      void this.forget(removed.map((change) => key(change.ref, change.ownerKey))).catch(
        (error: unknown) => {
          logger.warn('[AgentDmsStore] Could not forget a removed connection’s agents', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      );
    });
  }

  /**
   * The local agents that take direct messages on one connection. Throws
   * `RemoteConnectionNotFoundError` for a connection that is gone or another owner's.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   */
  async get(ref: CommunityRef, ownerKey: string): Promise<string[]> {
    await this.connections.get(ref, ownerKey);
    return (await this.read())[key(ref, ownerKey)] ?? [];
  }

  /**
   * Record whether one local agent takes direct messages on one connection. Throws
   * `RemoteConnectionNotFoundError` for a connection that is gone or another owner's.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   * @param localAgentId - The enrolled local agent.
   * @param accepts - Whether it takes them now.
   */
  async set(
    ref: CommunityRef,
    ownerKey: string,
    localAgentId: string,
    accepts: boolean
  ): Promise<void> {
    await this.exclusive(async () => {
      await this.connections.get(ref, ownerKey);
      const entries = await this.read();
      const agents = new Set(entries[key(ref, ownerKey)] ?? []);
      if (accepts) agents.add(localAgentId);
      else agents.delete(localAgentId);
      if (agents.size) entries[key(ref, ownerKey)] = [...agents].sort();
      else delete entries[key(ref, ownerKey)];
      await this.write(entries);
    });
  }

  private async forget(keys: readonly string[]): Promise<void> {
    await this.exclusive(async () => {
      const entries = await this.read();
      if (!keys.some((name) => name in entries)) return;
      for (const name of keys) delete entries[name];
      await this.write(entries);
    });
  }

  /** Missing reads as "none"; a damaged file throws, so a write never lands on a blank. */
  private async read(): Promise<Record<string, string[]>> {
    try {
      return AgentDmsFileSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async write(entries: Record<string, string[]>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.agent-dms-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
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
}

function key(ref: CommunityRef, ownerKey: string): string {
  return `${ownerKey}\0${ref}`;
}

let store: AgentDmsStore | undefined;

/** The production record, beside this install's other space side records. */
export function getAgentDmsStore(): AgentDmsStore {
  return (store ??= new AgentDmsStore(resolveDorkHome(), getRemoteConnectionStore()));
}
