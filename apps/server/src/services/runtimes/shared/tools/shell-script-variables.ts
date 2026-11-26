/**
 * A shell script file read command by command for the network (DOR-5240), with its own variables:
 * `CURL=curl` then `$CURL …` runs curl, and `"$@"` or `$1` as the program runs the arguments the
 * script was given (after any `shift`), and `eval "$1"` runs what it was given. A program named by
 * a variable still unknown here, or by a `$(…)`, could be any program, so it marks
 * (`shell-network-commands.ts`).
 *
 * @module services/runtimes/shared/tools/shell-script-variables
 */
import { commandOf, withNested } from '../../claude-code/shell-guard/shell-command.js';
import { expandVariables, parseShell } from '../../claude-code/shell-guard/shell-words.js';
import { expandTilde } from '../../../../lib/boundary.js';
import { segmentFetches } from './shell-network-commands.js';

/** Words that set the variables named after them (`export NAME=value`). */
const SETTERS: ReadonlySet<string> = new Set(['export', 'local', 'readonly', 'declare', 'typeset']);
/** A variable set in place: `NAME=value`. */
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.+)$/s;
/** `$1` to `$9`, plain or braced. */
const POSITIONAL = /\$\{?([1-9])\}?/g;

/** An array set in place with no command inside: `files+=("$f")`. */
const ARRAY_ASSIGNMENT = /\b([A-Za-z_]\w*)\+?=\((?:[^()`$\n]|\$(?!\())*\)/g;

/** Where arithmetic or a test starts: `$((` anywhere, `((` and `[[` where a command starts. */
const TEST_OPENERS = /\$(\(\()|(?:^|[\s;&|!(])(\(\(|\[\[)/gm;

/**
 * The script with its arithmetic (`$((…))`, `((…))`), `[[ … ]]` tests and plain array values set
 * aside, in one pass each: the shell reads no command in them, and their brackets and `$` would
 * read as one. One left open on its line stays as written.
 */
function withoutTests(text: string): string {
  let out = '';
  let at = 0;
  // The next of each closer and of the line's end, found once and reused: each search moves on.
  const next: Record<string, number> = { ']]': -2, '))': -2, '\n': -2 };
  const after = (marker: string, from: number): number => {
    if (next[marker]! !== -1 && next[marker]! < from) next[marker] = text.indexOf(marker, from);
    return next[marker]! === -1 ? text.length : next[marker]!;
  };
  TEST_OPENERS.lastIndex = 0;
  for (let found = TEST_OPENERS.exec(text); found; found = TEST_OPENERS.exec(text)) {
    const open = found.index + found[0].length - 2;
    if (open < at) continue;
    const test = found[2] === '[[';
    const close = after(test ? ']]' : '))', open + 2);
    if (close >= after('\n', open)) continue;
    const start = found[1] ? open - 1 : open;
    out += `${text.slice(at, start)}${test ? 'true' : '0'}`;
    at = close + 2;
    TEST_OPENERS.lastIndex = at;
  }
  return (out + text.slice(at)).replace(ARRAY_ASSIGNMENT, '$1=array');
}

/** One word with the script's arguments put in: `"$@"` and `$*` open into all of them. */
function withArguments(word: string, args: readonly string[]): string[] {
  if (word === '$@' || word === '$*' || word === '${@}' || word === '${*}') return [...args];
  return [word.replace(POSITIONAL, (_, at: string) => args[Number(at) - 1] ?? '')];
}

/**
 * Whether a shell script's text, read with its own variables and arguments, reaches the network.
 *
 * @param text - The script.
 * @param args - The arguments the command line gives it.
 */
export function shellFileFetches(text: string, args: readonly string[]): boolean {
  const home = expandTilde('~');
  const vars: Record<string, string | undefined> = { HOME: home };
  let given = [...args];
  for (const segment of withNested(parseShell(withoutTests(text)))) {
    const words: string[] = [];
    let setting = true;
    // `shift` drops the first arguments, so `mode=$1; shift; "$@"` runs the rest.
    const [first, count] = segment.words;
    if (first === 'shift') {
      given = given.slice(/^\d+$/.test(count ?? '') ? Number(count) : 1);
      continue;
    }
    for (const raw of segment.words) {
      for (const opened of withArguments(raw, given)) {
        // A word variables would grow past the limit keeps its `$`, which reads as unknown.
        const word = expandVariables(opened, home, vars) ?? opened;
        words.push(word);
        const assigned = ASSIGNMENT.exec(word);
        // Only a value written here: `X=$(…)` arrives empty, and stays unknown.
        if (setting && assigned) vars[assigned[1]!] = assigned[2];
        else setting = SETTERS.has(word);
      }
    }
    // A `case` pattern (`*"$x"*)`) ends where its `)` is, so it reads as a command of its own.
    if (commandOf({ ...segment, words }).verb.includes('*')) continue;
    // Read again with the arguments put in: `eval "$1"` and `sh -c "$1"` run what they were given.
    if (withNested([{ ...segment, words }]).some((one) => segmentFetches(one))) return true;
  }
  return false;
}
