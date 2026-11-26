/**
 * Marketplace routes: `/packages/:name`: read one package. Browsing every enabled marketplace is a capability (`services/marketplace/doors/`).
 *
 * @module routes/marketplace/packages
 */
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { disclosedEffectsOf } from '../../services/marketplace/preview/disclosed-effects.js';
import { packageContentHash } from '../../services/marketplace/lib/content-hash.js';
import type { MarketplaceRouteDeps, MarketplaceRoutes } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { readQuery } from '../../http/request-query.js';
import { errorResponse, validationFailed } from './shared.js';
import { safeReaddir } from '../../services/marketplace/lib/safe-readdir.js';

/** Query schema for `GET /api/marketplace/packages/:name`. */
const GetPackageQuerySchema = z.object({
  marketplace: z.string().optional(),
});

/**
 * Hard cap on the README payload the detail endpoint returns (200 KB). READMEs
 * are a preview surface, not a source of truth — at most this many bytes are
 * ever read from disk, so a pathological file cannot balloon server memory.
 */
const MAX_README_BYTES = 200 * 1024;

/**
 * Read a package's root `README.md` from its staged directory for the detail
 * endpoint. The match is case-insensitive (`README.md`, `readme.md`, …) and
 * restricted to the package root — nested READMEs are ignored. The package is
 * already cloned locally by the installer's preview step, so this is a pure
 * filesystem read with no network access.
 *
 * Staged packages are third-party content from ANY user-added marketplace, so
 * the read is hardened:
 *
 * - **Symlinked READMEs are treated as absent.** Clones preserve symlinks, so
 *   a malicious package could otherwise commit `README.md` as a link to a
 *   sensitive file (e.g. `~/.dork/config.json`) and exfiltrate its contents at
 *   detail-view time — before any install consent. `lstat` never follows links.
 * - **The read itself is bounded.** At most {@link MAX_README_BYTES} are read
 *   through a `FileHandle` into a preallocated buffer — an attacker-sized
 *   README never loads fully into memory.
 * - **Truncation is UTF-8 safe.** A byte-offset cut can split a multibyte
 *   character; any trailing partial sequence is dropped so the payload never
 *   ends in a U+FFFD replacement glyph.
 *
 * Returns `undefined` when no README exists, the entry is not a regular file,
 * or the content is empty/whitespace, so the caller can omit the field
 * entirely. Read errors are swallowed — the detail endpoint never fails over
 * a preview.
 *
 * @param packagePath - Absolute path to the staged package directory.
 */
async function readPackageReadme(packagePath: string): Promise<string | undefined> {
  const entries = await safeReaddir(packagePath);
  const match = entries.find((entry) => entry.toLowerCase() === 'readme.md');
  if (!match) return undefined;
  const readmePath = join(packagePath, match);
  try {
    // lstat never follows links — anything but a regular file is rejected.
    const meta = await lstat(readmePath);
    if (!meta.isFile()) return undefined;

    const handle = await open(readmePath, 'r');
    try {
      // Size from the open handle (not the earlier lstat) so the bound and the
      // read refer to the same inode.
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_README_BYTES);
      if (length === 0) return undefined;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      // Only a cap-truncated read can split a character mid-sequence; a file
      // read in full keeps whatever bytes it genuinely contains.
      const end = size > bytesRead ? trimPartialUtf8Tail(buffer, bytesRead) : bytesRead;
      const text = buffer.subarray(0, end).toString('utf8');
      return text.trim().length === 0 ? undefined : text;
    } finally {
      await handle.close();
    }
  } catch {
    // A README that vanished or is unreadable between the readdir and the read
    // is treated as absent — the detail endpoint never fails over a preview.
    return undefined;
  }
}

/**
 * Drop a trailing partial UTF-8 sequence from `buffer[0, length)`.
 *
 * A byte-offset truncation can land mid-character; decoding that tail would
 * emit a U+FFFD replacement glyph. Walks back over at most three continuation
 * bytes to the final lead byte and drops the sequence when its continuation
 * bytes were cut off. Bytes that were already invalid UTF-8 are left as-is —
 * this only repairs damage done by the cap.
 *
 * @param buffer - The bytes that were read.
 * @param length - Number of valid bytes in `buffer`.
 * @returns The largest end offset that does not end in a split sequence.
 */
function trimPartialUtf8Tail(buffer: Buffer, length: number): number {
  let i = length - 1;
  const floor = Math.max(0, length - 4);
  // Walk back over continuation bytes (0b10xxxxxx) to the sequence's lead byte.
  while (i >= floor && (buffer[i] & 0xc0) === 0x80) i--;
  // Four continuation bytes in a row, or an ASCII/continuation byte where a
  // lead should be: the content was never valid UTF-8 there — leave it alone.
  if (i < floor || buffer[i] < 0x80) return length;
  const lead = buffer[i];
  let expected: number;
  if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return length; // Stray continuation/invalid lead — the file's own bytes.
  return length - i >= expected ? length : i;
}

/**
 * Register the `/packages` and `/packages/:name` routes on the marketplace router.
 *
 * @param app - The marketplace routes.
 * @param deps - The router's injected dependencies.
 * @param _ctx - The helpers every route group shares.
 */
export function mountPackageRoutes(
  app: MarketplaceRoutes,
  deps: MarketplaceRouteDeps,
  _ctx: MarketplaceRouteContext
): void {
  const { installer } = deps;

  // GET /packages/:name -- fetch and validate a single package entry
  app.get('/packages/:name', async (c) => {
    const name = c.req.param('name');
    const parsedQuery = GetPackageQuerySchema.safeParse(readQuery(c));
    if (!parsedQuery.success) return validationFailed(c, parsedQuery.error);

    try {
      const { preview, manifest, packagePath } = await installer.preview({
        name,
        marketplace: parsedQuery.data.marketplace,
      });
      // The installer already staged the package locally, so read its README
      // straight off disk — no extra network fetch. Omitted when absent so the
      // response shape stays clean (the client shows nothing rather than an
      // empty placeholder).
      const readme = await readPackageReadme(packagePath);
      return c.json({
        manifest,
        packagePath,
        preview,
        disclosed: disclosedEffectsOf(preview),
        // What a global install's approval binds: sent back as
        // `approvedContentHash`, and compared with the hash the installer
        // records when the package lands (DOR-2306).
        contentHash: await packageContentHash(packagePath),
        ...(readme !== undefined && { readme }),
      });
    } catch (err) {
      logger.error(`[Marketplace] Failed to fetch package ${name}`, err);
      return errorResponse(c, err);
    }
  });
}
