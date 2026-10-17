/**
 * Saved versions of docs, for "Restore previous version" (DOR-2984; the
 * DOR-2983 decision of 2026-10-17).
 *
 * Before DorkOS lets anyone but the person editing change a doc (an agent's
 * write, a change on disk merged into an open doc, a restore), it keeps the
 * doc's bytes here. That makes undoing an agent's whole-file write a file-level
 * action: it survives a reload, and it covers writes made while no editor was
 * open.
 *
 * Kept under the DorkOS data folder, never in the repo:
 * `{dorkHome}/docs/versions/{docKey}/{id}.md` with a `{id}.json` beside it, and
 * a `doc.json` naming the file. The doc key names the resolved file, so every
 * folder that reaches one file shares its versions. Bounded: the newest
 * {@link DEFAULT_KEPT_VERSIONS} per doc, and {@link DEFAULT_TOTAL_BYTES} across
 * every doc (oldest go first); {@link DocVersionStore.sweep} also removes the
 * versions of a doc whose file has been gone for a while.
 *
 * @module services/docs/collab/doc-versions
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { monotonicFactory } from 'ulidx';
import {
  DocVersionSchema,
  type DocVersion,
  type DocVersionReason,
  type DocWriter,
} from '@dorkos/shared/doc-collab';
import { logger } from '../../../lib/logger.js';

/** How many versions each doc keeps. */
export const DEFAULT_KEPT_VERSIONS = 10;

/** How many bytes of versions every doc together keeps. */
export const DEFAULT_TOTAL_BYTES = 200 * 1024 * 1024;

/** Ids sort in the order they were made, even within one millisecond. */
const nextId = monotonicFactory();

/** A version id is a ULID: nothing else may name a file here. */
const VERSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Where one doc's versions live. */
export interface DocVersionScope {
  /** The doc's key (`docKey`): one per resolved file. */
  docKey: string;
  /** The doc's file, recorded so a sweep can tell a doc that is gone. */
  file?: string;
}

/** A doc key is 32 hex characters: nothing else may name a folder here. */
const DOC_KEY = /^[0-9a-f]{32}$/;

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Saved versions of docs; see the module doc. */
export class DocVersionStore {
  readonly #root: string;
  readonly #kept: number;
  readonly #totalBytes: number;
  /** One write at a time per doc, so keeping and pruning never interleave. */
  readonly #tails = new Map<string, Promise<unknown>>();

  /**
   * A store rooted at `root`.
   *
   * @param root - The versions folder (`{dorkHome}/docs/versions`).
   * @param kept - How many versions each doc keeps.
   * @param totalBytes - How many bytes every doc's versions together keep.
   */
  constructor(root: string, kept = DEFAULT_KEPT_VERSIONS, totalBytes = DEFAULT_TOTAL_BYTES) {
    this.#root = root;
    this.#kept = kept;
    this.#totalBytes = totalBytes;
  }

