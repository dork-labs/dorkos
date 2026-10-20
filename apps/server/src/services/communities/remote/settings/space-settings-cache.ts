/**
 * The last value each space's settings reads returned, per owner and connection, with when it
 * came (DOR-3005). When a space cannot be reached, its Settings tab shows these and says how old
 * they are, instead of nothing.
 *
 * Kept on disk beside the connections, one small file per owner and connection, so a restart
 * while the space is down still has something to show. Nothing secret is kept: the space's name,
 * description, rules and who is in it, exactly as its Settings tab already shows them. The
 * connection's credential is never written here.
 *
 * @module services/communities/remote/settings/space-settings-cache
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CommunitySpaceRead } from '@dorkos/shared/community-space-settings';

/** One kept value and when the space sent it. */
export interface CachedSpaceRead {
  /** The value as the space sent it, already checked against its wire schema. */
  value: unknown;
  /** When the space sent it, as an ISO time. */
  fetchedAt: string;
}

const FileSchema = z.record(
  z.string(),
  z.strictObject({ value: z.unknown(), fetchedAt: z.iso.datetime() })
);

/** Last-known values of each connection's settings reads, in memory and on disk. */
export class SpaceSettingsCache {
  private readonly directory: string;
  private readonly memory = new Map<string, Partial<Record<CommunitySpaceRead, CachedSpaceRead>>>();

  /**
   * Keep the answers under the DorkOS data directory.
   *
   * @param dorkHome - The resolved local DorkOS data directory.
   */
  constructor(dorkHome: string) {
    this.directory = path.join(dorkHome, 'communities', 'remote', 'space-settings');
  }

  /** The kept value of one read, or `undefined` when the space never answered it. */
  async get(
    owner: string,
    ref: string,
    read: CommunitySpaceRead
  ): Promise<CachedSpaceRead | undefined> {
    return (await this.load(owner, ref))[read];
  }

  /** Keep a value the space just sent. A failed write keeps it in memory only. */
  async set(
    owner: string,
    ref: string,
    read: CommunitySpaceRead,
    entry: CachedSpaceRead
  ): Promise<void> {
    const entries = { ...(await this.load(owner, ref)), [read]: entry };
    this.memory.set(this.key(owner, ref), entries);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(owner, ref);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Drop everything kept for a connection, as when it is disconnected. */
  async forget(owner: string, ref: string): Promise<void> {
    this.memory.delete(this.key(owner, ref));
    await rm(this.file(owner, ref), { force: true });
  }

  private async load(
    owner: string,
    ref: string
  ): Promise<Partial<Record<CommunitySpaceRead, CachedSpaceRead>>> {
    const key = this.key(owner, ref);
    const held = this.memory.get(key);
    if (held) return held;
    let entries: Partial<Record<CommunitySpaceRead, CachedSpaceRead>> = {};
    try {
      entries = FileSchema.parse(JSON.parse(await readFile(this.file(owner, ref), 'utf8')));
    } catch {
      // Missing or unreadable: nothing kept yet, which reads as never answered.
    }
    this.memory.set(key, entries);
    return entries;
  }

  private key(owner: string, ref: string): string {
    return `${owner}\0${ref}`;
  }

  /** One file per owner and connection, named by a hash so no id becomes a path. */
  private file(owner: string, ref: string): string {
    const name = createHash('sha256').update(this.key(owner, ref)).digest('hex');
    return path.join(this.directory, `${name}.json`);
  }
}
