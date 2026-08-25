/**
 * SQLite for Obsidian: put the native add-on beside the bundle, and make the
 * bundle load it from there (DOR-1563).
 *
 * ## Why the plugin needs one at all
 *
 * The embed reads the message index in-process, and the index is a SQLite
 * database — `~/.dork/dork.db`, the same file the DorkOS app writes. Reading it
 * properly means a real SQLite: WAL, FTS5, and a reader that sees a live
 * writer's uncheckpointed rows. A WebAssembly build has none of that, and the
 * file it would be pointed at is not a private copy — it holds every room
 * conversation on the machine, with another process possibly writing it right
 * now. So the add-on stays, and the packaging problem gets solved instead. See
 * ADR 260825-194924.
 *
 * ## Why it is not just copied out of node_modules
 *
 * `better-sqlite3` is a V8-ABI add-on, not an N-API one, so a build is tied to
 * one `NODE_MODULE_VERSION`. The copy in `node_modules` is built for the Node
 * that runs the tests; Obsidian is Electron, whose ABI is a different number.
 * `better-sqlite3` publishes Electron builds for every ABI as GitHub release
 * assets — the same ones `@electron/rebuild` fetches for the desktop app
 * (`apps/desktop/scripts/rebuild-natives.ts`) — so this fetches those and
 * caches them.
 *
 * **They are fetched rather than rebuilt on purpose.** A rebuild flips the copy
 * in the pnpm store, which the whole monorepo shares, and breaks vitest for
 * every other package until somebody rebuilds it back. The desktop packaging
 * script carries a warning banner about exactly that. Fetching touches nothing
 * outside this package.
 *
 * **And every fetch is checked against a committed hash.** `native-addons.lock.json`
 * pins the SHA-256 of each tarball, the way a lockfile pins a package. A build
 * downloads native code and puts it where the plugin will `require()` it; doing
 * that off an unverified URL means whatever answers that URL runs with the
 * operator's own permissions. Regenerate with
 * `pnpm --filter @dorkos/obsidian-plugin addons:lock`.
 *
 * @module obsidian-plugin/build-plugins/sqlite-addon
 */
import type { Plugin } from 'vite';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * The Electron ABIs a built plugin carries SQLite for.
 *
 * An ABI number is `process.versions.modules`, and Obsidian's is whatever
 * Electron its release was built on — a number DorkOS does not choose and cannot
 * ask for at build time. So the plugin carries a window of them and picks at
 * runtime, which is what makes an Obsidian update a non-event instead of a
 * broken search box.
 *
 * The window starts at Electron 33 (ABI 130). Below that is Obsidian releases
 * from before mid-2025, and the tail is every ABI `better-sqlite3` publishes
 * above it. Adding to the list plus a re-run of `addons:lock` is the whole
 * change when Electron moves on: the runtime loader reads the number off the
 * host and never has to be told.
 */
export const SQLITE_ADDON_ABIS: readonly number[] = [
  130, 132, 133, 135, 136, 139, 140, 143, 145, 146,
];

/** One machine shape a plugin can be built on and run on. */
export interface AddonTarget {
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
}

/**
 * Every platform the lockfile pins hashes for.
 *
 * Not every asset `better-sqlite3` publishes: `win32-ia32` is left out because
 * Obsidian has no 32-bit desktop build to load it. A build on a target absent
 * from this list finds no pinned hash and refuses to fetch rather than trusting
 * a download, which is the safe direction — it costs search inside Obsidian on
 * an exotic machine and cannot cost anything worse.
 */
export const SQLITE_ADDON_TARGETS: readonly AddonTarget[] = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'win32', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
];

/** Where fetched add-ons are cached between builds (gitignored). */
const ADDON_CACHE_DIR = '.native';

/** The committed hash pins, beside the build plugin that reads them. */
export const ADDON_LOCK_FILE = 'native-addons.lock.json';

