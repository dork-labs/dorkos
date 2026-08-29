import { app, dialog } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import log from 'electron-log';
import { cancelPreconfirmedQuit, preconfirmQuit } from '../quit-guard';

/**
 * The wrong-home guard: one offer to move DorkOS into Applications.
 *
 * An app launched from the mounted disk image, or from Downloads, cannot
 * update itself — and fails silently while doing so. A `.dmg` volume is
 * read-only, so Squirrel has nowhere to write; and a still-quarantined bundle
 * anywhere outside Applications is run through App Translocation, from a
 * randomized read-only mount whose path Squirrel cannot rename into either.
 * Both produce an app that checks for updates, finds them, and can never
 * install one. That is one of the root causes behind a real user's ten-day
 * silent update failure (`research/20260823_electron-macos-dmg-install-first-run-ux.md`).
 *
 * The whole design is in two rules taken from that research:
 *
 * - **Offer, never force.** No mainstream Mac app moves itself unasked, and the
 *   one that comes closest (Figma) is best known for getting the detection
 *   wrong and nagging people whose app was already in the right place.
 * - **Never ask twice in the same place.** The ledger is keyed by install
 *   location rather than by machine, so a copy that turns up somewhere with a
 *   different key is asked again. In practice macOS collapses most wrong homes
 *   into a single key ({@link TRANSLOCATED_LOCATION}), so the guarantee this
 *   really delivers is the anti-nag one, not a promise to re-offer everywhere.
 *
 * @module main/install-location
 */

/** Index of the leftmost (default) button in a `buttons` array. */
const PRIMARY_BUTTON = 0;

/** Index of the second button — the decline, and what Escape maps to. */
const SECONDARY_BUTTON = 1;

/** Where the location we last offered at is recorded, inside `userData`. */
const LEDGER_FILE_NAME = 'install-location.json';

/**
 * Set to `1` to keep this guard silent, whatever the app's install location.
 *
 * The packaged smoke needs it (`scripts/smoke-packaged.ts`): it launches the
 * real app from its build directory, which is precisely the wrong home this
 * module exists to catch — and the offer is a **modal dialog raised before the
 * server starts**, so on a runner with nobody to answer it the app never gets
 * as far as serving `/api/health`. That is not a hypothetical; it is how this
 * seam came to exist.
 *
 * An explicit switch rather than sniffing for a build path or a CI variable: a
 * guessable special case is one a real install can stumble into, and the one
 * thing this guard must never do is go quiet for someone who genuinely cannot
 * update. Main-process only, like `DORKOS_DESKTOP_SUPPRESS_HEARTBEAT` in
 * `renderer-health/`, so the shipped preload bridge carries no test-only branch.
 */
const SUPPRESS_INSTALL_PROMPT_ENV = 'DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT';

/**
 * The path segment macOS puts in a translocated bundle's location.
 *
 * A quarantined app run from outside Applications is executed from
 * `/private/var/folders/…/AppTranslocation/<uuid>/d/DorkOS.app`, and that uuid
 * is fresh per launch — that randomization is the entire point of the feature.
 * Keying the ledger on such a path would therefore never match on the next
 * launch, and "ask once" would become "ask every single time" for exactly the
 * population this guard exists for.
 */
const TRANSLOCATION_SEGMENT = '/AppTranslocation/';

/**
 * The one location key every translocated launch collapses to.
 *
 * This covers most real wrong homes, the disk image included: a freshly
 * downloaded bundle carries the quarantine flag wherever it is run from, so
 * the disk image, Downloads and the Desktop usually all arrive here. The cost
 * is a false negative — decline in one of them and the others are not asked
 * about either. That is the right side to err on: a missed second offer is a
 * shrug, and a dialog on every launch is the failure mode people file bugs
 * about.
 */
const TRANSLOCATED_LOCATION = 'translocated';

/** What has already been offered, so it is never offered twice in one place. */
interface InstallLocationLedger {
  /** The location the move was last offered at, per {@link installLocation}. */
  askedAtLocation?: string;
}

