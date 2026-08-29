import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
// Unmocked, `electron-log`'s CJS `require('electron')` never sees the mock
// above and falls back to its own platform-branched resolver, writing a real
// log file into the developer's home (see the same note in index.test.ts).
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { offerMoveToApplications, LEDGER_FILE } from '../index';
import { resetQuitGuard, armQuitGuard } from '../../quit-guard';
import {
  app,
  dialog,
  mockUserDataPath,
  resetElectronMock,
  setMockExePath,
} from '../../__tests__/electron-mock';

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const originalPlatform = process.platform;

/** Two paths for the same translocated bundle — macOS randomizes the uuid per launch. */
const TRANSLOCATED_FIRST_LAUNCH =
  '/private/var/folders/9k/x1/T/AppTranslocation/6E3B-1111/d/DorkOS.app/Contents/MacOS/DorkOS';
const TRANSLOCATED_NEXT_LAUNCH =
  '/private/var/folders/9k/x1/T/AppTranslocation/A97F-2222/d/DorkOS.app/Contents/MacOS/DorkOS';
/** A bundle running straight off the mounted disk image, with no quarantine flag to translocate it. */
const ON_THE_DISK_IMAGE = '/Volumes/DorkOS 0.62.0/DorkOS.app/Contents/MacOS/DorkOS';

/** Pretend the ledger holds `contents`; a raw string is written to the file verbatim. */
function ledger(contents: Record<string, string> | string | null): void {
  if (contents === null) {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    return;
  }
  mockedReadFileSync.mockReturnValue(
    typeof contents === 'string' ? contents : JSON.stringify(contents)
  );
}

/** A packaged macOS build, running from `exe`, that has never been offered the move. */
function launchedFromTheWrongPlace(exe = TRANSLOCATED_FIRST_LAUNCH): void {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  app.isPackaged = true;
  app.isInApplicationsFolder = vi.fn(() => false);
  setMockExePath(exe);
  ledger(null);
}

/** Answer the offer dialog with the button at `index`. */
function answerOfferWith(index: number): void {
  dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: index, checkboxChecked: false }));
}

/** The conflict handler Electron was handed on the last move attempt. */
function capturedConflictHandler(): (type: 'exists' | 'existsAndRunning') => boolean {
  const [options] = vi.mocked(app.moveToApplicationsFolder).mock.calls[0];
  const handler = options?.conflictHandler;
  if (!handler) throw new Error('no conflictHandler was passed to moveToApplicationsFolder');
  return handler;
}

/** Whether anything was written to the ledger file. */
function ledgerWasWritten(): boolean {
  return mockedWriteFileSync.mock.calls.some(([target]) => target === expectedLedgerPath());
}

/** Where the ledger lives for the current mocked userData dir. */
function expectedLedgerPath(): string {
  return join(mockUserDataPath(), LEDGER_FILE);
}

beforeEach(() => {
  resetElectronMock();
  resetQuitGuard();
  mockedReadFileSync.mockReset();
  mockedWriteFileSync.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  delete process.env.DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT;
});

