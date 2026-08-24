import { app, dialog, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { resolveDataDirectory } from '../dork-home';
import { redactSecrets } from './redact';
import { getServerPort } from '../server-process';
import { buildZip, type ZipEntry } from './zip-writer';

/**
 * One click that collects everything support would otherwise ask a person to
 * find by hand.
 *
 * Diagnosing the black-screen incident meant asking a non-technical user to
 * scavenge four hidden directories — the server log under `~/.dork/logs`, the
 * Electron log under `~/Library/Logs`, Squirrel's install state and the
 * updater's download cache, both buried in `~/Library/Caches`. Every one of
 * those is invisible in a default Finder, and getting the wrong one wasted a
 * round trip each time. This puts all of them, plus the versions and the
 * install-location facts that decide whether an update was even physically
 * possible, into a single file on the Desktop.
 *
 * Nothing here may be load-bearing for launch, and nothing here may fail
 * loudly: every source is collected independently, and a source that is
 * missing or unreadable becomes a line in `report.txt` rather than a report
 * that never gets written. The only failure that can sink the whole thing is
 * being unable to write the archive itself, which is the one failure a person
 * can act on.
 *
 * **What this is not:** a sanitised artifact. The config is redacted (see
 * `./redact`), and the log tails are not — they are shipped byte for byte,
 * because a log with pieces removed is a log you cannot diagnose from. Logs
 * here can contain file paths, project names, prompts and anything an error
 * happened to carry. `report.txt` says so at the top, and no surface that
 * offers this archive may describe it as safe to send unread.
 *
 * @module main/diagnostics
 */

/**
 * How much of each log file's tail travels in the archive.
 *
 * Logs rotate at 500KB on the server side, so a tail this size is usually the
 * whole current file — but it is a ceiling, not an assumption, because the
 * Electron log rotates on different rules. It is also about as much as a person
 * can attach to a support message without a size complaint.
 */
export const LOG_TAIL_BYTES = 500 * 1024;

/** Suffix Squirrel.Mac gives its per-app state directory in the user cache. */
const SHIPIT_DIR_SUFFIX = '.ShipIt';

/** Suffix electron-updater gives its download cache in the user cache. */
const UPDATER_DIR_SUFFIX = '-updater';

/** The file inside a Squirrel state directory that says how the last install went. */
const SHIPIT_STATE_FILE = 'ShipItState.plist';

/** Name of the archive's human-readable summary. */
const REPORT_FILE = 'report.txt';

/** A one-line description of a caught value, whether or not it is an `Error`. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read at most `maxBytes` from the end of a file.
 *
 * The tail rather than the head: the interesting part of a log is what happened
 * just before the person gave up and asked for help.
 *
 * @param filePath - Absolute path of the file to read.
 * @param maxBytes - Ceiling on how much to return.
 */
function readTail(filePath: string, maxBytes: number): Buffer {
  const handle = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(handle);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(handle, buffer, 0, length, size - length);
    // Sliced to what was actually read, not to what was asked for. These files
    // are live: a rotation between the `fstat` and the read leaves the tail of
    // the buffer as the zeroes `alloc` put there, and shipping those would pad
    // the log with NUL bytes that look like corruption in the archive.
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * A `name — size` listing of one directory. Names and sizes only, never
 * contents: what matters about an updater cache is whether a download is
 * sitting in it half-finished, and that is answered by the listing alone.
 *
 * @param dirPath - Absolute path of the directory to describe.
 */
function describeDirectory(dirPath: string): string {
  const lines = fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
    if (entry.isDirectory()) return `  ${entry.name}/`;
    try {
      return `  ${entry.name} — ${fs.statSync(path.join(dirPath, entry.name)).size} bytes`;
    } catch {
      // A broken symlink, or an entry the updater removed mid-listing.
      return `  ${entry.name} — size unavailable`;
    }
  });
  return [`${dirPath}:`, ...(lines.length > 0 ? lines : ['  (empty)'])].join('\n');
}