/**
 * Whether a parsed ledger is one.
 *
 * `JSON.parse` answers with whatever the file held, and two of its answers are
 * hostile: `null` parses successfully and then throws on any property access,
 * and a bare string or number reads as a ledger with nothing in it. This runs
 * at the very first step of start-up, before the server or any window exists,
 * so a file holding `null` would otherwise take the whole boot with it.
 */
function isInstallLocationLedger(value: unknown): value is InstallLocationLedger {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InstallLocationLedger>;
  return candidate.askedAtLocation === undefined || typeof candidate.askedAtLocation === 'string';
}

/**
 * Where this copy of DorkOS is running from, as a key the ledger can compare.
 *
 * The executable path rather than the bundle path: it is 1:1 with the bundle
 * and needs no string surgery to derive.
 */
function installLocation(): string {
  const executablePath = app.getPath('exe');
  return executablePath.includes(TRANSLOCATION_SEGMENT) ? TRANSLOCATED_LOCATION : executablePath;
}

/** Absolute path of the ledger file. Resolved per call — `userData` is not known at import. */
function ledgerPath(): string {
  return join(app.getPath('userData'), LEDGER_FILE_NAME);
}

/** Read the ledger. A missing, unreadable or malformed file means nothing has been offered yet. */
function readLedger(): InstallLocationLedger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(), 'utf-8'));
    return isInstallLocationLedger(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record that the offer has been made at `location`, so it is not made there
 * again.
 *
 * A write failure is swallowed deliberately: the worst case is being asked a
 * second time, which is far better than an unhandled throw out of the app's
 * first moment of start-up.
 *
 * @param location - The install location that has now been offered at.
 */
function rememberOffered(location: string): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify({ askedAtLocation: location }));
  } catch (err) {
    log.warn('[install] Could not record where the move to Applications was offered.', err);
  }
}

/**
 * Decide what happens when a DorkOS is already sitting in Applications.
 *
 * Returning `true` takes Electron's default for that conflict, `false` calls
 * the move off. This runs **synchronously** inside `moveToApplicationsFolder`,
 * which is why it uses the blocking dialog: the API takes a plain boolean back
 * and there is nowhere to await.
 *
 * @param conflictType - Which kind of collision Electron found.
 */
function resolveConflict(conflictType: 'exists' | 'existsAndRunning'): boolean {
  // A DorkOS already *running* from Applications is the copy that should be
  // used. Electron's default focuses it and quits this one, which is the right
  // outcome and needs no question asked.
  if (conflictType === 'existsAndRunning') return true;

  const response = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Replace the DorkOS in Applications?',
    message: 'There is already a DorkOS in your Applications folder.',
    detail: 'Moving this one there puts the old one in the Trash.',
    buttons: ['Replace', 'Cancel'],
    defaultId: PRIMARY_BUTTON,
    cancelId: SECONDARY_BUTTON,
  });
  return response === PRIMARY_BUTTON;
}

/**
 * Perform the move, and leave the app in a coherent state whichever way it goes.
 *
 * Three things are set up before the call, because a successful move quits from
 * inside it and nothing after the call is guaranteed to run:
 *
 * - **The single-instance lock is released.** Electron's relauncher is a helper
 *   that waits on this process's pid before opening the destination, so the new
 *   copy should never race us for the lock — but a lock we no longer need is
 *   not worth betting the install on, and the reclaim below covers the paths
 *   that keep running.
 * - **The quit is pre-confirmed.** Electron's quit goes through `before-quit`
 *   like every other, where the quit guard would ask about interrupting agents.
 *   There are none this early, which is the only reason this works today; a
 *   later reordering of the ready sequence would put that question over a move
 *   the person already confirmed, and a declined one would strand the relauncher
 *   waiting on a process that never exits.
 * - **Both are withdrawn** on every path that turns out not to move.
 *
 * @param location - Where the app is running from, for the ledger.
 * @returns `true` when this process must stop starting up.
 */