  /**
   * Keep `content` as the doc's newest version, unless it already is.
   *
   * @param scope - Which doc.
   * @param content - The doc's bytes before the change (or the unsaved text).
   * @param changedBy - Whose change comes next (or who typed the unsaved text).
   * @param reason - Why it is kept.
   * @returns The version kept, or `null` when the newest one already held these bytes.
   */
  async keep(
    scope: DocVersionScope,
    content: string,
    changedBy: DocWriter,
    reason: DocVersionReason = 'before-change'
  ): Promise<DocVersion | null> {
    const kept = await this.#serial(scope, async () => {
      const dir = this.#dirOf(scope);
      const newest = (await this.#listIn(dir))[0];
      if (newest && (await this.#hashOfVersion(dir, newest.id)) === hashOf(content)) return null;
      await fs.mkdir(dir, { recursive: true });
      if (scope.file) {
        await writeAtomic(path.join(dir, 'doc.json'), JSON.stringify({ file: scope.file }));
      }
      const version: DocVersion = {
        id: nextId(),
        savedAt: new Date().toISOString(),
        reason,
        changedBy,
        bytes: Buffer.byteLength(content),
      };
      await writeAtomic(path.join(dir, `${version.id}.md`), content);
      await writeAtomic(path.join(dir, `${version.id}.json`), JSON.stringify(version));
      await this.#prune(dir);
      return version;
    });
    if (kept)
      await this.#capTotal().catch((err) => logger.warn('[docs] version cap failed', { err }));
    return kept;
  }

  /**
   * Remove the versions of docs whose file is gone and whose newest version is
   * older than `staleMs`, then hold every doc together to the byte cap.
   *
   * @param staleMs - How long the versions of a missing file are kept.
   * @returns How many docs' versions were removed.
   */
  async sweep(staleMs: number): Promise<number> {
    let removed = 0;
    for (const docKey of await this.#docKeys()) {
      const dir = path.join(this.#root, docKey);
      const file = await fs
        .readFile(path.join(dir, 'doc.json'), 'utf8')
        .then((raw) => (safeJson(raw) as { file?: unknown } | null)?.file)
        .catch(() => undefined);
      if (typeof file === 'string' && (await fs.stat(file).catch(() => null))) continue;
      const newest = (await this.#listIn(dir))[0];
      if (newest && Date.now() - Date.parse(newest.savedAt) < staleMs) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed += 1;
    }
    await this.#capTotal();
    return removed;
  }

  /**
   * A doc's saved versions, newest first.
   *
   * @param scope - Which doc.
   */
  async list(scope: DocVersionScope): Promise<DocVersion[]> {
    return this.#listIn(this.#dirOf(scope));
  }

  /**
   * One saved version's bytes.
   *
   * @param scope - Which doc.
   * @param id - The version.
   * @returns Its content, or `null` when there is no such version.
   */
  async read(scope: DocVersionScope, id: string): Promise<string | null> {
    if (!VERSION_ID.test(id)) return null;
    return fs.readFile(path.join(this.#dirOf(scope), `${id}.md`), 'utf8').catch(() => null);
  }

  #dirOf(scope: DocVersionScope): string {
    return path.join(this.#root, scope.docKey);
  }

  async #docKeys(): Promise<string[]> {
    const names = await fs.readdir(this.#root).catch(() => [] as string[]);
    return names.filter((name) => DOC_KEY.test(name));
  }

  /** Remove the oldest versions, across every doc, until the total fits the cap. */
  async #capTotal(): Promise<void> {
    const all: { dir: string; version: DocVersion }[] = [];
    for (const docKey of await this.#docKeys()) {
      const dir = path.join(this.#root, docKey);
      for (const version of await this.#listIn(dir)) all.push({ dir, version });
    }
    let total = all.reduce((sum, entry) => sum + entry.version.bytes, 0);
    if (total <= this.#totalBytes) return;
    all.sort((a, b) => a.version.id.localeCompare(b.version.id));
    for (const { dir, version } of all) {
      if (total <= this.#totalBytes) break;
      await this.#remove(dir, version.id);
      total -= version.bytes;
    }
  }

  async #remove(dir: string, id: string): Promise<void> {
    for (const ext of ['.md', '.json']) {
      await fs.rm(path.join(dir, `${id}${ext}`), { force: true }).catch((err) => {
        logger.warn('[docs] could not remove an old doc version', { err });
      });
    }
  }

  async #listIn(dir: string): Promise<DocVersion[]> {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const ids = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => VERSION_ID.test(id))
      .sort()
      .reverse();
    const versions: DocVersion[] = [];
    for (const id of ids) {
      const raw = await fs.readFile(path.join(dir, `${id}.json`), 'utf8').catch(() => null);
      const parsed = raw === null ? null : DocVersionSchema.safeParse(safeJson(raw));
      if (parsed?.success && parsed.data.id === id) versions.push(parsed.data);
    }
    return versions;
  }

  async #hashOfVersion(dir: string, id: string): Promise<string | null> {
    const content = await fs.readFile(path.join(dir, `${id}.md`), 'utf8').catch(() => null);
    return content === null ? null : hashOf(content);
  }

  async #prune(dir: string): Promise<void> {
    const stale = (await this.#listIn(dir)).slice(this.#kept);
    for (const version of stale) await this.#remove(dir, version.id);
  }

  async #serial<T>(scope: DocVersionScope, work: () => Promise<T>): Promise<T> {
    const key = scope.docKey;
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write a file whole or not at all: a temp file, then a rename. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}
