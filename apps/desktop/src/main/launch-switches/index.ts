/**
 * Chromium and Node switches that attach a debugger to the app. A packaged
 * build refuses to start with any of them; debugging is for dev builds.
 *
 * `js-flags` is not in this list: it only passes flags through to V8, so it is
 * refused only when one of those flags is an inspector (see
 * {@link findRefusedLaunchSwitch}).
 */
export const REFUSED_LAUNCH_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
  'inspect',
  'inspect-brk',
  'inspect-brk-node',
  'inspect-port',
  'inspect-wait',
  'debug-port',
] as const;

/** The switch that passes flags to V8; refused when it carries an inspector flag. */
const JS_FLAGS = 'js-flags';

/** An inspector flag inside a `--js-flags` value. */
const INSPECTOR_FLAG = /(^|\s)--?inspect/i;

/** The part of `app.commandLine` this check reads. */
export interface LaunchCommandLine {
  hasSwitch(name: string): boolean;
  getSwitchValue(name: string): string;
}

/**
 * Split one argv token into a switch name and value, the way Chromium reads
 * it: `--name`, `-name`, and on Windows `/name`, each with an optional `=value`.
 *
 * @returns `null` when the token is not a switch.
 */
function parseSwitch(
  token: string,
  platform: NodeJS.Platform
): { name: string; value: string } | null {
  const prefix =
    /^--?/.exec(token)?.[0] ?? (platform === 'win32' && token.startsWith('/') ? '/' : '');
  if (!prefix) return null;
  const body = token.slice(prefix.length);
  const equals = body.indexOf('=');
  const name = (equals === -1 ? body : body.slice(0, equals)).toLowerCase();
  return name ? { name, value: equals === -1 ? '' : body.slice(equals + 1) } : null;
}

/**
 * Find a debugging switch on this launch's command line.
 *
 * Reads both the raw `argv` and Chromium's parsed command line, so a switch
 * one of them normalised away is still seen by the other.
 *
 * @param argv - `process.argv`; the first entry is the executable and is skipped.
 * @param commandLine - `app.commandLine`.
 * @param platform - `process.platform`, which decides whether `/name` is a switch.
 * @returns The first refused switch's name, or `null` when there is none.
 */
export function findRefusedLaunchSwitch(
  argv: readonly string[],
  commandLine: LaunchCommandLine,
  platform: NodeJS.Platform
): string | null {
  const refused = new Set<string>(REFUSED_LAUNCH_SWITCHES);
  for (const token of argv.slice(1)) {
    const parsed = parseSwitch(token, platform);
    if (!parsed) continue;
    if (refused.has(parsed.name)) return parsed.name;
    if (parsed.name === JS_FLAGS && INSPECTOR_FLAG.test(parsed.value)) return JS_FLAGS;
  }
  for (const name of REFUSED_LAUNCH_SWITCHES) {
    if (commandLine.hasSwitch(name)) return name;
  }
  if (
    commandLine.hasSwitch(JS_FLAGS) &&
    INSPECTOR_FLAG.test(commandLine.getSwitchValue(JS_FLAGS))
  ) {
    return JS_FLAGS;
  }
  return null;
}
