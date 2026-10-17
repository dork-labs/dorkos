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
 * `{dorkHome}/docs/versions/{docKey}/{id}.md` with a `{id}.json` beside it. The
 * doc key names the resolved file, so every folder that reaches one file shares
 * its versions. Bounded: the newest {@link DEFAULT_KEPT_VERSIONS} per doc.
 *
 * @module services/docs/collab/doc-versions
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { monotonicFactory } from 'ulidx';
import { DocVersionSchema, type DocVersion, type DocWriter } from '@dorkos/shared/doc-collab';
import { logger } from '../../../lib/logger.js';

/** How many versions each doc keeps. */
export const DEFAULT_KEPT_VERSIONS = 10;

/** Ids sort in the order they were made, even within one millisecond. */
const nextId = monotonicFactory();

/** A version id is a ULID: nothing else may name a file here. */
const VERSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Where one doc's versions live. */
export interface DocVersionScope {
  /** The doc's key (`docKey`): one per resolved file. */
  docKey: string;
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Saved versions of docs; see the module doc. */
export class DocVersionStore {
  readonly #root: string;
  readonly #kept: number;
  /** One write at a time per doc, so keeping and pruning never interleave. */
  readonly #tails = new Map<string, Promise<unknown>>();

  /**
   * A store rooted at `root`.
   *
   * @param root - The versions folder (`{dorkHome}/docs/versions`).
   * @param kept - How many versions each doc keeps.
   */
  constructor(root: string, kept = DEFAULT_KEPT_VERSIONS) {
    this.#root = root;
    this.#kept = kept;
  }

  /**
   * Keep `content` as the doc's newest version, unless it already is.
   *
   * @param scope - Which doc.
   * @param content - The doc's bytes before the change.
   * @param changedBy - Whose change comes next.
   * @returns The version kept, or `null` when the newest one already held these bytes.
   */
  async keep(
    scope: DocVersionScope,
    content: string,
    changedBy: DocWriter
  ): Promise<DocVersion | null> {
    return this.#serial(scope, async () => {
      const dir = this.#dirOf(scope);
      const newest = (await this.#listIn(dir))[0];
      if (newest && (await this.#hashOfVersion(dir, newest.id)) === hashOf(content)) return null;
      await fs.mkdir(dir, { recursive: true });
      const version: DocVersion = {
        id: nextId(),
        savedAt: new Date().toISOString(),
        changedBy,
        bytes: Buffer.byteLength(content),
      };
      await writeAtomic(path.join(dir, `${version.id}.md`), content);
      await writeAtomic(path.join(dir, `${version.id}.json`), JSON.stringify(version));
      await this.#prune(dir);
      return version;
    });
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
    for (const version of stale) {
      for (const ext of ['.md', '.json']) {
        await fs.rm(path.join(dir, `${version.id}${ext}`), { force: true }).catch((err) => {
          logger.warn('[docs] could not remove an old doc version', { err });
        });
      }
    }
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
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}
