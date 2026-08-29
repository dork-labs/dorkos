import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

import log from 'electron-log';
import { purgeStaleStagedUpdates } from '../cache';
import { resetAppBundleCache } from '../app-bundle';
import { app, resetElectronMock } from '../../__tests__/electron-mock';
import { resetLogMock } from '../../__tests__/electron-log-mock';

/**
 * Purging a staged update the running app has already passed (DOR-1455, spec
 * decision 7).
 *
 * Driven against the real filesystem in a throwaway home, because the whole
 * question is which files are left afterwards — and the cache root is **shared
 * with every other app on the machine**, so the fixture is a real one: our
 * directories sit beside four other apps' Squirrel and updater state, and
 * `afterEach` asserts on every single test that none of it was touched. That
 * invariant is here because the suite that lacked it was green while the code
 * deleted a co-tenant's in-progress download.
 */

/** Our app's identity, as `electron-builder.yml` declares it. */
const OUR_APP_ID = 'com.dorkos.desktop';

/** Our updater cache directory, as electron-builder derives it from the package name. */
const OUR_UPDATER_DIR = '@dorkosdesktop-updater';

/** The unpacked-update directory Squirrel leaves inside its state directory. */
const SHIPIT_UPDATE_DIR = 'update.7Fq2Xa';

/**
 * Other apps' update state, exactly as it sits in a real `~/Library/Caches`.
 *
 * Four real co-tenants, one of them mid-install with a large staged payload —
 * the reviewer's replica of this machine, minus the gigabyte.
 */
const CO_TENANT_FILES = [
  'com.anthropic.claudefordesktop.ShipIt/ShipItState.plist',
  'com.anthropic.claudefordesktop.ShipIt/update.aB3xY/Claude.app/Contents/Info.plist',
  'com.tinyspeck.slackmacgap.ShipIt/ShipItState.plist',
  'com.todesktop.230313mzl4w4u92.ShipIt/ShipItState.plist',
  'com.todesktop.230313mzl4w4u92.ShipIt/update.Kp9Qr/Cursor.app/Contents/MacOS/Cursor',
  'com.linear.linear.ShipIt/ShipItState.plist',
  '@cursor-updater/pending/update-info.json',
  '@cursor-updater/pending/Cursor-9.9.9-arm64-mac.zip',
  'notion-updater/pending/Notion-2.0.0-arm64-mac.zip',
];

const holder = { root: '', cache: '', coTenants: '', resources: '', bundle: '' };

const realPlatform = process.platform;
const realResourcesPath = process.resourcesPath;

/** Pretend to be running on `platform` for the duration of a test. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** Point `process.resourcesPath` at the fixture's packaged resources. */
function onResourcesPath(value: string): void {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true });
}

/** Write `contents` to `filePath`, creating its directories. */
function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/** The `pending` directory of our updater cache under the current cache root. */
function pendingDir(): string {
  return path.join(holder.cache, OUR_UPDATER_DIR, 'pending');
}

/** Our Squirrel state directory under the current cache root. */
function shipItDir(): string {
  return path.join(holder.cache, `${OUR_APP_ID}.ShipIt`);
}

/**
 * Lay down a staged update: the artifact, plus the manifest electron-updater
 * writes beside it (which names the file but never the version).
 *
 * @param fileName - The artifact's file name.
 */
function stageUpdate(fileName: string): void {
  write(path.join(pendingDir(), fileName), 'a staged download');
  write(
    path.join(pendingDir(), 'update-info.json'),
    JSON.stringify({ fileName, sha512: 'deadbeef', isAdminRightsRequired: false })
  );
}

/** Lay down our Squirrel install state: the plist, an unpacked copy, and a log it must not touch. */
function stageShipItState(): void {
  write(path.join(shipItDir(), 'ShipItState.plist'), 'bplist00');
  write(
    path.join(shipItDir(), SHIPIT_UPDATE_DIR, 'DorkOS.app', 'Contents', 'Info.plist'),
    '<plist/>'
  );
  write(path.join(shipItDir(), 'ShipIt_stderr.log'), 'squirrel said something');
}

/** The `app-update.yml` electron-builder writes into the packaged app's resources. */
function writeUpdateConfig(cacheDirName: string | null): void {
  const lines = ['provider: github', 'owner: dork-labs', 'repo: dorkos'];
  if (cacheDirName !== null) lines.push(`${'updaterCacheDirName'}: ${cacheDirName}`);
  write(path.join(holder.resources, 'app-update.yml'), `${lines.join('\n')}\n`);
}

