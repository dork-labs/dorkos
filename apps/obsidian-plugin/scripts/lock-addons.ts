/**
 * Regenerate `native-addons.lock.json` — the SHA-256 pins for every prebuilt
 * SQLite add-on the plugin build may download (DOR-1563).
 *
 * `pnpm --filter @dorkos/obsidian-plugin addons:lock`
 *
 * **This is a lockfile, and it is generated for the same reason any lockfile
 * is.** The build writes native code into a directory the plugin then
 * `require()`s, so what answers that URL runs with the operator's own
 * permissions. Pinning turns "whatever GitHub served" into "the bytes somebody
 * reviewed", and a mismatch fails the build rather than warning.
 *
 * Run it when {@link SQLITE_ADDON_ABIS} or {@link SQLITE_ADDON_TARGETS} changes,
 * or when `better-sqlite3` is upgraded — the build refuses to fetch anything if
 * the lockfile's version and the bundled version disagree, so it will tell you.
 *
 * Every target is hashed, not just this machine's: a person building on Windows
 * must get the same guarantee as the one who ran this on a Mac, and they cannot
 * regenerate a pin for a platform they are not on without weakening it into
 * "whatever I just downloaded".
 *
 * @module obsidian-plugin/scripts/lock-addons
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ADDON_LOCK_FILE,
  SQLITE_ADDON_ABIS,
  SQLITE_ADDON_TARGETS,
  downloadTarball,
  lockKey,
  prebuildUrl,
  sha256,
  type AddonLock,
} from '../build-plugins/sqlite-addon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** How many downloads to have in flight at once. */
const CONCURRENCY = 8;

/** The `better-sqlite3` whose builds are being pinned. */
function bundledVersion(): string {
  return (
    JSON.parse(
      fs.readFileSync(
        path.resolve(ROOT, '../../packages/db/node_modules/better-sqlite3/package.json'),
        'utf-8'
      )
    ) as { version: string }
  ).version;
}

async function main(): Promise<void> {
  const version = bundledVersion();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-addon-lock-'));
  const wanted = SQLITE_ADDON_TARGETS.flatMap((target) =>
    SQLITE_ADDON_ABIS.map((abi) => ({ ...target, abi }))
  );

  console.log(`Pinning ${wanted.length} better-sqlite3 ${version} prebuilds…`);
  const entries: Record<string, string> = {};
  const missing: string[] = [];

  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let i = next++; i < wanted.length; i = next++) {
        const target = wanted[i]!;
        const key = lockKey(target);
        const into = path.join(scratch, `${key}.tar.gz`);
        try {
          downloadTarball(prebuildUrl({ ...target, version }), into);
          entries[key] = sha256(into);
        } catch {
          // A target better-sqlite3 does not publish for this version. Recorded
          // as absent rather than guessed at: the build refuses to fetch a key
          // with no pin, which is the safe way to be wrong about this list.
          missing.push(key);
        }
        fs.rmSync(into, { force: true });
      }
    })
  );

  fs.rmSync(scratch, { recursive: true, force: true });

  const lock: AddonLock = {
    version,
    entries: Object.fromEntries(
      Object.keys(entries)
        .sort()
        .map((k) => [k, entries[k]!])
    ),
  };
  fs.writeFileSync(path.join(ROOT, ADDON_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);

  console.log(`✓ ${Object.keys(lock.entries).length} pinned in ${ADDON_LOCK_FILE}`);
  if (missing.length > 0) {
    console.log(`  not published for this version (${missing.length}): ${missing.join(', ')}`);
  }
}

await main();