/**
 * The directory the OS keeps per-app caches in — where Squirrel's install state
 * and electron-updater's downloads both live.
 *
 * Derived from the home directory rather than asked of `app.getPath`, which has
 * no name for it: Electron's path names cover `userData`, `temp` and `logs` but
 * not the cache root. These three branches are the ones electron-updater
 * resolves for itself, which is what makes them the right places to look — read
 * off `app.getPath('home')` rather than `$HOME` for the same reason
 * `dork-home.ts` does, so a relocated home still resolves.
 */
function resolveCacheRoot(): string {
  const home = app.getPath('home');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local');
  return path.join(home, '.cache');
}

/**
 * Directories directly under `cacheRoot` whose name ends in `suffix`.
 *
 * Both the Squirrel state directory and the updater cache are named after
 * identifiers that live in build config rather than in this source — the app id
 * and the package name — so matching the suffix keeps the report correct if
 * either is ever renamed. A rename would otherwise turn into a confident
 * "not present", which is a worse answer than no answer.
 *
 * @param cacheRoot - The OS cache directory; see {@link resolveCacheRoot}.
 * @param suffix - The name suffix to match.
 */
function findCacheDirs(cacheRoot: string, suffix: string): string[] {
  return fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => path.join(cacheRoot, entry.name));
}

/** Can this process write to `target`? */
function isWritable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The macOS bundle that `exePath` lives inside, or `null` off macOS and for a
 * loose executable.
 *
 * @param exePath - Absolute path of the running executable.
 */
function findAppBundle(exePath: string): string | null {
  let current = exePath;
  while (current !== path.dirname(current)) {
    current = path.dirname(current);
    if (current.endsWith('.app')) return current;
  }
  return null;
}

/**
 * Where the app is installed, and whether an update could physically replace
 * it.
 *
 * Squirrel installs by swapping the whole app bundle, so an app running from a
 * read-only or translocated location — the mounted DMG, a quarantined copy in
 * `~/Downloads` — cannot update however healthy the updater is. That is
 * indistinguishable from an updater fault in a log, and it is exactly what ten
 * days of silent failed updates looked like. The writability of the bundle and
 * of the directory holding it is the fact that tells the two apart.
 */
function describeInstallLocation(): string[] {
  const exePath = app.getPath('exe');
  const bundle = findAppBundle(exePath);
  const installed = bundle ?? path.dirname(exePath);

  const lines = [
    `Executable:        ${exePath}`,
    `Install location:  ${installed}`,
    `  writable:        ${isWritable(installed) ? 'yes' : 'no'}`,
    `  parent writable: ${isWritable(path.dirname(installed)) ? 'yes' : 'no'}`,
  ];

  // macOS-only API; absent on Windows and Linux builds.
  if (typeof app.isInApplicationsFolder === 'function') {
    lines.push(`  in Applications: ${app.isInApplicationsFolder() ? 'yes' : 'no'}`);
  }
  return lines;
}

/**
 * Accumulates what goes into the archive and what could not be collected.
 *
 * The two travel together because they are the same answer: a reader needs to
 * know that `dorkos.log` is absent from the archive *because the server never
 * created it*, not because the report forgot to look.
 */
class DiagnosticsCollector {
  /** Files gathered so far, in archive order. */
  readonly entries: ZipEntry[] = [];
  /** Sources that could not be collected, one line each. */
  readonly notes: string[] = [];

  /**
   * Add a file to the archive.
   *
   * @param name - Path inside the archive.
   * @param data - The file's contents.
   */
  file(name: string, data: Buffer | string): void {
    this.entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });
  }

  /** Record a line for the report's "what could not be collected" section. */
  note(text: string): void {
    this.notes.push(text);
  }

  /**
   * Run one source's collection, turning any failure into a note.
   *
   * @param source - What was being collected, named the way a reader would
   *   name it.
   * @param collect - The collection itself.
   */
  attempt(source: string, collect: () => void): void {
    try {
      collect();
    } catch (err) {
      this.note(`${source}: ${describeError(err)}`);
    }
  }
}