/** Give our bundle on disk this identifier, or none at all. */
function writeOurBundle(identifier: string | null): void {
  const keys =
    identifier === null
      ? ''
      : `  <key>CFBundleIdentifier</key>\n  <string>${identifier}</string>\n`;
  write(
    path.join(holder.bundle, 'Contents', 'Info.plist'),
    `<plist version="1.0"><dict>\n${keys}  <key>CFBundleShortVersionString</key>\n  <string>0.63.0</string>\n</dict></plist>`
  );
  write(path.join(holder.bundle, 'Contents', 'MacOS', 'DorkOS'), 'binary');
}

/** Every `[updater]` line logged at info level. */
function infoLines(): string[] {
  return vi.mocked(log.info).mock.calls.map(([line]) => String(line));
}

beforeEach(() => {
  resetElectronMock();
  resetLogMock();
  resetAppBundleCache();
  onPlatform('darwin');

  holder.root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-updater-cache-'));
  holder.cache = path.join(holder.root, 'Library', 'Caches');
  holder.resources = path.join(holder.root, 'Applications', 'DorkOS.app', 'Contents', 'Resources');
  holder.bundle = path.join(holder.root, 'Applications', 'DorkOS.app');
  fs.mkdirSync(holder.cache, { recursive: true });
  onResourcesPath(holder.resources);

  // Captured separately from `holder.cache`, which one case repoints at a
  // Windows cache root: the invariant is about the directory they were written
  // into, not wherever the test under way is looking.
  holder.coTenants = holder.cache;
  for (const relative of CO_TENANT_FILES) {
    write(path.join(holder.coTenants, relative), 'someone else’s update');
  }
  writeUpdateConfig(OUR_UPDATER_DIR);
  writeOurBundle(OUR_APP_ID);

  app.getVersion = vi.fn(() => '0.63.0');
  app.getPath = vi.fn((name?: string) =>
    name === 'home' ? holder.root : path.join(holder.bundle, 'Contents', 'MacOS', 'DorkOS')
  );
});

afterEach(() => {
  // The invariant this suite exists to hold, checked after EVERY case: the
  // cache root belongs to the whole machine, and nothing in it that is not ours
  // may be touched, in any scenario, ever.
  const destroyed = CO_TENANT_FILES.filter(
    (relative) => !fs.existsSync(path.join(holder.coTenants, relative))
  );
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  onResourcesPath(realResourcesPath);
  fs.rmSync(holder.root, { recursive: true, force: true });
  expect(destroyed, 'another application’s update state was deleted').toEqual([]);
});