describe('offerMoveToApplications — when it speaks up', () => {
  it('offers the move, in one calm question, to a translocated copy', async () => {
    // The headline case: a freshly downloaded bundle run from anywhere outside
    // Applications is executed from a randomized read-only AppTranslocation
    // mount, which is precisely where Squirrel can never install an update.
    launchedFromTheWrongPlace(TRANSLOCATED_FIRST_LAUNCH);

    await offerMoveToApplications();

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      Electron.MessageBoxOptions,
    ];
    expect(options.message).toBe('Move DorkOS to your Applications folder?');
    expect(options.detail).toBe("Apps that run from the download window can't update themselves.");
    expect(options.buttons).toEqual(['Move to Applications', 'Not Now']);
    // Move is the default; Escape declines rather than moving anything.
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(1);
  });

  it('offers the move to a copy running off the mounted disk image', async () => {
    launchedFromTheWrongPlace(ON_THE_DISK_IMAGE);

    await offerMoveToApplications();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('says nothing to a copy already in Applications', async () => {
    launchedFromTheWrongPlace();
    app.isInApplicationsFolder = vi.fn(() => true);

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('says nothing in development, where the app is never in Applications', async () => {
    launchedFromTheWrongPlace();
    app.isPackaged = false;

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('says nothing off macOS, and never asks a question that platform cannot answer', async () => {
    launchedFromTheWrongPlace();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    // `isInApplicationsFolder` is macOS-only in real Electron, so the platform
    // test has to short-circuit ahead of it rather than merely alongside it.
    expect(app.isInApplicationsFolder).not.toHaveBeenCalled();
  });
});

describe('offerMoveToApplications — the suppression switch', () => {
  it('stays silent when told to, even from the wrong home', async () => {
    // The packaged smoke launches the real app from `release/`, which is the
    // wrong home exactly. Without this, the offer is a modal dialog raised
    // before the server starts and nobody there to answer it: the app never
    // serves /api/health and the run dies as a 120s timeout with no output.
    launchedFromTheWrongPlace();
    process.env.DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT = '1';

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
    // Silence is not a decline: nothing is recorded, so a real launch on this
    // machine is still offered the move.
    expect(ledgerWasWritten()).toBe(false);
  });

  it('offers as normal when the switch is unset', async () => {
    launchedFromTheWrongPlace();

    await offerMoveToApplications();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('ignores any value other than 1, so a stray export cannot mute the guard', async () => {
    launchedFromTheWrongPlace();
    process.env.DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT = 'true';

    await offerMoveToApplications();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe('offerMoveToApplications — a ledger it cannot trust', () => {
  it('survives a ledger holding null, which parses fine and then throws on every read', async () => {
    // `JSON.parse('null')` succeeds. Accessed unguarded, the property read that
    // follows throws at the first step of start-up — before the server or any
    // window exists — and takes the whole boot with it.
    launchedFromTheWrongPlace();
    ledger('null');

    await expect(offerMoveToApplications()).resolves.toBe(true);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a bare string', '"translocated"'],
    ['a number', '42'],
    ['an array', '[]'],
    ['truncated json', '{"askedAtLocation":'],
    ['a non-string location', '{"askedAtLocation":123}'],
  ])('treats %s as nothing recorded rather than a crash', async (_label, contents) => {
    launchedFromTheWrongPlace();
    ledger(contents);

    await expect(offerMoveToApplications()).resolves.toBe(true);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe('offerMoveToApplications — what gets remembered', () => {
  it('remembers an explicit Not Now, and only after it has been given', async () => {
    launchedFromTheWrongPlace(ON_THE_DISK_IMAGE);
    answerOfferWith(1);

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      expectedLedgerPath(),
      JSON.stringify({ askedAtLocation: ON_THE_DISK_IMAGE })
    );
    // Order, not just presence. Recording before the dialog is answered is what
    // made a cancelled authorization prompt suppress the offer for the person
    // who had just asked for it, so the write must follow the answer.
    const [asked] = vi.mocked(dialog.showMessageBox).mock.invocationCallOrder;
    const [recorded] = mockedWriteFileSync.mock.invocationCallOrder;
    expect(asked).toBeLessThan(recorded);
  });

  it('asks again next launch when the system authorization prompt is cancelled', async () => {
    // The person clicked Move and then cancelled macOS's own password prompt.
    // They want this. Recording here would deny them the offer for good.
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    app.moveToApplicationsFolder = vi.fn(() => false);

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(ledgerWasWritten()).toBe(false);
  });

  it('asks again next launch when the replace confirmation is cancelled', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    dialog.showMessageBoxSync = vi.fn(() => 1);
    app.moveToApplicationsFolder = vi.fn((options) => options?.conflictHandler?.('exists') ?? true);

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(ledgerWasWritten()).toBe(false);
  });

  it('remembers a move that could not be performed at all', async () => {
    // An Applications folder this account cannot write to fails the same way on
    // every launch; asking again could only ever produce the same dead end.
    launchedFromTheWrongPlace(ON_THE_DISK_IMAGE);
    answerOfferWith(0);
    app.moveToApplicationsFolder = vi.fn(() => {
      throw new Error('/Applications is not writable');
    });

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      expectedLedgerPath(),
      JSON.stringify({ askedAtLocation: ON_THE_DISK_IMAGE })
    );
  });

  it('records nothing when the move succeeds', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);

    await expect(offerMoveToApplications()).resolves.toBe(true);

    expect(ledgerWasWritten()).toBe(false);
  });

  it('does not ask twice in the same place', async () => {
    launchedFromTheWrongPlace(ON_THE_DISK_IMAGE);
    ledger({ askedAtLocation: ON_THE_DISK_IMAGE });

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('asks again once the app is somewhere else with a different key', async () => {
    launchedFromTheWrongPlace(ON_THE_DISK_IMAGE);
    ledger({ askedAtLocation: '/Users/kai/Applications/DorkOS.app/Contents/MacOS/DorkOS' });

    await offerMoveToApplications();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('treats every translocated launch as one place, though macOS randomizes the path', async () => {
    // The uuid in a translocated path is fresh on every launch. Keyed on the
    // raw path, "ask once" would become "ask every time" for exactly the
    // people this guard exists for.
    launchedFromTheWrongPlace(TRANSLOCATED_FIRST_LAUNCH);
    answerOfferWith(1);
    await offerMoveToApplications();
    const [, recorded] = mockedWriteFileSync.mock.calls[0] as [string, string];

    launchedFromTheWrongPlace(TRANSLOCATED_NEXT_LAUNCH);
    ledger(recorded);
    vi.mocked(dialog.showMessageBox).mockClear();

    await offerMoveToApplications();

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('still offers when the ledger cannot be written', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(1);
    mockedWriteFileSync.mockImplementation(() => {
      throw new Error('read-only volume');
    });

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe('offerMoveToApplications — the move itself', () => {
  it('moves the app when the answer is Move, and tells the caller to stop starting up', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);

    await expect(offerMoveToApplications()).resolves.toBe(true);

    expect(app.moveToApplicationsFolder).toHaveBeenCalledTimes(1);
  });

  it('moves nothing when the answer is Not Now, and carries on', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(1);

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
    expect(app.releaseSingleInstanceLock).not.toHaveBeenCalled();
  });

  it('hands the single-instance lock back before moving, so the relaunched copy can take it', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);

    await offerMoveToApplications();

    const [released] = vi.mocked(app.releaseSingleInstanceLock).mock.invocationCallOrder;
    const [moved] = vi.mocked(app.moveToApplicationsFolder).mock.invocationCallOrder;
    expect(released).toBeLessThan(moved);
  });

  it('takes the lock back when the move does not happen', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    app.moveToApplicationsFolder = vi.fn(() => false);

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('carries on from the wrong home when the move throws', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    app.moveToApplicationsFolder = vi.fn(() => {
      throw new Error('/Applications is not writable');
    });

    await expect(offerMoveToApplications()).resolves.toBe(false);

    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('quits rather than running a second copy when the lock is gone', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    app.moveToApplicationsFolder = vi.fn(() => false);
    app.requestSingleInstanceLock = vi.fn(() => false);

    // `true` here is "stop starting up" — the app is on its way out, so the
    // caller must not go on to fork a server for it.
    await expect(offerMoveToApplications()).resolves.toBe(true);

    expect(app.quit).toHaveBeenCalledTimes(1);
  });
});

describe('offerMoveToApplications — committing the quit', () => {
  /** Arm a real quit guard and report whether its sequence asked about agents. */
  function armGuardWithAgents(activeAgents: number): { asked: () => boolean } {
    armQuitGuard({
      countActiveAgents: () => activeAgents,
      getWindow: () => null,
      shutdown: () => Promise.resolve(),
      consumeUpdateRestart: () => false,
      recordUpdateInstallIntent: () => undefined,
    });
    return {
      asked: () =>
        vi.mocked(dialog.showMessageBox).mock.calls.some(([first]) => {
          const options = first as Electron.MessageBoxOptions;
          return typeof options.message === 'string' && options.message.includes('still working');
        }),
    };
  }

  it('commits the quit itself after a successful move', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);

    await offerMoveToApplications();

    // Deliberate, not left to Electron's internal quit: the relauncher waits on
    // this process's pid, so an exit that never comes strands the moved copy.
    expect(app.quit).toHaveBeenCalledTimes(1);
    const [moved] = vi.mocked(app.moveToApplicationsFolder).mock.invocationCallOrder;
    const [quit] = vi.mocked(app.quit).mock.invocationCallOrder;
    expect(moved).toBeLessThan(quit);
  });

  it('pre-confirms that quit, so the guard does not ask about agents mid-move', async () => {
    // Today there are no agents this early. This pins the contract for the day
    // someone reorders the ready sequence: a confirmed move must not be able to
    // raise a second question, whose "Keep Working" answer would leave the
    // relauncher waiting on a process that never exits.
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    const guard = armGuardWithAgents(3);

    await offerMoveToApplications();
    await app.emit('before-quit', { preventDefault: () => undefined });

    expect(guard.asked()).toBe(false);
  });

  it('withdraws the pre-confirmation when the move does not happen', async () => {
    // A confirmation left armed by a failed move would silently disarm the
    // agent question for every later quit in the session.
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    app.moveToApplicationsFolder = vi.fn(() => false);
    const guard = armGuardWithAgents(3);

    await offerMoveToApplications();
    await app.emit('before-quit', { preventDefault: () => undefined });

    expect(guard.asked()).toBe(true);
  });

  it('leaves an unrelated quit alone when no move was ever offered', async () => {
    launchedFromTheWrongPlace();
    app.isInApplicationsFolder = vi.fn(() => true);
    const guard = armGuardWithAgents(3);

    await offerMoveToApplications();
    await app.emit('before-quit', { preventDefault: () => undefined });

    expect(guard.asked()).toBe(true);
  });
});

describe('offerMoveToApplications — an existing copy in Applications', () => {
  it('asks before putting the old copy in the Trash', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    await offerMoveToApplications();

    expect(capturedConflictHandler()('exists')).toBe(true);

    const [options] = vi.mocked(dialog.showMessageBoxSync).mock.calls[0];
    expect(options.message).toBe('There is already a DorkOS in your Applications folder.');
    expect(options.detail).toBe('Moving this one there puts the old one in the Trash.');
    expect(options.buttons).toEqual(['Replace', 'Cancel']);
  });

  it('calls the move off when the replacement is declined', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    await offerMoveToApplications();
    dialog.showMessageBoxSync = vi.fn(() => 1);

    expect(capturedConflictHandler()('exists')).toBe(false);
  });

  it('lets a copy already running from Applications take over, without a second question', async () => {
    launchedFromTheWrongPlace();
    answerOfferWith(0);
    await offerMoveToApplications();

    // Electron's default focuses that instance and quits this one — the right
    // outcome, and not something worth interrupting anyone for.
    expect(capturedConflictHandler()('existsAndRunning')).toBe(true);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
  });
});
