/**
 * Where a space connection's "answer in these channels" list is kept (spec
 * `official-community-space` D11): `answer-in.json`, beside `connections.json` and keyed by owner
 * and ref like the other side records.
 *
 * A file of its own, not a field on the connection record, for the reason the side records give:
 * an older DorkOS parses `connections.json` strictly and would fail on a field it does not know.
 * Owner-only by construction: the one route that writes it refuses every caller but this
 * install's owner, and no DorkOS tool or config key reaches this file.
 *
 * @module services/communities/remote/wake/answer-in-store
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../../lib/logger.js';
import type { RemoteConnectionStore } from '../connection-store.js';

const AnswerInFileSchema = z.record(z.string(), z.array(z.string().min(1)));

/** One connection's channels, for the in-memory answer the live stream reads. */
export interface ConnectionAnswerIn {
  /** The local connection ref. */
  ref: CommunityRef;
  /** The local owner the connection belongs to. */
  ownerKey: string;
  /** Channel names, already normalised by `CommunityAnswerInSchema`. */
  channels: readonly string[];
}

/** The `answer-in.json` side record, owner-scoped through the connection store. */
export class AnswerInStore {
  private readonly file: string;
  private readonly directory: string;
  private writing: Promise<void> = Promise.resolve();

  /**
   * Keep the list beside the connection store's own files, and forget a connection's entry
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
    this.file = path.join(this.directory, 'answer-in.json');
    connections.onChange((changes) => {
      const removed = changes.filter((change) => change.status === 'removed');
      if (!removed.length) return;
      void this.forget(removed.map((change) => key(change.ref, change.ownerKey))).catch(
        (error: unknown) => {
          logger.warn('[AnswerInStore] Could not forget a removed connection’s channels', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      );
    });
  }

  /**
   * The channels one connection answers in. Throws `RemoteConnectionNotFoundError` for a
   * connection that is gone or another owner's.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   */
  async get(ref: CommunityRef, ownerKey: string): Promise<string[]> {
    await this.connections.get(ref, ownerKey);
    return (await this.read())[key(ref, ownerKey)] ?? [];
  }

  /**
   * Replace one connection's channels; an empty list removes the entry. Throws
   * `RemoteConnectionNotFoundError` for a connection that is gone or another owner's.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   * @param channels - Channel names, already normalised by `CommunityAnswerInSchema`.
   */
  async set(ref: CommunityRef, ownerKey: string, channels: readonly string[]): Promise<void> {
    await this.exclusive(async () => {
      await this.connections.get(ref, ownerKey);
      const entries = await this.read();
      if (channels.length) entries[key(ref, ownerKey)] = [...channels];
      else delete entries[key(ref, ownerKey)];
      await this.write(entries);
    });
  }

  /**
   * Every existing connection that answers somewhere. An entry whose connection is gone is
   * left out, so a removal applies before its entry is forgotten. A damaged file throws.
   */
  async all(): Promise<ConnectionAnswerIn[]> {
    const [entries, connections] = await Promise.all([
      this.read(),
      this.connections.connectionsIfLoaded(),
    ]);
    return (connections ?? []).flatMap(({ communityRef, ownerAuthorId }) => {
      const channels = entries[key(communityRef, ownerAuthorId)];
      return channels?.length ? [{ ref: communityRef, ownerKey: ownerAuthorId, channels }] : [];
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

  /** Missing reads as "nowhere"; a damaged file throws, so a write never lands on a blank. */
  private async read(): Promise<Record<string, string[]>> {
    try {
      return AnswerInFileSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async write(entries: Record<string, string[]>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.answer-in-${randomUUID()}.tmp`);
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