/** Collect the Electron main-process log's tail. */
function collectElectronLog(collector: DiagnosticsCollector): void {
  collector.attempt('main.log', () => {
    collector.file('main.log', readTail(log.transports.file.getFile().path, LOG_TAIL_BYTES));
  });
}

/** Collect the server log's tail from the data directory the server child uses. */
function collectServerLog(collector: DiagnosticsCollector, dataDirectory: string): void {
  collector.attempt('dorkos.log', () => {
    const serverLog = path.join(dataDirectory, 'logs', 'dorkos.log');
    collector.file('dorkos.log', readTail(serverLog, LOG_TAIL_BYTES));
  });
}

/** Collect Squirrel's install state and the updater's download cache. */
function collectUpdateState(collector: DiagnosticsCollector): void {
  collector.attempt('update state', () => {
    const cacheRoot = resolveCacheRoot();
    const shipItDirs = findCacheDirs(cacheRoot, SHIPIT_DIR_SUFFIX);
    const updaterDirs = findCacheDirs(cacheRoot, UPDATER_DIR_SUFFIX);

    for (const dir of shipItDirs) {
      collector.attempt(SHIPIT_STATE_FILE, () => {
        const state = path.join(dir, SHIPIT_STATE_FILE);
        collector.file(`update/${path.basename(dir)}/${SHIPIT_STATE_FILE}`, fs.readFileSync(state));
      });
    }

    const listings = [...shipItDirs, ...updaterDirs].map((dir) => describeDirectory(dir));
    collector.file(
      'update/listings.txt',
      listings.length > 0
        ? `${listings.join('\n\n')}\n`
        : `No update state found under ${cacheRoot}.\n`
    );
  });
}

