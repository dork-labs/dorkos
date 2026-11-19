/**
 * A dork-apps rebuild that only adds places counts as places-only, and
 * nothing else the build tool could not have written does (DOR-4282, C2
 * widened, rules W1 to W3). Each case compares two made-up builds shaped
 * exactly like `scripts/build-app.mjs` output, through the same comparison
 * the re-pin runs on its two verified snapshots.
 *
 * @module services/extensions/pin/__tests__/places-only-rebuild
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotsOnlyAddPlaces } from '../places-only-update.js';
import { bannerCommitOf, DORK_APPS_BUILD_RULE } from '../places-only-rebuild.js';
import {
  BASE_BUILD,
  bannerLine,
  HEAD_BUILD,
  writeDorkAppBuild,
  type DorkAppBuild,
} from './dork-apps-build-fixture.js';

let tmp: string;
let base: string;
let head: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-places-rebuild-')));
  base = path.join(tmp, 'base');
  head = path.join(tmp, 'head');
  await writeDorkAppBuild(base, BASE_BUILD);
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Compare the base build with a head build. */
async function compareWith(build: DorkAppBuild) {
  await writeDorkAppBuild(head, build);
  return snapshotsOnlyAddPlaces(base, head, 'extension.json');
}

const headBanner = bannerLine(HEAD_BUILD.id, HEAD_BUILD.version, HEAD_BUILD.commit);

/** The sha256 of a text, as `BUILD.json` records it. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Change a written `BUILD.json` in place. */
async function rewriteBuild(dir: string, edit: (build: Record<string, unknown>) => void) {
  const file = path.join(dir, 'BUILD.json');
  const build = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  edit(build);
  await fs.writeFile(file, `${JSON.stringify(build, null, 2)}\n`);
}

