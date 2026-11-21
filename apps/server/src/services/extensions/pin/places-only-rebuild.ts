/**
 * The rebuild half of a places-only update (DOR-4282, option C2 widened).
 * A dork-apps app is rebuilt by one tool, `scripts/build-app.mjs`, and a
 * rebuild that only adds places still changes three things beside the
 * manifest's places: its `version` (never downward), the banner on line 1 of
 * `index.js` and `server.js`, and `BUILD.json`, which hashes every other file
 * in the app's folder. This module checks exactly those, and fails closed on
 * anything else.
 *
 * Every rule about the tool's output format lives in {@link DORK_APPS_BUILD_RULE},
 * so it can be tightened in one place. `BUILD.json` is only ever checked
 * against the snapshot's own bytes; nothing decides what runs from it.
 *
 * @module services/extensions/pin/places-only-rebuild
 */
import { createHash } from 'crypto';
import { hasRepeatedOrPrototypeKey } from './places-only-manifest.js';

/**
 * The dork-apps build tool's output format, as far as a places-only update
 * may differ by it. A banner is line 1 of each banner file, exactly:
 * `// <id> <version>: built by scripts/build-app.mjs from dork-apps@<commit>. Do not edit; rebuild.`
 * A `+dirty` or `unknown` commit never matches.
 */
export const DORK_APPS_BUILD_RULE = {
  /** The build record's name, in the app's own folder. */
  buildFile: 'BUILD.json',
  /** Files whose line 1 is the build banner. */
  bannerFiles: ['index.js', 'server.js'],
  /** The exact key set of `BUILD.json`, sorted. */
  buildKeys: ['app', 'commit', 'sha256', 'version'],
  /** A commit as the tool writes it: a short or full lowercase sha. */
  commit: /^[0-9a-f]{7,40}$/,
  /** A version, `MAJOR.MINOR.PATCH` with no leading zero. */
  version: /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
  /** A hash value in `BUILD.json`'s `sha256` map. */
  sha256: /^[0-9a-f]{64}$/,
  /**
   * The banner for one app at one version, matched against the whole line.
   * Group 1 is the commit.
   *
   * @param id - The manifest id, taken literally.
   * @param version - That side's manifest version, taken literally.
   */
  banner(id: string, version: string): RegExp {
    return new RegExp(
      `^// ${escapeRegExp(id)} ${escapeRegExp(version)}: built by scripts/build-app\\.mjs ` +
        `from dork-apps@([0-9a-f]{7,40})\\. Do not edit; rebuild\\.$`
    );
  },
} as const;

/** A string as a regular expression that matches only itself. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether version `now` is at least version `was`, each `MAJOR.MINOR.PATCH`
 * compared part by part as whole numbers (so `1.10.0` is above `1.9.0`).
 * False when either is not that shape.
 */
function versionAtLeast(now: string, was: string): boolean {
  const { version } = DORK_APPS_BUILD_RULE;
  if (!version.test(now) || !version.test(was)) return false;
  const a = now.split('.');
  const b = was.split('.');
  for (let i = 0; i < 3; i++) {
    // No leading zeros, so a longer part is the bigger number, at any size.
    const x = a[i]!;
    const y = b[i]!;
    if (x.length !== y.length) return x.length > y.length;
    if (x !== y) return x > y;
  }
  return true;
}

/** One side of a rebuild: its manifest and the bytes the rules read. */
export interface RebuildSide {
  /** The manifest id. */
  id: string;
  /** The manifest version. */
  version: string;
  /** Bytes of each file in the app's folder that a rule reads, by name. */
  files: ReadonlyMap<string, Buffer>;
}

/** The commits a rebuild moved between, read from each side's `BUILD.json`. */
export interface RebuildCommits {
  /** The approved side's commit. */
  from: string;
  /** The new side's commit. */
  to: string;
}

/**
 * The commit in a banner line, or null when the line is not exactly the
 * banner for this app at this version. Printable ASCII only, so no `\r`,
 * U+2028 or U+2029 can end the comment early and run code after it.
 *
 * @param line - Line 1, without its `\n`.
 * @param id - The manifest id.
 * @param version - That side's manifest version.
 */
export function bannerCommitOf(line: Buffer, id: string, version: string): string | null {
  if (!DORK_APPS_BUILD_RULE.version.test(version)) return null;
  for (const byte of line) if (byte < 0x20 || byte > 0x7e) return null;
  const text = line.toString('latin1');
  if (text.includes('*/')) return null;
  const match = DORK_APPS_BUILD_RULE.banner(id, version).exec(text);
  return match && DORK_APPS_BUILD_RULE.commit.test(match[1]!) ? match[1]! : null;
}