/** What {@link ADDON_LOCK_FILE} holds. */
export interface AddonLock {
  /** The `better-sqlite3` version every pinned hash belongs to. */
  version: string;
  /** `<platform>-<arch>-abi<N>` → lowercase hex SHA-256 of the release tarball. */
  entries: Record<string, string>;
}

/**
 * The name one build carries in `dist/`, and the name the loader asks for.
 *
 * **Platform and architecture are in it, not just the ABI.** A `dist/` copied
 * from a Mac to a Windows box — or between two machines a person owns — would
 * otherwise offer a Mach-O binary to a host expecting a DLL, and the failure is
 * a raw loader error rather than the plugin's own sentence. Named for the
 * machine it is for, a wrong-machine build is simply not found, which is the
 * case that already degrades properly.
 *
 * @param target - Which build to name.
 * @returns The bare filename.
 */
export function addonFileName(target: AddonTarget & { abi: number }): string {
  return `better_sqlite3-${target.platform}-${target.arch}-abi${target.abi}.node`;
}

/**
 * The key one build has in {@link AddonLock.entries}.
 *
 * @param target - Which build to key.
 * @returns The lookup key.
 */
export function lockKey(target: AddonTarget & { abi: number }): string {
  return `${target.platform}-${target.arch}-abi${target.abi}`;
}

/**
 * The GitHub release asset holding one prebuilt add-on.
 *
 * @param opts - Which build to name.
 * @returns The download URL.
 */
export function prebuildUrl(opts: AddonTarget & { version: string; abi: number }): string {
  const asset = `better-sqlite3-v${opts.version}-electron-v${opts.abi}-${opts.platform}-${opts.arch}.tar.gz`;
  return `https://github.com/WiseLibs/better-sqlite3/releases/download/v${opts.version}/${asset}`;
}

/**
 * What the bundle runs where `require('bindings')('better_sqlite3.node')` used
 * to be.
 *
 * Exported so the install layouts can be tested for real rather than reasoned
 * about — `sqlite-addon-layouts.test.ts` writes this into a file in each layout
 * a person can actually install into and loads it.
 *
 * Three things about it are deliberate:
 *
 * - **`__filename`, not `bindings`.** The `bindings` package walks up from the
 *   calling file looking for `build/Release/…`, and no layout a vault has ever
 *   been in contains that. `__filename` inside this bundle is the real path of
 *   `main.js`, in every layout including a symlinked dev install, so the add-on
 *   beside it is one `path.dirname` away.
 * - **It fails with a sentence, not a stack.** A person whose Obsidian is newer
 *   than the ABI window, or who copied `dist/` from another kind of machine,
 *   loses search and nothing else — and the message names the platform,
 *   architecture and module version that were wanted.
 * - **It is injected after bundling.** Written as source it would be rewritten
 *   by the CommonJS transform into something that cannot dynamically require.
 */
export const SQLITE_ADDON_LOADER = `(function(){
var p=require("path"),f=require("fs");
var target=process.platform+"-"+process.arch+"-abi"+process.versions.modules;
var addon=p.join(p.dirname(__filename),"better_sqlite3-"+target+".node");
if(!f.existsSync(addon))throw new Error("DorkOS carries SQLite for Obsidian as a prebuilt add-on, and this copy has none for "+target+". Searching your message history is off until it does — everything else in the plugin still works. Building the plugin again on this machine, from a current DorkOS checkout, picks up the right one.");
return require(addon);
})()`;

/**
 * The tail of the add-on load site: `better-sqlite3`'s own argument to
 * `bindings()`, verbatim.
 *
 * Sites are found by THIS rather than by the caller's name. The caller is a
 * helper Rollup synthesizes (`requireBindings()`), and naming it is the same
 * mistake the `__dirname` rewrite made until DOR-1563 — Rollup renames things.
 * The literal comes from `better-sqlite3`'s source and does not move.
 */
const ADDON_ARGUMENT = '("better_sqlite3.node")';