describe('a dork-apps rebuild that only adds places', () => {
  // Guards the whole rule set: a real rebuild (version bump, both banners,
  // BUILD.json, an added place) is places-only, and names what moved.
  it('is places-only, naming both versions and both commits', async () => {
    expect(await compareWith(HEAD_BUILD)).toEqual({
      version: { from: '1.0.0', to: '1.1.0' },
      commit: { from: 'abc1234', to: 'def5678' },
    });
  });

  // Guards W2's whole-line match and the ASCII-only rule: JS ends a `//`
  // comment at U+2028, so code after it would run.
  it('refuses a banner with U+2028 and code after it', async () => {
    expect(await compareWith({ ...HEAD_BUILD, indexBanner: `${headBanner}\u2028steal();` })).toBe(
      false
    );
    expect(bannerCommitOf(Buffer.from(`${headBanner}\u2028steal();`), 'notes', '1.1.0')).toBeNull();
  });

  // Guards W2's printable-ASCII rule and whole-line match for `\r`.
  it('refuses a \\r in the banner', async () => {
    expect(await compareWith({ ...HEAD_BUILD, indexBanner: `${headBanner}\r` })).toBe(false);
    expect(
      await compareWith({ ...HEAD_BUILD, serverBanner: headBanner.replace(': built', ':\rbuilt') })
    ).toBe(false);
  });

  // Guards W2's literal manifest id in the banner.
  it('refuses a banner naming another app', async () => {
    const other = bannerLine('other', HEAD_BUILD.version, HEAD_BUILD.commit);
    expect(await compareWith({ ...HEAD_BUILD, indexBanner: other })).toBe(false);
  });

  // Guards W2's banner version = that side's manifest version.
  it('refuses a banner version that is not the manifest version', async () => {
    const stale = bannerLine(HEAD_BUILD.id, '1.0.9', HEAD_BUILD.commit);
    expect(await compareWith({ ...HEAD_BUILD, serverBanner: stale })).toBe(false);
  });

  // Guards W2's commit pattern: the build tool writes `+dirty` for a tree
  // with uncommitted changes, and `unknown` outside git. Both are refused.
  it('refuses a +dirty or unknown commit', async () => {
    expect(await compareWith({ ...HEAD_BUILD, commit: 'def5678+dirty' })).toBe(false);
    expect(await compareWith({ ...HEAD_BUILD, commit: 'unknown' })).toBe(false);
    const dirty = Buffer.from(bannerLine('notes', '1.1.0', 'def5678+dirty'));
    expect(bannerCommitOf(dirty, 'notes', '1.1.0')).toBeNull();
    expect(DORK_APPS_BUILD_RULE.commit.test('def5678+dirty')).toBe(false);
  });

  // Guards W2's "every byte after line 1 identical".
  it('refuses one changed byte on line 2', async () => {
    expect(await compareWith({ ...HEAD_BUILD, indexBody: 'export function activatf() {}\n' })).toBe(
      false
    );
  });

  // Guards W3's "every value is the sha256 of the new snapshot's bytes".
  it('refuses a BUILD.json hash that is not of the new bytes', async () => {
    const wrong = sha256Of('something else');
    expect(
      await compareWith({
        ...HEAD_BUILD,
        editBuild: (build) => {
          (build.sha256 as Record<string, string>)['index.js'] = wrong;
        },
      })
    ).toBe(false);
  });

  // Guards W3's exact key set.
  it('refuses an extra BUILD.json key', async () => {
    expect(
      await compareWith({
        ...HEAD_BUILD,
        editBuild: (build) => {
          build.entry = 'index.js';
        },
      })
    ).toBe(false);
  });

  // Guards W3's sha256 key set = the listed files the folder holds.
  it('refuses a BUILD.json that leaves a listed file out', async () => {
    expect(
      await compareWith({
        ...HEAD_BUILD,
        editBuild: (build) => {
          delete (build.sha256 as Record<string, string>)['README.md'];
        },
      })
    ).toBe(false);
  });

  // Guards W3's commit = that side's banner commit.
  it('refuses a BUILD.json commit the banners do not name', async () => {
    expect(
      await compareWith({
        ...HEAD_BUILD,
        editBuild: (build) => {
          build.commit = 'fedcba9';
        },
      })
    ).toBe(false);
  });

  // Guards W1: nothing in the manifest but version and places may change.
  it('refuses a manifest change beyond version and places', async () => {
    expect(await compareWith({ ...HEAD_BUILD, extraManifest: { minHostVersion: '0.1.0' } })).toBe(
      false
    );
  });

  // Guards W4: any other file stays byte-identical, even when BUILD.json
  // hashes its new bytes, so only the byte-identical rule refuses it.
  it.each(['styles.scoped.css', 'README.md'])(
    'refuses a changed %s the build tool does not restamp',
    async (name) => {
      await writeDorkAppBuild(head, HEAD_BUILD);
      const changed = `${await fs.readFile(path.join(head, name), 'utf8')}/* changed */\n`;
      await fs.writeFile(path.join(head, name), changed);
      await rewriteBuild(head, (build) => {
        (build.sha256 as Record<string, string>)[name] = sha256Of(changed);
      });
      expect(await snapshotsOnlyAddPlaces(base, head, 'extension.json')).toBe(false);
    }
  );

  // Guards W3's sha256 key set = every file in the app's folder but
  // BUILD.json: a file both sides hold but neither lists is refused.
  it('refuses a file in the folder that BUILD.json does not list', async () => {
    await writeDorkAppBuild(head, HEAD_BUILD);
    const chunk = 'export const x = 1;\n';
    for (const dir of [base, head]) await fs.writeFile(path.join(dir, 'chunk.js'), chunk);
    expect(await snapshotsOnlyAddPlaces(base, head, 'extension.json')).toBe(false);

    // Listed on both sides, the same pair is places-only.
    for (const dir of [base, head]) {
      await rewriteBuild(dir, (build) => {
        (build.sha256 as Record<string, string>)['chunk.js'] = sha256Of(chunk);
      });
    }
    expect(await snapshotsOnlyAddPlaces(base, head, 'extension.json')).not.toBe(false);
  });

  // Guards the rebuild's version rule: never downward, compared part by part
  // as numbers, not as text.
  it('refuses a version that goes down, compared as numbers', async () => {
    await writeDorkAppBuild(base, { ...BASE_BUILD, version: '1.10.0' });
    expect(await compareWith({ ...HEAD_BUILD, version: '1.9.0' })).toBe(false);
    expect(await compareWith({ ...HEAD_BUILD, version: '1.10.0' })).not.toBe(false);
    expect(await compareWith({ ...HEAD_BUILD, version: '1.10.1' })).not.toBe(false);
    await writeDorkAppBuild(base, { ...BASE_BUILD, version: '1.9.0' });
    expect(await compareWith({ ...HEAD_BUILD, version: '1.10.0' })).toEqual(
      expect.objectContaining({ version: { from: '1.9.0', to: '1.10.0' } })
    );
  });
});

