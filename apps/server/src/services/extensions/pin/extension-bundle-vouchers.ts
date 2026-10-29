/**
 * Which compiled bundles in the cache this process can vouch for (DOR-3068).
 *
 * The bundle cache (`{dorkHome}/cache/extensions/`) is a folder on disk, and a
 * file name there is only a name: a bundle swapped in after it was built would
 * otherwise be served to the app, `import()`ed by `test_extension`, or started
 * as a server half, on the strength of a check made against the files it was
 * built from. So the compiler records the full SHA-256 of every bundle it
 * writes, in memory where no file tool or shell can reach, and every read of a
 * cached bundle compares the bytes it is about to hand out with that record.
 * A bundle this process never wrote, or one whose bytes changed, reads as a
 * cache miss: the compiler builds it again from the (pinned) sources, and a
 * serve finds nothing to serve.
 *
 * The cost is one build per extension per server start, the first time each
 * is compiled; after that the cache works as before.
 *
 * @module services/extensions/pin/extension-bundle-vouchers
 */
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../lib/logger.js';

/** The full SHA-256 of a bundle's text, as hex. */
function sha256Of(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** The in-memory record of the cached bundles this process wrote. */
export class BundleVouchers {
  private readonly digests = new Map<string, string>();

  /**
   * Record a bundle this process just wrote to `file`.
   *
   * @param file - The cached bundle's path.
   * @param code - Exactly the text written there.
   */
  vouch(file: string, code: string): void {
    this.digests.set(path.resolve(file), sha256Of(code));
  }

  /**
   * Read a cached bundle, but only when its bytes are the ones this process
   * wrote there.
   *
   * @param file - The cached bundle's path.
   * @returns Its text, or null when this process never wrote it, it is gone,
   *   or its bytes changed since.
   */
  async read(file: string): Promise<string | null> {
    const expected = this.digests.get(path.resolve(file));
    if (!expected) return null;
    let code: string;
    try {
      code = await fs.readFile(file, 'utf-8');
    } catch {
      return null;
    }
    if (sha256Of(code) === expected) return code;
    this.digests.delete(path.resolve(file));
    logger.warn(`[Extensions] ${file} changed after DorkOS built it; not using it`);
    return null;
  }
}
