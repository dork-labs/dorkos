/**
 * What the `dorkos browser` verbs touch on the real machine, behind one
 * injectable bag so `commands/browser-commands.ts` is testable without Chrome,
 * a terminal or a clock.
 *
 * @module lib/agent-browser/browser-deps
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { env } from '../../env.js';
import { resolveDorkHome } from '../dork-home.js';
import { confirm } from '../confirm-prompt.js';
import { findChrome as locateChrome } from './chrome-locator.js';
import { launchChromeWithPipe, type CdpPipe, type ChromeExit } from './cdp-pipe.js';
import { profileLock, type ProfileLock } from './profile.js';

/** A Chrome started with no debugging channel (the `--plain` sign-in). */
export interface PlainChrome {
  /** Resolves when Chrome exits. */
  exited: Promise<ChromeExit>;
  /** Ask Chrome to quit the way closing it would (it writes the profile out). */
  quit(): void;
  /** Stop Chrome now, for when it will not quit. */
  kill(): void;
}

/** What the operator did while the agent browser was open. */
export type OperatorAction = 'enter' | 'closed' | 'cancelled';

/** Everything the browser verbs touch. Injected so tests never launch Chrome. */
export interface BrowserDeps {
  /** The DorkOS data directory. */
  dorkHome: string;
  /** Locate Chrome (honouring `--chrome`). */
  findChrome: (explicit?: string) => string;
  /** Start Chrome with a debugging pipe. */
  launchPipe: (executable: string, args: string[]) => CdpPipe;
  /** Start Chrome with no debugging channel. */
  spawnPlain: (executable: string, args: string[]) => PlainChrome;
  /** Wait for Enter, Ctrl+C, or `closed` (whichever first). */
  waitForOperator: (closed: Promise<unknown>) => Promise<OperatorAction>;
  /** Whether a person is at the keyboard. */
  interactive: boolean;
  /** Whether a Chrome holds the profile. */
  profileLock: (profileDir: string) => ProfileLock;
  /** Ask a yes/no question. */
  confirm: (message: string) => Promise<boolean>;
  /** The clock. */
  now: () => Date;
  /** Write a line to stdout. */
  log: (line: string) => void;
  /** Write a line to stderr. */
  error: (line: string) => void;
}

/** Wait for Enter or Ctrl+C on the terminal, or for `closed` to settle. */
function waitForOperatorOnTerminal(closed: Promise<unknown>): Promise<OperatorAction> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<OperatorAction>((resolve) => {
    let settled = false;
    const finish = (action: OperatorAction) => {
      if (settled) return;
      settled = true;
      rl.close();
      process.off('SIGINT', onSigint);
      resolve(action);
    };
    const onSigint = () => finish('cancelled');
    rl.once('line', () => finish('enter'));
    rl.once('SIGINT', onSigint);
    process.once('SIGINT', onSigint);
    void closed.then(() => finish('closed'));
  });
}

/** Start Chrome plainly, and quit it the way a person would. */
function spawnPlainChrome(executable: string, args: string[]): PlainChrome {
  const child = spawn(executable, args, { stdio: 'ignore' });
  const exited = new Promise<ChromeExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return {
    exited,
    quit() {
      if (child.pid === undefined) return;
      // POSIX Chrome treats SIGTERM as "quit": it closes windows and writes the
      // profile out. Windows has no SIGTERM (Node's kill there is a hard stop),
      // so ask it to close its windows instead, which is what `taskkill`
      // without `/F` does.
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
}

/** The real machine. */
export function defaultBrowserDeps(): BrowserDeps {
  return {
    dorkHome: resolveDorkHome(),
    findChrome: (explicit) =>
      locateChrome(
        {
          platform: process.platform,
          homeDir: homedir(),
          pathVar: env.PATH,
          localAppData: env.LOCALAPPDATA,
          programFiles: env.PROGRAMFILES,
          programFilesX86: env['PROGRAMFILES(X86)'],
          exists: (file) => {
            try {
              return fs.statSync(file).isFile();
            } catch {
              return false;
            }
          },
        },
        explicit
      ),
    launchPipe: (executable, args) => launchChromeWithPipe(executable, args),
    spawnPlain: spawnPlainChrome,
    waitForOperator: waitForOperatorOnTerminal,
    interactive: Boolean(process.stdin.isTTY),
    profileLock: (profileDir) => profileLock(profileDir),
    confirm,
    now: () => new Date(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}
