/**
 * Quitting the person's plain sign-in Chrome (DOR-4731).
 *
 * On a Mac, SIGTERM ends Chrome through a fast shutdown that doesn't write its newest
 * cookies, so a sign-in made just before the quit is lost. A Mac instead gets the quit ⌘Q
 * sends, aimed at the one process DorkOS spawned: a fixed script run by `/usr/bin/osascript`,
 * given only the pid and the binary as arguments. The script checks that the pid is still that
 * same binary before it asks anything to quit, so a reused pid is never touched. Linux keeps
 * SIGTERM; Windows keeps its close request.
 *
 * @module services/session/local-browser/connection/mac-quit
 */

/** The one program that runs the Mac quit, by absolute path. */
export const OSASCRIPT = '/usr/bin/osascript';

/**
 * The fixed JavaScript-for-Automation script: argv[0] is the pid, argv[1] the binary DorkOS
 * spawned. It quits that process only if the running app at that pid is that binary. It never
 * names an app or a bundle id, so the person's own Chrome is never addressed.
 */
export const MAC_QUIT_SCRIPT = `function run(argv) {
  ObjC.import('AppKit');
  if (argv.length !== 2 || !/^[1-9][0-9]*$/.test(argv[0])) return 'refused';
  var pid = parseInt(argv[0], 10);
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil() || app.processIdentifier !== pid) return 'refused';
  var url = app.executableURL;
  if (!url || url.isNil() || url.path.js !== argv[1]) return 'refused';
  return app.terminate ? 'sent' : 'refused';
}`;

/**
 * The arguments for one Mac quit. Nothing is written into the script; the pid and the binary
 * travel as arguments only.
 *
 * @param pid - The spawned child's pid.
 * @param executable - The binary DorkOS spawned it from.
 */
export function macQuitArgs(pid: number, executable: string): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('A quit needs the child’s own pid.');
  return ['-l', 'JavaScript', '-e', MAC_QUIT_SCRIPT, String(pid), executable];
}

/** The parts of a spawned child a quit reads, so tests never need a real process. */
export interface QuittableChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

/** Runs one program with arguments and waits for nothing. Tests swap it for a fake. */
export type QuitRunner = (file: string, args: string[]) => void;

/**
 * Ask a plain Chrome child to quit the way a person would, so it writes its profile out.
 * Sends nothing to a child that already ended.
 *
 * @param child - The spawned child, by its own handle.
 * @param executable - The binary it was spawned from.
 * @param platform - Which quit applies.
 * @param run - Runs the Mac script or the Windows close request.
 */
export function quitPlainChild(
  child: QuittableChild,
  executable: string,
  platform: NodeJS.Platform,
  run: QuitRunner
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'darwin') run(OSASCRIPT, macQuitArgs(child.pid, executable));
  else if (platform === 'win32') run('taskkill', ['/PID', String(child.pid)]);
  else child.kill('SIGTERM');
}