/**
 * The callee in front of that argument, anchored to the end of a SHORT slice.
 *
 * The anchor is the point. `dist/main.js` is 70 MB, and an unanchored
 * `[\w$]+\(\)\("better_sqlite3\.node"\)` swept across it backtracks at every one
 * of seventy million positions — measured at over three minutes without
 * finishing, against thirty seconds for the whole build. The same trap the
 * `__dirname` rewrite fell into next door, so the same answer: find the literal,
 * then look only at what is immediately behind it.
 */
const ADDON_CALLEE_TAIL = /(?:^|[^\w$.])([\w$.]+\(\))$/;

/** How far back to look for the callee in front of the argument. */
const CALLEE_WINDOW = 64;

/**
 * Replace every `…(…)("better_sqlite3.node")` with the explicit loader.
 *
 * Exported so the shape can be asserted against a real minified fragment
 * (`sqlite-addon-layouts.test.ts`) instead of only through a two-minute build.
 *
 * @param code - The built bundle.
 * @returns The rewritten bundle and how many sites were replaced.
 */
export function rewriteAddonLoad(code: string): { code: string; sites: number } {
  const pieces: string[] = [];
  let cursor = 0;
  let sites = 0;

  for (;;) {
    const at = code.indexOf(ADDON_ARGUMENT, cursor);
    if (at === -1) break;
    const callee = ADDON_CALLEE_TAIL.exec(code.slice(Math.max(cursor, at - CALLEE_WINDOW), at));
    if (!callee) {
      pieces.push(code.slice(cursor, at + ADDON_ARGUMENT.length));
      cursor = at + ADDON_ARGUMENT.length;
      continue;
    }
    pieces.push(code.slice(cursor, at - callee[1].length), SQLITE_ADDON_LOADER);
    cursor = at + ADDON_ARGUMENT.length;
    sites++;
  }

  pieces.push(code.slice(cursor));
  return { code: pieces.join(''), sites };
}

/**
 * Read the committed hash pins.
 *
 * @param root - The package root.
 * @returns The lock contents, or `null` when there is no lockfile.
 */
export function readAddonLock(root: string): AddonLock | null {
  const lockPath = path.join(root, ADDON_LOCK_FILE);
  if (!fs.existsSync(lockPath)) return null;
  return JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as AddonLock;
}

/**
 * Thrown when a download does not match its pinned hash.
 *
 * Its own type so a caller can tell it from the failures that ARE survivable. A
 * network failure is one of those — a build with no add-on still produces a
 * working plugin that simply cannot search. A hash mismatch is not: the two
 * explanations are a re-cut release and a substituted download, and shrugging at
 * the second while writing native code into a directory the plugin will
 * `require()` from is the whole reason the lockfile exists.
 *
 * **It is raised outside {@link stageAddons}'s best-effort catch by
 * construction, so nothing has to remember to rethrow it.** An earlier cut
 * verified inside that catch and needed an `instanceof` rethrow to let a
 * mismatch escape — a guarantee resting on one deletable line, which a reviewer
 * deleted with every test still green.
 */
export class ChecksumMismatchError extends Error {
  /** @param message - What was pinned, what arrived, and what to do. */
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumMismatchError';
  }
}

/** Lowercase hex SHA-256 of a file. */
export function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Download one prebuilt tarball to a path, without unpacking it.
 *
 * Shared with `scripts/lock-addons.ts` so the thing being hashed and the thing
 * being verified are fetched by the same code.
 *
 * @param url - The release asset.
 * @param into - Where to write the tarball.
 */
export function downloadTarball(url: string, into: string): void {
  execFileSync('curl', ['-fsSL', '-o', into, url], { stdio: 'pipe' });
}

/**
 * Refuse a file that is not the bytes the lockfile pins.
 *
 * @param filePath - The tarball to check.
 * @param expected - The pinned lowercase hex SHA-256.
 * @param key - The `<platform>-<arch>-abi<N>` this is, for the message.
 * @throws {ChecksumMismatchError} When the digests differ.
 */