describe('purgeStaleStagedUpdates', () => {
  it('throws away an update the running version already is', () => {
    // The reporting user's exact end state: 0.63.0 staged in both places while
    // 0.63.0 is what finally came up. Left alone, every quit hands Squirrel a
    // copy of what she already has, for ever.
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    stageShipItState();

    const removed = purgeStaleStagedUpdates();

    expect(fs.existsSync(pendingDir())).toBe(false);
    expect(fs.existsSync(path.join(shipItDir(), 'ShipItState.plist'))).toBe(false);
    expect(fs.existsSync(path.join(shipItDir(), SHIPIT_UPDATE_DIR))).toBe(false);
    expect(removed).toHaveLength(3);
    expect(infoLines().some((line) => line.includes('Purged a staged update'))).toBe(true);
  });

  it('throws away an update an overwrite install has overtaken', () => {
    // The support remedy for a wedged updater is "download a fresh copy and
    // drag it in". Without this, the leftover staged 0.63.0 is handed to
    // Squirrel on the next quit and silently DOWNGRADES them again.
    app.getVersion = vi.fn(() => '0.65.0');
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    stageShipItState();

    purgeStaleStagedUpdates();

    expect(fs.existsSync(pendingDir())).toBe(false);
    expect(fs.existsSync(path.join(shipItDir(), SHIPIT_UPDATE_DIR))).toBe(false);
  });

  it('judges against the version it is given, not the one running', () => {
    // The manual-overwrite restart, which quits with a newer copy already on
    // disk: 0.58.0 is still the running process, so judging by that would keep
    // the staged 0.63.0 and let it land on top of the 0.65.0 just installed.
    app.getVersion = vi.fn(() => '0.58.0');
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    stageShipItState();

    const removed = purgeStaleStagedUpdates('0.65.0');

    expect(fs.existsSync(pendingDir())).toBe(false);
    expect(removed).toHaveLength(3);
  });

  it('keeps an update that is genuinely newer, and says so', () => {
    stageUpdate('DorkOS-0.64.0-arm64-mac.zip');
    stageShipItState();

    const removed = purgeStaleStagedUpdates();

    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(pendingDir(), 'DorkOS-0.64.0-arm64-mac.zip'))).toBe(true);
    expect(fs.existsSync(path.join(shipItDir(), 'ShipItState.plist'))).toBe(true);
    expect(infoLines().some((line) => line.includes('Keeping the staged 0.64.0'))).toBe(true);
  });

  it('leaves Squirrel its own logs — only the state it would act on goes', () => {
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    stageShipItState();

    purgeStaleStagedUpdates();

    // The absence of these is the strongest evidence in a support archive that
    // ShipIt failed silently; deleting them would destroy the diagnosis.
    expect(fs.existsSync(path.join(shipItDir(), 'ShipIt_stderr.log'))).toBe(true);
  });

  it('reads the version off the artifact when the manifest is corrupt', () => {
    // `update-info.json` records { fileName, sha512, isAdminRightsRequired } and
    // no version at all, so the file name is the only evidence either way.
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    write(path.join(pendingDir(), 'update-info.json'), '{ truncated');

    purgeStaleStagedUpdates();

    expect(fs.existsSync(pendingDir())).toBe(false);
  });

  it('reads the version off the manifest when the artifact is gone', () => {
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    fs.rmSync(path.join(pendingDir(), 'DorkOS-0.63.0-arm64-mac.zip'));

    purgeStaleStagedUpdates();

    expect(fs.existsSync(pendingDir())).toBe(false);
  });

  it('judges the NEWEST thing staged, never the first one listed', () => {
    // Two artifacts side by side, the older named first. Judging that one would
    // delete a legitimately newer update the person is waiting for.
    write(path.join(pendingDir(), 'DorkOS-0.62.0-arm64-mac.zip'), 'older');
    write(path.join(pendingDir(), 'DorkOS-0.64.0-arm64-mac.zip'), 'newer');

    const removed = purgeStaleStagedUpdates();

    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(pendingDir(), 'DorkOS-0.64.0-arm64-mac.zip'))).toBe(true);
  });

  it('leaves alone a staged update whose version cannot be read', () => {
    // Deleting what we could not judge is how someone loses an update.
    write(path.join(pendingDir(), 'update-info.json'), JSON.stringify({ sha512: 'deadbeef' }));
    stageShipItState();

    const removed = purgeStaleStagedUpdates();

    expect(removed).toEqual([]);
    expect(fs.existsSync(pendingDir())).toBe(true);
    expect(fs.existsSync(path.join(shipItDir(), 'ShipItState.plist'))).toBe(true);
  });

  it('says nothing and deletes nothing when the cache root does not exist', () => {
    // A first launch, or a Linux home with no ~/.cache yet. This runs on every
    // launch, so it may not warn about the ordinary case. Pointed at an empty
    // home rather than deleting this one, whose cache root holds the co-tenant
    // fixture every case is checked against.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-empty-home-'));
    app.getPath = vi.fn(() => emptyHome);

    expect(purgeStaleStagedUpdates()).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('purges the pending download off macOS too, where there is no Squirrel', () => {
    onPlatform('win32');
    holder.cache = path.join(holder.root, 'AppData', 'Local');
    stageUpdate('DorkOS-0.63.0-arm64.exe');

    const removed = purgeStaleStagedUpdates();

    expect(removed).toEqual([pendingDir()]);
    expect(fs.existsSync(pendingDir())).toBe(false);
  });
});

/**
 * Whose directories these are (the blocking review finding).
 *
 * `~/Library/Caches` holds a `.ShipIt` for every Squirrel app and a `-updater`
 * for every electron-updater app on the machine. Finding ours by suffix found
 * theirs too, and this is a delete path.
 */