describe('the banner line check', () => {
  // Each id below is chosen so the line would otherwise fullmatch the
  // banner: only the named check refuses it. The check reads the line as
  // latin1, so a non-ASCII id is given in that same reading.

  /** A text's UTF-8 bytes read back as latin1, the way the check reads a line. */
  const asLatin1 = (text: string) => Buffer.from(text).toString('latin1');

  // Guards the printable-ASCII rule for U+2028, which ends a `//` comment.
  it('refuses a banner holding U+2028', () => {
    const line = Buffer.from(bannerLine('no\u2028tes', '1.1.0', 'def5678'));
    expect(bannerCommitOf(line, asLatin1('no\u2028tes'), '1.1.0')).toBeNull();
  });

  // Guards the printable-ASCII rule for any other non-ASCII byte.
  it('refuses a banner holding a non-ASCII character', () => {
    const line = Buffer.from(bannerLine('not\u00e9s', '1.1.0', 'def5678'));
    expect(bannerCommitOf(line, asLatin1('not\u00e9s'), '1.1.0')).toBeNull();
  });

  // Guards the `*/` rule: every byte is printable ASCII.
  it('refuses a banner holding */', () => {
    const line = Buffer.from(bannerLine('no*/tes', '1.1.0', 'def5678'));
    expect(bannerCommitOf(line, 'no*/tes', '1.1.0')).toBeNull();
  });

  // The control: the same check accepts a plain banner.
  it('reads the commit from a plain banner', () => {
    const line = Buffer.from(bannerLine('notes', '1.1.0', 'def5678'));
    expect(bannerCommitOf(line, 'notes', '1.1.0')).toBe('def5678');
  });
});

describe('an app the dork-apps tool did not build', () => {
  /** Drop BUILD.json from both sides, so neither is a rebuild. */
  async function withoutBuildRecords() {
    await fs.rm(path.join(base, 'BUILD.json'));
    await fs.rm(path.join(head, 'BUILD.json'));
  }

  // Only added places may differ: a version bump beside an added place asks
  // again even with every other file byte-identical, and the same pair at
  // one version is places-only.
  it('refuses a version change, even with every other file byte-identical', async () => {
    await writeDorkAppBuild(base, { ...BASE_BUILD, indexBanner: '// notes', serverBanner: '//' });
    await writeDorkAppBuild(head, {
      ...HEAD_BUILD,
      commit: BASE_BUILD.commit,
      indexBanner: '// notes',
      serverBanner: '//',
    });
    await withoutBuildRecords();
    expect(await snapshotsOnlyAddPlaces(base, head, 'extension.json')).toBe(false);

    await writeDorkAppBuild(head, {
      ...HEAD_BUILD,
      version: BASE_BUILD.version,
      commit: BASE_BUILD.commit,
      indexBanner: '// notes',
      serverBanner: '//',
    });
    await fs.rm(path.join(head, 'BUILD.json'));
    expect(await snapshotsOnlyAddPlaces(base, head, 'extension.json')).toEqual({
      version: { from: '1.0.0', to: '1.0.0' },
    });
  });

  // Guards that banner changes are allowed only beside a BUILD.json.
  it('refuses a changed banner without a BUILD.json', async () => {
    await writeDorkAppBuild(head, HEAD_BUILD);
    await withoutBuildRecords();
    expect(await snapshotsOnlyAddPlaces(base, head, 'extension.json')).toBe(false);
  });
});