/** Collect the user's config with every secret-named field masked. */
function collectRedactedConfig(collector: DiagnosticsCollector, dataDirectory: string): void {
  collector.attempt('config.json', () => {
    const configPath = path.join(dataDirectory, 'config.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    collector.file('config-redacted.json', `${JSON.stringify(redactSecrets(parsed), null, 2)}\n`);
  });
}

/**
 * The archive's summary: the facts that are not in any log, plus an inventory
 * of what did and did not make it in.
 *
 * @param collector - The collection this report describes.
 * @param dataDirectory - The data directory the server child uses.
 * @param generatedAt - When the report was taken.
 */
function buildReportText(
  collector: DiagnosticsCollector,
  dataDirectory: string,
  generatedAt: Date
): string {
  const port = getServerPort();
  const contents = collector.entries.map((entry) => `  ${entry.name} — ${entry.data.length} bytes`);

  return [
    'DorkOS diagnostic report',
    `Generated:         ${generatedAt.toISOString()} (${generatedAt.toString()})`,
    '',
    'Before you send this: the saved keys and passwords from your settings have',
    'been replaced with [redacted], but the logs are included exactly as they',
    'were written. They can mention file paths, project names and what you asked',
    'your agents to do. Have a look through them if any of that is sensitive.',
    '',
    `DorkOS version:    ${app.getVersion()}`,
    `Packaged build:    ${app.isPackaged ? 'yes' : 'no'}`,
    `Electron:          ${process.versions.electron ?? 'unknown'}`,
    `Chrome:            ${process.versions.chrome ?? 'unknown'}`,
    `Node:              ${process.versions.node}`,
    `System:            ${process.platform} ${process.arch} (${os.release()})`,
    `Server port:       ${port === null ? 'not listening' : String(port)}`,
    `Data directory:    ${dataDirectory}`,
    ...describeInstallLocation(),
    '',
    'In this archive:',
    ...(contents.length > 0 ? contents : ['  (nothing)']),
    '',
    'Could not be collected:',
    ...(collector.notes.length > 0
      ? collector.notes.map((note) => `  ${note}`)
      : ['  (nothing — every source was collected)']),
    '',
  ].join('\n');
}

/**
 * `yyyymmdd-hhmmss` in local time — the person reading the filename is in the
 * same timezone as the problem they are reporting.
 *
 * @param when - The moment to stamp.
 */
function timestampForFileName(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  return `${day}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
}

/**
 * Wrap an async action so overlapping calls share one execution.
 *
 * Both surfaces that offer this are ordinary menu items, which means a
 * double-click is one click too many rather than a request for two reports —
 * and the two clicks land inside the same second, so they agree on the
 * filename and race to write it. Sharing the in-flight run makes the second
 * click a no-op that returns the first click's answer.
 *
 * The latch clears when the run settles, so this throttles concurrency only:
 * clicking again after a report finishes produces a new one.
 *
 * @param run - The action to guard.
 */
function shareInFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** Collect every source and write the archive. See {@link saveDiagnosticReport}. */
async function writeDiagnosticReport(): Promise<string> {
  const generatedAt = new Date();
  const dataDirectory = resolveDataDirectory();
  const collector = new DiagnosticsCollector();

  collectElectronLog(collector);
  collectServerLog(collector, dataDirectory);
  collectUpdateState(collector);
  collectRedactedConfig(collector, dataDirectory);

  // Built last so it can inventory the archive, and put first so it is what a
  // person sees on opening it.
  collector.entries.unshift({
    name: REPORT_FILE,
    data: Buffer.from(buildReportText(collector, dataDirectory, generatedAt), 'utf8'),
  });

  const zipPath = path.join(
    app.getPath('desktop'),
    `DorkOS-diagnostics-${timestampForFileName(generatedAt)}.zip`
  );
  // Written beside the target and renamed into place. A rename within one
  // directory is atomic, so the Desktop only ever holds a whole archive: what
  // a person picks up is either absent or complete, never the half a crashed
  // or overlapping write left behind.
  const partialPath = `${zipPath}.partial`;
  try {
    await fs.promises.writeFile(partialPath, buildZip(collector.entries, generatedAt));
    await fs.promises.rename(partialPath, zipPath);
  } catch (err) {
    await fs.promises.rm(partialPath, { force: true });
    throw err;
  }

  log.info(`[diagnostics] Saved a diagnostic report to ${zipPath}.`);
  return zipPath;
}

/**
 * Write a diagnostic archive to the user's Desktop.
 *
 * Overlapping calls share one run and one file; see {@link shareInFlight}.
 *
 * @returns Absolute path of the archive that was written.
 * @throws Only if the archive itself cannot be written — every individual
 *   source failing still produces a report that says so, because a report
 *   listing four unreadable sources is a diagnosis and a missing report is not.
 */
export const saveDiagnosticReport: () => Promise<string> = shareInFlight(writeDiagnosticReport);

/** Save and reveal, or explain the failure. See {@link saveDiagnosticReportInteractive}. */
async function revealDiagnosticReport(): Promise<void> {
  try {
    shell.showItemInFolder(await saveDiagnosticReport());
  } catch (err) {
    log.error('[diagnostics] Could not save the diagnostic report.', err);
    dialog.showErrorBox(
      'Could not save the diagnostic report',
      `DorkOS could not write the report to your Desktop.\n\n${describeError(err)}`
    );
  }
}

/**
 * Save a diagnostic report and reveal it, or explain why it could not be
 * saved. The handler behind the Help-menu and tray items.
 *
 * Reveals rather than opens: the point of the archive is to attach it to a
 * message, which starts with seeing it selected in a file manager. Guarded so
 * a double-click reveals once rather than twice — see {@link shareInFlight}.
 */
export const saveDiagnosticReportInteractive: () => Promise<void> =
  shareInFlight(revealDiagnosticReport);