describe('deleting only our own directories', () => {
  it('does not touch another app’s update state, even when ours is stale', () => {
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    stageShipItState();

    const removed = purgeStaleStagedUpdates();

    // Ours went (the afterEach invariant proves theirs did not).
    expect(fs.existsSync(pendingDir())).toBe(false);
    for (const removedPath of removed) {
      expect(removedPath.startsWith(pendingDir()) || removedPath.startsWith(shipItDir())).toBe(
        true
      );
    }
  });

  it('deletes nothing at all when app-update.yml is missing', () => {
    // Development, or any build that is not ours. electron-updater falls back to
    // the app name here; a delete path may not guess.
    fs.rmSync(path.join(holder.resources, 'app-update.yml'));
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    stageShipItState();

    expect(purgeStaleStagedUpdates()).toEqual([]);
    expect(fs.existsSync(pendingDir())).toBe(true);
    expect(fs.existsSync(path.join(shipItDir(), 'ShipItState.plist'))).toBe(true);
  });

  it('deletes nothing when app-update.yml names no cache directory', () => {
    writeUpdateConfig(null);
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');

    expect(purgeStaleStagedUpdates()).toEqual([]);
    expect(fs.existsSync(pendingDir())).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  it('refuses a cache directory name that is not one of ours', () => {
    // A name that does not carry electron-updater's own suffix is not a name we
    // can prove is ours, whatever wrote it there.
    writeUpdateConfig('Caches');
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');

    expect(purgeStaleStagedUpdates()).toEqual([]);
    expect(fs.existsSync(pendingDir())).toBe(true);
  });

  it('refuses a cache directory name that escapes the cache root', () => {
    writeUpdateConfig('../../Applications-updater');
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');

    expect(purgeStaleStagedUpdates()).toEqual([]);
    expect(fs.existsSync(pendingDir())).toBe(true);
  });

  it('leaves every Squirrel directory alone when our bundle id cannot be read', () => {
    // Without an identity there is no way to tell our `.ShipIt` from the five
    // others beside it, so none of them is touched — including ours.
    writeOurBundle(null);
    resetAppBundleCache();
    stageUpdate('DorkOS-0.63.0-arm64-mac.zip');
    stageShipItState();

    const removed = purgeStaleStagedUpdates();

    // The download cache is still identified by app-update.yml, so it goes.
    expect(fs.existsSync(pendingDir())).toBe(false);
    expect(removed).toEqual([pendingDir()]);
    expect(fs.existsSync(path.join(shipItDir(), 'ShipItState.plist'))).toBe(true);
  });
});

/**
 * Version strings that are not what they look like (review nit).
 *
 * An artifact is named `DorkOS-0.65.0-arm64-mac.zip`, and a semver parser
 * reading that name greedily sees "0.65.0 prerelease arm64-mac.zip".
 */
describe('reading a version out of an artifact name', () => {
  it('does not delete a finished release while running its release candidate', () => {
    // The proven break: `0.66.0-arm64-mac.zip` read as a prerelease of 0.66.0
    // ranks BELOW `0.66.0-rc.1`, so an rc build deleted the release it was
    // waiting for — on every launch, for ever.
    app.getVersion = vi.fn(() => '0.66.0-rc.1');
    stageUpdate('DorkOS-0.66.0-arm64-mac.zip');

    const removed = purgeStaleStagedUpdates();

    expect(removed).toEqual([]);
    expect(fs.existsSync(path.join(pendingDir(), 'DorkOS-0.66.0-arm64-mac.zip'))).toBe(true);
  });

  it('drops a release candidate once its release is running', () => {
    app.getVersion = vi.fn(() => '0.66.0');
    stageUpdate('DorkOS-0.66.0-rc.1-arm64-mac.zip');

    purgeStaleStagedUpdates();

    expect(fs.existsSync(pendingDir())).toBe(false);
  });

  it('keeps a release candidate while that candidate is what is running', () => {
    // Conservative on purpose: the core is all this reads, so `0.66.0-rc.1`
    // reads as `0.66.0` and is kept. Costing a re-stage is fine; deleting a
    // newer update is not.
    app.getVersion = vi.fn(() => '0.66.0-rc.1');
    stageUpdate('DorkOS-0.66.0-rc.1-arm64-mac.zip');

    expect(purgeStaleStagedUpdates()).toEqual([]);
  });

  it('reads the version out of a blockmap sitting beside the artifact', () => {
    write(path.join(pendingDir(), 'DorkOS-0.63.0-arm64-mac.zip.blockmap'), 'blocks');

    purgeStaleStagedUpdates();

    expect(fs.existsSync(pendingDir())).toBe(false);
  });
});
