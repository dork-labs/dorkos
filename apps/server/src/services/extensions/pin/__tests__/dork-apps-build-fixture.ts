/**
 * Made-up dork-apps builds, shaped exactly like what dork-apps'
 * `scripts/build-app.mjs` writes: a banner on line 1 of `index.js` and
 * `server.js`, and a `BUILD.json` hashing the listed files that exist. Used
 * by the places-only rebuild tests (DOR-4282, C2 widened).
 *
 * @module services/extensions/pin/__tests__/dork-apps-build-fixture
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** One build of one app, as the fixture writes it. */
export interface DorkAppBuild {
  /** Manifest id. */
  id: string;
  /** Manifest version. */
  version: string;
  /** The commit the banners and `BUILD.json` name. */
  commit: string;
  /** The manifest's places. */
  contributions: Record<string, unknown>;
  /** Manifest fields beyond the usual ones, e.g. `minHostVersion`. */
  extraManifest?: Record<string, unknown>;
  /** `index.js` after its banner line. */
  indexBody?: string;
  /** `server.js` after its banner line. */
  serverBody?: string;
  /** Replaces the banner on line 1 of `index.js`. */
  indexBanner?: string;
  /** Replaces the banner on line 1 of `server.js`. */
  serverBanner?: string;
  /** Changes `BUILD.json` before it is written. */
  editBuild?: (build: Record<string, unknown>) => void;
}

/**
 * The banner the build tool writes on line 1, without its `\n`.
 *
 * @param id - The app id.
 * @param version - The app version.
 * @param commit - The commit, as `git rev-parse --short` gives it.
 */
export function bannerLine(id: string, version: string, commit: string): string {
  return `// ${id} ${version}: built by scripts/build-app.mjs from dork-apps@${commit}. Do not edit; rebuild.`;
}

/** The files `BUILD.json` hashes when present, in the tool's order. */
const HASHED = ['extension.json', 'index.js', 'server.js', 'styles.scoped.css', 'README.md'];

/**
 * Write one build of an app into `dir`, replacing what the files held.
 *
 * @param dir - The app's folder.
 * @param build - What to write.
 */
export async function writeDorkAppBuild(dir: string, build: DorkAppBuild): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    id: build.id,
    name: 'Notes',
    version: build.version,
    serverCapabilities: { serverEntry: './server.js' },
    contributions: build.contributions,
    ...build.extraManifest,
  };
  const banner = bannerLine(build.id, build.version, build.commit);
  const files: Record<string, string> = {
    'extension.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'index.js': `${build.indexBanner ?? banner}\n${build.indexBody ?? 'export function activate() {}\n'}`,
    'server.js': `${build.serverBanner ?? banner}\n${build.serverBody ?? 'module.exports = () => {};\n'}`,
    'styles.scoped.css': '.notes { color: red; }\n',
    'README.md': '# Notes\n',
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), text);
  }
  const sha256: Record<string, string> = {};
  for (const name of HASHED) {
    if (files[name] === undefined) continue;
    sha256[name] = createHash('sha256').update(files[name]).digest('hex');
  }
  const record: Record<string, unknown> = {
    app: build.id,
    version: build.version,
    commit: build.commit,
    sha256,
  };
  build.editBuild?.(record);
  await fs.writeFile(path.join(dir, 'BUILD.json'), `${JSON.stringify(record, null, 2)}\n`);
}

/** The approved build every test starts from. */
export const BASE_BUILD: DorkAppBuild = {
  id: 'notes',
  version: '1.0.0',
  commit: 'abc1234',
  contributions: { 'right-panel': true },
};

/** A rebuild that only bumps the version and adds a place. */
export const HEAD_BUILD: DorkAppBuild = {
  ...BASE_BUILD,
  version: '1.1.0',
  commit: 'def5678',
  contributions: { 'right-panel': true, pages: true },
};