export function verifyPinned(filePath: string, expected: string, key: string): void {
  const actual = sha256(filePath);
  if (actual === expected) return;
  throw new ChecksumMismatchError(
    `checksum mismatch for ${key}: ${ADDON_LOCK_FILE} pins ${expected}, the file hashed to ${actual}. ` +
      'Nothing was unpacked. Either the release was re-cut — re-run `addons:lock` and review the diff — ' +
      'or these are not the bytes they claim to be.'
  );
}

/** Where {@link stageAddons} gets its bytes and how it unpacks them. */
export interface StageDeps {
  /**
   * Put the tarball at `url` on disk at `into`.
   *
   * Injected so a test can assert this was NOT called — "an unpinned target is
   * skipped" is a claim about a network request that did not happen, and there
   * is no way to observe that from the outside.
   */
  download?(url: string, into: string): void;
  /** Whether this build may reach the network at all. */
  mayFetch?(): boolean;
}

/**
 * Whether this build may reach the network for add-ons it has not cached.
 *
 * **CI does not, and that is a cost decision as much as a hygiene one.** The
 * plugin's `test` script runs `vite build` first, so every test job on a cold
 * runner would pull roughly nineteen megabytes from GitHub before running a
 * single test — on a leg that never installs a plugin into a vault and never
 * loads one of these files. The tests that touch a real `.node` use the one in
 * `node_modules`, not `dist/`, so they are unaffected by the absence.
 */
function ciMayFetch(): boolean {
  // eslint-disable-next-line no-restricted-syntax -- a build script, not app code: there is no env.ts here
  return !process.env.CI;
}

/**
 * Put every add-on this machine can use into `dist/`, verified.
 *
 * **The cache holds TARBALLS, not unpacked add-ons, and that is what makes the
 * pin mean something on every build rather than only on the first one.** An
 * extracted `.node` cannot be checked against a lockfile that pins the release
 * asset, so a cache poisoned after its first download would have been copied
 * into `dist/` unexamined for the rest of that checkout's life. Keeping the
 * pinned artifact is what lets {@link verifyPinned} run before each use.
 *
 * **Best effort about the NETWORK, never about the bytes.** A download that
 * fails must not fail `pnpm build` — nothing on a CI leg installs a plugin into
 * a vault, and a build with no add-on still produces a working plugin that
 * simply cannot search. A hash that does not match is the opposite: the two
 * explanations are a re-cut release and a substituted download, and neither is
 * something to shrug at while writing native code into a directory the plugin
 * will `require()` from.
 *
 * Exported for its tests. The guarantees here — mismatch throws, mismatch
 * escapes the best-effort catch, version drift throws, an unpinned target is
 * never fetched — are each one deletable line, and a build-only function is a
 * function whose guarantees are asserted by nothing.
 *
 * @param opts - Package root and the `better-sqlite3` version being bundled.
 * @param deps - Seams for tests; the real ones by default.
 * @returns How many add-ons made it into `dist/`.
 * @throws {ChecksumMismatchError} When a tarball is not what the lockfile pins.
 */
