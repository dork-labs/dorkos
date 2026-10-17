/**
 * The saved Yjs state of each live doc (DOR-2984 review), so a doc reopened
 * after it was dropped, or after the server stopped, is the same copy.
 *
 * Every successful save of an open doc records the state the file now holds,
 * with the file's hash and the doc's generation. A doc opened later whose file
 * still has that hash loads this state and keeps that generation, so editors
 * that were offline, or connected to the server before it restarted, merge
 * their edits through Yjs instead of having to start over. A file changed
 * while nobody had it open no longer matches, and the doc starts a new
 * generation from the file.
 *
 * Kept under the DorkOS data folder: `{dorkHome}/docs/live/{docKey}.ystate`
 * and `{docKey}.json` beside it.
 *
 * @module services/docs/collab/doc-states
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../../../lib/logger.js';

/** What a saved state says about itself. */
const SavedStateMetaSchema = z.object({
  generation: z.string().min(1),
  /** The sha256 of the file the state was saved with. */
  hash: z.string().min(1),
  /** The file it belongs to, so a sweep can tell a doc that is gone. */
  file: z.string().min(1),
  savedAt: z.string(),
});

/** One doc's saved state. */
export interface SavedDocState {
  generation: string;
  hash: string;
  state: Uint8Array;
}

/** A doc key is 32 hex characters: nothing else may name a file here. */
const DOC_KEY = /^[0-9a-f]{32}$/;

/** Saved live-doc states; see the module doc. */
export class DocStateStore {
  readonly #root: string;

  /**
   * A store rooted at `root`.
   *
   * @param root - The folder (`{dorkHome}/docs/live`).
   */
  constructor(root: string) {
    this.#root = root;
  }

  /**
   * The saved state for a doc whose file has `hash` now, or `null`.
   *
   * @param docKey - The doc.
   * @param hash - The file's hash now.
   */
  async load(docKey: string, hash: string): Promise<SavedDocState | null> {
    if (!DOC_KEY.test(docKey)) return null;
    try {
      const meta = SavedStateMetaSchema.parse(
        JSON.parse(await fs.readFile(this.#file(docKey, 'json'), 'utf8'))
      );
      if (meta.hash !== hash) return null;
      const state = new Uint8Array(await fs.readFile(this.#file(docKey, 'ystate')));
      return { generation: meta.generation, hash: meta.hash, state };
    } catch {
      return null;
    }
  }

  /**
   * Record the state the doc's file now holds.
   *
   * @param docKey - The doc.
   * @param file - The doc's file.
   * @param saved - Its generation, the file's hash and the state.
   */
  async save(docKey: string, file: string, saved: SavedDocState): Promise<void> {
    if (!DOC_KEY.test(docKey)) return;
    await fs.mkdir(this.#root, { recursive: true });
    // The state first: a meta that names a hash must never point at an older state.
    await writeAtomic(this.#file(docKey, 'ystate'), saved.state);
    await writeAtomic(
      this.#file(docKey, 'json'),
      JSON.stringify({
        generation: saved.generation,
        hash: saved.hash,
        file,
        savedAt: new Date().toISOString(),
      })
    );
  }

  /**
   * Remove saved states whose file is gone and that are older than `staleMs`.
   *
   * @param staleMs - How long a state of a missing file is kept.
   * @returns How many were removed.
   */
  async sweep(staleMs: number): Promise<number> {
    const names = await fs.readdir(this.#root).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const docKey = name.slice(0, -'.json'.length);
      if (!DOC_KEY.test(docKey)) continue;
      const meta = await fs
        .readFile(this.#file(docKey, 'json'), 'utf8')
        .then((raw) => SavedStateMetaSchema.parse(JSON.parse(raw)))
        .catch(() => null);
      const stale = !meta || Date.now() - Date.parse(meta.savedAt) > staleMs;
      const gone = !meta || !(await fs.stat(meta.file).catch(() => null));
      if (!stale || !gone) continue;
      for (const ext of ['json', 'ystate'] as const) {
        await fs.rm(this.#file(docKey, ext), { force: true }).catch((err) => {
          logger.warn('[docs] could not remove a saved doc state', { err });
        });
      }
      removed += 1;
    }
    return removed;
  }

  #file(docKey: string, ext: 'json' | 'ystate'): string {
    return path.join(this.#root, `${docKey}.${ext}`);
  }
}

/** Write a file whole or not at all: a temp file, then a rename. */
async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, content);
  await fs.rename(temp, file);
}