function moveToApplications(location: string): boolean {
  app.releaseSingleInstanceLock();
  preconfirmQuit();
  try {
    if (app.moveToApplicationsFolder({ conflictHandler: resolveConflict })) {
      // Driven deliberately rather than left to the API's own quit, so the exit
      // is this module's decision and not an implementation detail of Electron's.
      // A second quit is harmless: the guard's `quitting` latch lets it through.
      app.quit();
      return true;
    }
    // Electron returns `false` only when the person answered a system prompt —
    // the macOS authorization dialog, or our own replace confirmation. They are
    // the ones who asked to move, so nothing is recorded and the offer stands
    // next launch. Suppressing it here would deny the feature to precisely the
    // people who wanted it.
    log.info('[install] The move to Applications was cancelled.');
  } catch (err) {
    // Everything that is not the person declining, per Electron's API — most
    // often an Applications folder this account cannot write to. That fails
    // again on every launch, so this is the one failure worth remembering:
    // a question that can never succeed must not be asked twice.
    log.warn('[install] Could not move DorkOS into Applications.', err);
    rememberOffered(location);
  }
  cancelPreconfirmedQuit();

  // Not moved, so this process carries on and needs its lock back. Failing to
  // get it means another DorkOS started inside that gap and now owns this
  // machine's data directory — the same situation `index.ts` quits on at
  // launch, answered the same way rather than running two servers over one
  // SQLite store.
  if (app.requestSingleInstanceLock()) return false;
  log.warn(
    '[install] Another DorkOS took the lock during the move; quitting rather than doubling up.'
  );
  app.quit();
  return true;
}

/**
 * Offer, at most once per install location, to move DorkOS into Applications.
 *
 * Silent unless this is a packaged macOS build running from outside
 * Applications, so a development run and every correctly-installed copy never
 * see it. The platform test comes first because
 * `app.isInApplicationsFolder()` is macOS-only.
 *
 * Nothing is written until the person has answered, and only two answers are
 * written at all: an explicit "Not Now", and a move that threw. A move that
 * merely came back `false` records nothing — see {@link moveToApplications} —
 * and neither does a quit from under the dialog. Both are asked again next
 * launch, which is the right side to err on now that the recorded cases are
 * only ones where asking again could not help.
 *
 * Call this **first** in the `ready` sequence, before the server is started: a
 * successful move relaunches the app, and a server forked beforehand would be
 * orphaned holding the port and the `~/.dork` store that the fresh instance is
 * about to want.
 *
 * @returns `true` when this process must stop starting up — the app has either
 *   moved and is relaunching, or is quitting in favour of another instance.
 */
export async function offerMoveToApplications(): Promise<boolean> {
  // First, and before any detection: an explicit instruction to stay quiet
  // outranks every reason this module might have to speak.
  if (process.env[SUPPRESS_INSTALL_PROMPT_ENV] === '1') {
    log.info(`[install] Not offering the move: ${SUPPRESS_INSTALL_PROMPT_ENV} is set.`);
    return false;
  }
  if (process.platform !== 'darwin' || !app.isPackaged) return false;
  if (app.isInApplicationsFolder()) return false;

  const location = installLocation();
  if (readLedger().askedAtLocation === location) return false;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Move to Applications?',
    message: 'Move DorkOS to your Applications folder?',
    detail: "Apps that run from the download window can't update themselves.",
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: PRIMARY_BUTTON,
    cancelId: SECONDARY_BUTTON,
  });

  if (response !== PRIMARY_BUTTON) {
    // The one answer that is a decision about the offer itself. Repeating a
    // question someone has already said no to is how an app teaches people to
    // stop reading its dialogs.
    rememberOffered(location);
    return false;
  }
  return moveToApplications(location);
}

/** @internal Exported for testing only — the ledger's filename inside `userData`. */
export const LEDGER_FILE = LEDGER_FILE_NAME;