export function stageAddons(opts: { root: string; version: string }, deps: StageDeps = {}): number {
  const download = deps.download ?? downloadTarball;
  const mayFetch = deps.mayFetch ?? ciMayFetch;
  const cacheDir = path.join(opts.root, ADDON_CACHE_DIR);
  const distDir = path.join(opts.root, 'dist');
  const lock = readAddonLock(opts.root);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (lock && lock.version !== opts.version) {
    throw new Error(
      `sqlite-addon: ${ADDON_LOCK_FILE} pins hashes for better-sqlite3 ${lock.version}, but this build ` +
        `bundles ${opts.version}. Run \`pnpm --filter @dorkos/obsidian-plugin addons:lock\` and commit the result.`
    );
  }

  const target: AddonTarget = { platform: process.platform, arch: process.arch };
  let staged = 0;

  for (const abi of SQLITE_ADDON_ABIS) {
    const key = lockKey({ ...target, abi });
    const pinned = lock?.entries[key];
    if (!pinned) {
      console.warn(`  sqlite-addon: no pinned hash for ${key} — not fetching it`);
      continue;
    }

    const tarball = path.join(cacheDir, `${key}.tar.gz`);

    // A cached tarball that no longer hashes to its pin is thrown away rather
    // than trusted or reported: the honest recovery is to fetch it again, and
    // the fetch verifies too — so a second mismatch throws instead of looping.
    if (fs.existsSync(tarball) && sha256(tarball) !== pinned) fs.rmSync(tarball);

    if (!fs.existsSync(tarball)) {
      if (!mayFetch()) continue;
      try {
        download(prebuildUrl({ ...target, ...opts, abi }), tarball);
      } catch (err) {
        // Only a NETWORK failure can reach here, and that is the shape rather
        // than an accident of it: `download` fetches and nothing else, and the
        // hash gate below sits outside this catch. A mismatch cannot be
        // swallowed here because it cannot be thrown here.
        console.warn(
          `  sqlite-addon: could not fetch the Electron ABI ${abi} build — ${(err as Error).message}`
        );
        fs.rmSync(tarball, { force: true });
        continue;
      }
    }

    // Before every use, not only after a download.
    verifyPinned(tarball, pinned, key);
    unpackInto(tarball, path.join(distDir, addonFileName({ ...target, abi })), cacheDir);
    staged++;
  }
  return staged;
}

/**
 * Extract the one file that matters out of a verified tarball.
 *
 * `tar` is shelled out to rather than reimplemented: the archives are
 * `prebuild`'s own gzipped tarballs, `tar` reads them on macOS, Linux and
 * Windows 10+ alike, and a hand-rolled reader would be a second thing to be
 * wrong about a format nobody here controls.
 *
 * @param tarball - The verified archive.
 * @param into - Where the `.node` should end up, under its final name.
 * @param scratchRoot - Directory to make the temporary unpack dir under.
 */
function unpackInto(tarball: string, into: string, scratchRoot: string): void {
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'unpack-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', scratch, 'build/Release/better_sqlite3.node'], {
      stdio: 'pipe',
    });
    fs.copyFileSync(path.join(scratch, 'build', 'Release', 'better_sqlite3.node'), into);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Rewrite the add-on load and stage the add-ons beside the bundle.
 *
 * @param opts - Package root, and the `better-sqlite3` version to fetch builds
 *   of. Both are resolved by the caller so this plugin does no path guessing.
 * @returns The Vite plugin.
 */
export function sqliteAddon(opts: { root: string; version: string }): Plugin {
  return {
    name: 'sqlite-addon',
    writeBundle() {
      const mainPath = path.join(opts.root, 'dist', 'main.js');
      const rewritten = rewriteAddonLoad(fs.readFileSync(mainPath, 'utf-8'));
      if (rewritten.sites !== 1) {
        throw new Error(
          `sqlite-addon: expected exactly one better-sqlite3 add-on load site in the bundle, found ${rewritten.sites}. ` +
            'Either better-sqlite3 stopped being bundled (the embed can no longer read the message index) ' +
            'or its load shape changed (widen ADDON_CALLEE_TAIL in build-plugins/sqlite-addon.ts).'
        );
      }
      fs.writeFileSync(mainPath, rewritten.code);

      const staged = stageAddons(opts);
      console.log(
        staged > 0
          ? `  sqlite-addon: staged ${staged}/${SQLITE_ADDON_ABIS.length} Electron ABI(s) beside the bundle`
          : '  sqlite-addon: NO add-on staged — a plugin built from this dist/ cannot search this machine'
      );
    },
  };
}
