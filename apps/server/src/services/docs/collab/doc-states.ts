/**
 * The saved Yjs state of each live doc (DOR-2984 review), so a doc reopened
 * after it was dropped, or after the server stopped, is the same copy.
 *
 * An open doc records two states with the file's hash and the doc's
 * generation: the state the file holds (`.yfile`, on every save) and the whole
 * doc, unsaved edits included (`.ystate`, shortly after every change and at
 * close). A doc opened later whose file still has that hash loads both and
 * keeps the generation, so editors that were offline, or connected to a server
 * that stopped before it could save, merge their edits through Yjs instead of
 * having to start over, and the server's own unsaved edits are written on
 * reopen. The caller checks a loaded state against the file before trusting
 * it. A file changed while nobody had it open no longer matches, and the doc
 * starts a new generation from the file.
 *
 * Kept under the DorkOS data folder: `{dorkHome}/docs/live/{docKey}.ystate`,
 * `.yfile` and `.json` beside them, within {@link DEFAULT_LIVE_STATE_BYTES}
 * in total (the states of docs touched longest ago go first).
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

/** How many bytes of saved states every doc together keeps. */
export const DEFAULT_LIVE_STATE_BYTES = 256 * 1024 * 1024;

/** One doc's saved state. */
export interface SavedDocState {
  generation: string;
  /** The file's hash that `fileState` holds. */
  hash: string;
  /** The whole doc, unsaved edits included. */
  state: Uint8Array;
  /** The doc as the file at `hash` holds it. */
  fileState: Uint8Array;
}

/** A doc key is 32 hex characters: nothing else may name a file here. */
const DOC_KEY = /^[0-9a-f]{32}$/;

/** Saved live-doc states; see the module doc. */
export class DocStateStore {
  readonly #root: string;
  readonly #totalBytes: number;

  /**
   * A store rooted at `root`.
   *
   * @param root - The folder (`{dorkHome}/docs/live`).
   * @param totalBytes - How many bytes every doc's states together keep.
   */
  constructor(root: string, totalBytes = DEFAULT_LIVE_STATE_BYTES) {
    this.#root = root;
    this.#totalBytes = totalBytes;
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
      const fileState = new Uint8Array(await fs.readFile(this.#file(docKey, 'yfile')));
      return { generation: meta.generation, hash: meta.hash, state, fileState };
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
    // The states first: a meta that names a hash must never point at older states.
    await writeAtomic(this.#file(docKey, 'ystate'), saved.state);
    await writeAtomic(this.#file(docKey, 'yfile'), saved.fileState);
    await writeAtomic(
      this.#file(docKey, 'json'),
      JSON.stringify({
        generation: saved.generation,
        hash: saved.hash,
        file,
        savedAt: new Date().toISOString(),
      })
    );
    await this.#capTotal(docKey).catch((err) =>
      logger.warn('[docs] could not hold saved doc states to their cap', { err })
    );
  }

  /** Remove the states of the docs touched longest ago until every doc fits the cap. */
  async #capTotal(keep: string): Promise<void> {
    const names = await fs.readdir(this.#root).catch(() => [] as string[]);
    const docs: { docKey: string; savedAt: number; bytes: number }[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const docKey = name.slice(0, -'.json'.length);
      if (!DOC_KEY.test(docKey)) continue;
      let bytes = 0;
      for (const ext of ['json', 'ystate', 'yfile'] as const) {
        bytes += (await fs.stat(this.#file(docKey, ext)).catch(() => null))?.size ?? 0;
      }
      const meta = await fs
        .readFile(this.#file(docKey, 'json'), 'utf8')
        .then((raw) => SavedStateMetaSchema.parse(JSON.parse(raw)))
        .catch(() => null);
      docs.push({ docKey, savedAt: meta ? Date.parse(meta.savedAt) : 0, bytes });
    }
    let total = docs.reduce((sum, doc) => sum + doc.bytes, 0);
    docs.sort((a, b) => a.savedAt - b.savedAt);
    for (const doc of docs) {
      if (total <= this.#totalBytes) break;
      if (doc.docKey === keep) continue;
      await this.#remove(doc.docKey);
      total -= doc.bytes;
    }
  }

  async #remove(docKey: string): Promise<void> {
    for (const ext of ['json', 'ystate', 'yfile'] as const) {
      await fs.rm(this.#file(docKey, ext), { force: true }).catch((err) => {
        logger.warn('[docs] could not remove a saved doc state', { err });
      });
    }
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
      await this.#remove(docKey);
      removed += 1;
    }
    return removed;
  }

  #file(docKey: string, ext: 'json' | 'ystate' | 'yfile'): string {
    return path.join(this.#root, `${docKey}.${ext}`);
  }
}

/** Write a file whole or not at all: a temp file, then a rename. */
async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, content);
  await fs.rename(temp, file);
}
