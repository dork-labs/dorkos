import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway filesystem standing in for a real install: the Desktop the
// archive lands on, the OS cache holding Squirrel's and the updater's state,
// the data directory holding the server log and config, and an app bundle to
// read install-location facts off. `vi.hoisted` holds the paths because the
// module mocks below are evaluated before any of it can be created.
const holder = vi.hoisted(() => ({
  root: '',
  dataDirectory: '',
  desktop: '',
  cache: '',
  exe: '',
  mainLog: '',
}));

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));
vi.mock('../../dork-home', () => ({ resolveDataDirectory: () => holder.dataDirectory }));
vi.mock('../../server-process', () => ({ getServerPort: vi.fn((): number | null => 4242) }));

import { LOG_TAIL_BYTES, saveDiagnosticReport, saveDiagnosticReportInteractive } from '../index'; // prettier-ignore
import { REDACTED } from '../redact';
import { SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { app, dialog, resetElectronMock, shell } from '../../__tests__/electron-mock';
import log, { resetLogMock } from '../../__tests__/electron-log-mock';
import { readZip } from './zip-reader';

/**
 * A `config.json` shaped like the real `UserConfigSchema`, carrying a secret at
 * every path the schema declares sensitive.
 *
 * Built from `SENSITIVE_CONFIG_KEYS` rather than invented, so the archive is
 * proved against the credentials a user's file can actually hold — an invented
 * fixture is what let `tunnel.auth` through the first time.
 */
const CONFIG_FIXTURE: Record<string, unknown> = { server: { port: 4242 } };
SENSITIVE_CONFIG_KEYS.forEach((key, index) => {
  const [section, leaf] = key.split('.') as [string, string];
  CONFIG_FIXTURE[section] = {
    ...((CONFIG_FIXTURE[section] as object) ?? {}),
    [leaf]: `s3cret-${index}-${key}`,
  };
});

/** The Squirrel state directory a packaged macOS install leaves in the cache. */
const SHIPIT_DIR = 'com.dorkos.desktop.ShipIt';
/** The download cache electron-updater leaves in the cache. */
const UPDATER_DIR = '@dorkosdesktop-updater';

/** Write a file, creating its parent directories. */
function write(filePath: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/** Read the archive `saveDiagnosticReport` just wrote. */
function openReport(zipPath: string): Map<string, Buffer> {
  return readZip(fs.readFileSync(zipPath));
}

/** The archive's `report.txt`, as text. */
function reportText(files: Map<string, Buffer>): string {
  const report = files.get('report.txt');
  if (!report) throw new Error('the archive has no report.txt');
  return report.toString('utf8');
}

const realPlatform = process.platform;

/** Pretend to be running on `platform` for the duration of a test. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  resetElectronMock();
  resetLogMock();
  vi.clearAllMocks();
  // The fixture lays out a macOS home; the cache root is derived from the
  // platform, so it has to be pinned rather than inherited from the runner.
  onPlatform('darwin');

  holder.root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-diagnostics-'));
  holder.dataDirectory = path.join(holder.root, 'dork');
  holder.desktop = path.join(holder.root, 'Desktop');
  holder.cache = path.join(holder.root, 'Library', 'Caches');
  holder.exe = path.join(holder.root, 'Applications', 'DorkOS.app', 'Contents', 'MacOS', 'DorkOS');
  holder.mainLog = path.join(holder.root, 'Logs', 'main.log');

  fs.mkdirSync(holder.desktop, { recursive: true });
  fs.mkdirSync(holder.cache, { recursive: true });
  write(holder.exe, 'binary');
  write(holder.mainLog, 'electron main log\n');
  write(path.join(holder.dataDirectory, 'logs', 'dorkos.log'), '{"msg":"server log"}\n');
  write(path.join(holder.dataDirectory, 'logs', 'updater.log'), '[updater] checked\n');
  write(path.join(holder.dataDirectory, 'config.json'), JSON.stringify(CONFIG_FIXTURE));
  write(path.join(holder.cache, SHIPIT_DIR, 'ShipItState.plist'), 'bplist00');
  write(path.join(holder.cache, UPDATER_DIR, 'DorkOS-0.63.0.zip'), 'a staged download');

  app.getVersion = vi.fn(() => '0.63.0');
  app.getPath = vi.fn((name?: string) => {
    if (name === 'desktop') return holder.desktop;
    if (name === 'home') return holder.root;
    if (name === 'exe') return holder.exe;
    return path.join(holder.root, 'userData');
  });
  log.transports.file.getFile = () => ({ path: holder.mainLog });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  fs.rmSync(holder.root, { recursive: true, force: true });
});

describe('saveDiagnosticReport', () => {
  it('writes a timestamped archive to the Desktop and returns its path', async () => {
    const zipPath = await saveDiagnosticReport();

    expect(path.dirname(zipPath)).toBe(holder.desktop);
    expect(path.basename(zipPath)).toMatch(/^DorkOS-diagnostics-\d{8}-\d{6}\.zip$/);
    expect(fs.existsSync(zipPath)).toBe(true);
  });

  it('collects all four hidden sources support used to ask for by hand', async () => {
    const files = openReport(await saveDiagnosticReport());

    expect([...files.keys()]).toEqual([
      'report.txt',
      'main.log',
      'dorkos.log',
      'updater.log',
      `update/${SHIPIT_DIR}/ShipItState.plist`,
      'update/listings.txt',
      'config-redacted.json',
    ]);
    expect(files.get('main.log')!.toString('utf8')).toBe('electron main log\n');
    expect(files.get('dorkos.log')!.toString('utf8')).toBe('{"msg":"server log"}\n');
    expect(files.get('updater.log')!.toString('utf8')).toBe('[updater] checked\n');
    expect(files.get(`update/${SHIPIT_DIR}/ShipItState.plist`)!.toString('utf8')).toBe('bplist00');
  });

  it('keeps the END of a long log, capped at the tail size', async () => {
    const serverLog = path.join(holder.dataDirectory, 'logs', 'dorkos.log');
    write(serverLog, `HEAD-MARKER${'.'.repeat(LOG_TAIL_BYTES)}TAIL-MARKER`);

    const collected = openReport(await saveDiagnosticReport()).get('dorkos.log')!;

    expect(collected).toHaveLength(LOG_TAIL_BYTES);
    expect(collected.toString('utf8').endsWith('TAIL-MARKER')).toBe(true);
    expect(collected.toString('utf8')).not.toContain('HEAD-MARKER');
  });

  it('lists the update directories by name and size, never their contents', async () => {
    const listings = openReport(await saveDiagnosticReport())
      .get('update/listings.txt')!
      .toString('utf8');

    expect(listings).toContain(path.join(holder.cache, SHIPIT_DIR));
    expect(listings).toContain(path.join(holder.cache, UPDATER_DIR));
    expect(listings).toContain('DorkOS-0.63.0.zip — 17 bytes');
    expect(listings).not.toContain('a staged download');
  });

  it('carries no credential out of the config, at any path the schema calls sensitive', async () => {
    const archive = openReport(await saveDiagnosticReport());
    const config = JSON.parse(archive.get('config-redacted.json')!.toString('utf8')) as Record<
      string,
      Record<string, unknown>
    >;

    for (const key of SENSITIVE_CONFIG_KEYS) {
      const [section, leaf] = key.split('.') as [string, string];
      expect(config[section][leaf]).toBe(REDACTED);
    }
    // The whole archive, not just the config: a secret must reach no entry.
    for (const entry of archive.values()) expect(entry.toString('utf8')).not.toContain('s3cret-');
    expect(config.server.port).toBe(4242);
  });

  it('warns in report.txt that the logs are not redacted', async () => {
    // The archive is offered as something to send to support, and 500KB of raw
    // log travels in it — so no surface may call it safe to send unread.
    const report = reportText(openReport(await saveDiagnosticReport()));

    expect(report).toContain('the logs are included exactly as they');
    expect(report).toContain('[redacted]');
  });

  it('reports the versions, port, data directory and install location', async () => {
    const report = reportText(openReport(await saveDiagnosticReport()));

    expect(report).toContain('DorkOS version:    0.63.0');
    expect(report).toContain('Server port:       4242');
    expect(report).toContain(`Data directory:    ${holder.dataDirectory}`);
    expect(report).toContain(`Executable:        ${holder.exe}`);
    expect(report).toContain(
      `Install location:  ${path.join(holder.root, 'Applications', 'DorkOS.app')}`
    );
    expect(report).toContain('  writable:        yes');
    expect(report).toContain('  in Applications: yes');
    expect(report).toContain(`Node:              ${process.versions.node}`);
  });

  it('still produces a report when every source is missing, and names each one', async () => {
    fs.rmSync(holder.dataDirectory, { recursive: true, force: true });
    fs.rmSync(holder.mainLog, { force: true });
    fs.rmSync(path.join(holder.cache, SHIPIT_DIR), { recursive: true, force: true });
    fs.rmSync(path.join(holder.cache, UPDATER_DIR), { recursive: true, force: true });

    const files = openReport(await saveDiagnosticReport());
    const report = reportText(files);

    // The report and the (empty) update listing survive; nothing else can.
    expect([...files.keys()]).toEqual(['report.txt', 'update/listings.txt']);
    expect(report).toContain('Could not be collected:');
    expect(report).toContain('main.log: ENOENT');
    expect(report).toContain('dorkos.log: ENOENT');
    expect(report).toContain('updater.log: ENOENT');
    expect(report).toContain('config.json: ENOENT');
    expect(files.get('update/listings.txt')!.toString('utf8')).toContain('No update state found');
  });

  it('rejects only when the archive itself cannot be written', async () => {
    app.getPath = vi.fn((name?: string) =>
      name === 'desktop' ? path.join(holder.root, 'no', 'such', 'desktop') : holder.root
    );

    await expect(saveDiagnosticReport()).rejects.toThrow(/ENOENT/);
  });
});

describe('overlapping invocations (the double-click)', () => {
  it('shares one run and one file when called twice at once', async () => {
    // The filename is second-resolution, so a double-click agrees on a name
    // and two writers race into it — measured tearing 13 times in 40 before
    // the guard existed.
    const [first, second] = await Promise.all([saveDiagnosticReport(), saveDiagnosticReport()]);

    expect(second).toBe(first);
    expect(fs.readdirSync(holder.desktop)).toEqual([path.basename(first)]);
  });

  it('never leaves a .partial file behind, on success or on failure', async () => {
    await saveDiagnosticReport();
    expect(fs.readdirSync(holder.desktop).some((name) => name.endsWith('.partial'))).toBe(false);

    // A rename that cannot land must not leave the staged bytes lying around.
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EXDEV: cross-device link'));
    await expect(saveDiagnosticReport()).rejects.toThrow(/EXDEV/);

    expect(fs.readdirSync(holder.desktop).some((name) => name.endsWith('.partial'))).toBe(false);
  });
});

describe('where the update state is looked for', () => {
  it.each([
    ['win32', ['AppData', 'Local']],
    ['linux', ['.cache']],
  ] as const)('follows the OS cache convention on %s', async (platform, segments) => {
    // Electron has no path name for the cache root, so this is derived — and a
    // derivation that is only ever exercised on the runner's own platform is
    // one that ships broken to the other two.
    onPlatform(platform);
    const cacheRoot = path.join(holder.root, ...segments);
    write(path.join(cacheRoot, UPDATER_DIR, 'DorkOS-0.63.0.bin'), 'a staged download');

    const listings = openReport(await saveDiagnosticReport())
      .get('update/listings.txt')!
      .toString('utf8');

    expect(listings).toContain(path.join(cacheRoot, UPDATER_DIR));
    // The macOS fixture's cache is still on disk, and must not be read here.
    expect(listings).not.toContain(holder.cache);
  });
});

describe('saveDiagnosticReportInteractive', () => {
  it('reveals the archive it just wrote', async () => {
    await saveDiagnosticReportInteractive();

    expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
    const [revealed] = vi.mocked(shell.showItemInFolder).mock.calls[0];
    expect(fs.existsSync(revealed)).toBe(true);
    expect(path.dirname(revealed)).toBe(holder.desktop);
  });

  it('explains a failure in a dialog rather than throwing into the menu handler', async () => {
    // The caller is a menu click, whose rejection Electron surfaces nowhere —
    // an unhandled throw here is a button that does nothing, forever.
    app.getPath = vi.fn((name?: string) =>
      name === 'desktop' ? path.join(holder.root, 'no', 'such', 'desktop') : holder.root
    );

    await expect(saveDiagnosticReportInteractive()).resolves.toBeUndefined();

    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(dialog.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, body] = vi.mocked(dialog.showErrorBox).mock.calls[0];
    expect(title).toBe('Could not save the diagnostic report');
    expect(body).toContain('ENOENT');
    expect(log.error).toHaveBeenCalled();
  });
});