/**
 * Whether a banner file changed only by its banner: line 1 (up to the first
 * `\n`) is each side's own banner, and every byte after it is identical. A
 * rebuild restamps every banner file, so even an unchanged one must carry
 * its side's banner, and a file with no `\n` is refused.
 *
 * @returns The two banner commits, or null when it changed more.
 */
function bannerOnlyChange(
  a: Buffer,
  b: Buffer,
  old: RebuildSide,
  now: RebuildSide
): RebuildCommits | null {
  const cutA = a.indexOf(0x0a);
  const cutB = b.indexOf(0x0a);
  if (cutA < 0 || cutB < 0) return null;
  if (!a.subarray(cutA).equals(b.subarray(cutB))) return null;
  const from = bannerCommitOf(a.subarray(0, cutA), old.id, old.version);
  const to = bannerCommitOf(b.subarray(0, cutB), now.id, now.version);
  return from && to ? { from, to } : null;
}

/** A `BUILD.json` record, once it passed every shape check. */
interface BuildRecord {
  commit: string;
  sha256: Record<string, string>;
}

/** A side's `BUILD.json` read strictly, or null when any rule fails. */
function readBuildRecord(bytes: Buffer | undefined, side: RebuildSide): BuildRecord | null {
  if (!bytes) return null;
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || hasRepeatedOrPrototypeKey(text)) return null;
  const keys = Object.keys(parsed).sort();
  const want = DORK_APPS_BUILD_RULE.buildKeys;
  if (keys.length !== want.length || keys.some((key, i) => key !== want[i])) return null;
  const { app, version, commit, sha256 } = parsed;
  if (app !== side.id || version !== side.version) return null;
  if (typeof commit !== 'string' || !DORK_APPS_BUILD_RULE.commit.test(commit)) return null;
  if (!isPlainObject(sha256)) return null;
  for (const value of Object.values(sha256)) {
    if (typeof value !== 'string' || !DORK_APPS_BUILD_RULE.sha256.test(value)) return null;
  }
  return { commit, sha256: sha256 as Record<string, string> };
}

/** Whether a value is a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a dork-apps rebuild changed only what the build tool restamps:
 * the banners and `BUILD.json`, with a version that did not go down. Call it
 * only once the manifests were found to differ by version and added places
 * alone, and every other file was found byte-identical. Pure: it reads only
 * the bytes it is given, which come from the two digest-checked snapshots.
 *
 * @param old - The approved side.
 * @param now - The new side. Its `files` must hold every name in `appFiles`.
 * @param appFiles - Every covered file in the app's folder but `BUILD.json`,
 *   by its path inside that folder (the same on both sides, since the file
 *   sets matched). Each side's `BUILD.json` must hash exactly these.
 * @returns Both commits, or null when anything else changed.
 */
export function rebuildOnlyRestamps(
  old: RebuildSide,
  now: RebuildSide,
  appFiles: readonly string[]
): RebuildCommits | null {
  if (!versionAtLeast(now.version, old.version)) return null;
  const commits: { from: Set<string>; to: Set<string> } = { from: new Set(), to: new Set() };
  for (const name of DORK_APPS_BUILD_RULE.bannerFiles) {
    const a = old.files.get(name);
    const b = now.files.get(name);
    if (!a && !b) continue;
    if (!a || !b) return null;
    const moved = bannerOnlyChange(a, b, old, now);
    if (!moved) return null;
    commits.from.add(moved.from);
    commits.to.add(moved.to);
  }
  const was = readBuildRecord(old.files.get(DORK_APPS_BUILD_RULE.buildFile), old);
  const is = readBuildRecord(now.files.get(DORK_APPS_BUILD_RULE.buildFile), now);
  if (!was || !is) return null;
  // Each side's banners name the commit its BUILD.json records.
  for (const commit of commits.from) if (commit !== was.commit) return null;
  for (const commit of commits.to) if (commit !== is.commit) return null;
  // The hashed names are exactly the files the app's folder holds.
  const listed = [...appFiles].sort().join('\0');
  if (Object.keys(was.sha256).sort().join('\0') !== listed) return null;
  if (Object.keys(is.sha256).sort().join('\0') !== listed) return null;
  // Every new hash is of the new snapshot's own bytes.
  for (const name of appFiles) {
    const bytes = now.files.get(name);
    if (!bytes) return null;
    if (createHash('sha256').update(bytes).digest('hex') !== is.sha256[name]) return null;
  }
  return { from: was.commit, to: is.commit };
}
