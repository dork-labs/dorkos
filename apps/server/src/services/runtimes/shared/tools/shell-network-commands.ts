/**
 * Which commands of a shell command line fetch from the network (DOR-5236), one command at a time,
 * as the shell guard's parser splits them (`commandOf` has already removed `env`, `sudo`, `timeout`,
 * `xargs`, `NAME=value` prefixes and a program's folder).
 *
 * One marks when it is:
 *
 * - a program whose job is the network ({@link NETWORK_PROGRAMS}), or one that fetches a package
 *   and runs it ({@link PACKAGE_RUNNERS});
 * - a program named by a variable or a `$(…)`, which could be any program;
 * - given a web address as a whole word or after an `=`, unless the program only prints or
 *   searches text ({@link TEXT_ONLY}), or is `git commit`, `tag` or `notes`;
 * - a git command that talks to a remote ({@link gitFetches}), past git's own flags;
 * - `rsync` with a remote side;
 * - a package manager asked about a published package, or asked to fetch and run one (`dlx`,
 *   `npm exec`, `bun x`), `pip download`, `pipx run`, `go run module@version`;
 * - an interpreter whose arguments or script hold a web address, or whose script or module flags
 *   (`perl -M`, `ruby -r`) make a common network call;
 * - an `alias` for any of these, or any of these behind a wrapper (`watch`, `busybox`, `xargs`)
 *   or `find -exec`;
 * - a redirection to or from `/dev/tcp` or `/dev/udp`, `openssl s_client`, or `osascript` whose
 *   script opens a web address or runs one of these through `do shell script`.
 *
 * @module services/runtimes/shared/tools/shell-network-commands
 */
import path from 'node:path';
import { commandOf, scriptTexts, withNested } from '../../claude-code/shell-guard/shell-command.js';
import { parseShell, type ShellSegment } from '../../claude-code/shell-guard/shell-words.js';

/** Programs whose job is to talk to another computer: any use of one marks. */
const NETWORK_PROGRAMS: ReadonlySet<string> = new Set([
  'curl',
  'wget',
  'wget2',
  'aria2c',
  'http',
  'https',
  'xh',
  'lynx',
  'w3m',
  'links',
  'elinks',
  'gh',
  'glab',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'tftp',
  'telnet',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'mosh',
  'whois',
  'dig',
  'host',
  'nslookup',
  'yt-dlp',
  'youtube-dl',
]);

/** Programs that fetch a package and run it: any use of one marks. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx', 'uvx']);

/** Programs that only print or search text, so a web address among their words is just text. */
const TEXT_ONLY: ReadonlySet<string> = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg']);
/** Git commands whose web address is a message's text. */
const GIT_TEXT_ONLY: ReadonlySet<string> = new Set(['commit', 'tag', 'notes']);

/** Git commands that bring in another computer's refs, commits or files. */
const GIT_NETWORK: ReadonlySet<string> = new Set(['fetch', 'pull', 'clone', 'ls-remote']);
/** Git's own flags that take the next word as their value. */
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/** Package managers, and what asks one about a published package. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_LOOKUPS: ReadonlySet<string> = new Set(['view', 'v', 'info', 'show', 'search']);
/** A package manager's flags that take the next word as their value. */
const PACKAGE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--dir',
  '--prefix',
  '--filter',
  '-F',
  '-w',
  '--workspace',
  '--cwd',
]);
const NO_VALUE_FLAGS: ReadonlySet<string> = new Set();

/** Interpreters whose scripts are read for a web address or a network call. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'powershell',
  'pwsh',
]);
/** PowerShell, whose `-c`/`-Command` text is read as its script. */
const POWERSHELLS: ReadonlySet<string> = new Set(['powershell', 'pwsh']);
/** A web address anywhere in a text. */
const URL = /\b(?:https?|ftp|wss?):\/\//i;
/** A word that is a web address, whole or after an `=`. */
const URL_WORD = /(?:^|=)(?:https?|ftp|wss?):\/\//i;
/**
 * A script's common ways to reach the network: `require('https')` and its kin, Ruby's `net/http`,
 * PowerShell's web cmdlets.
 */
const NETWORK_CALL =
  /\b(?:urllib|requests|httpx|aiohttp|http\.client|socket|axios|LWP|Net::HTTP|open-uri|curl_exec|curl_init|file_get_contents|fsockopen|stream_socket_client|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|WebClient)\b|net\/http|\bfetch\s*\(|\bhttps?\.(?:get|request)\s*\(|['"](?:node:)?(?:https?|net|dgram|tls)['"]/i;
/** A shell's own network files: `exec 3<>/dev/tcp/host/80`. */
const SOCKET_FILE = /\/dev\/(?:tcp|udp)\//;
/** `openssl`'s commands that open a connection. */
const OPENSSL_CONNECTS: ReadonlySet<string> = new Set(['s_client', 's_time']);
/** AppleScript's `do shell script`, and the string it runs when that is written in place. */
const DO_SHELL_SCRIPT = /\bdo\s+shell\s+script\s*(?:"((?:[^"\\]|\\.)*)")?/gi;

/** Programs that run the command after them, with their own flags first. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'watch',
  'caffeinate',
  'stdbuf',
  'unbuffer',
  'chronic',
  'parallel',
  'flock',
  'torsocks',
  'proxychains',
  'proxychains4',
  'busybox',
  'toybox',
]);
/** `find`'s flags that run a command per file. */
const FIND_RUNS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** How many words into a wrapper the command it runs is looked for. */
const MAX_WRAPPER_SCAN = 8;

/** The positional words, past flags and the values of `valueFlags`. */
function positionals(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (valueFlags.has(arg)) at += 1;
    else if (!arg.startsWith('-')) out.push(arg);
  }
  return out;
}

/** A program's name as `commandOf` gives it, without a Windows `.exe`. */
function programName(verb: string): string {
  return verb.toLowerCase().replace(/\.exe$/, '');
}

/** Whether a git command talks to a remote. */
function gitFetches(args: readonly string[], depth: number): boolean {
  const [subcommand, action, ...rest] = positionals(args, GIT_VALUE_FLAGS);
  if (subcommand === undefined) return false;
  if (GIT_NETWORK.has(subcommand)) return true;
  if (subcommand === 'submodule') {
    if (action === 'update') return true;
    if (action === 'foreach' && depth === 0) return lineFetches(rest.join(' '), depth + 1);
  }
  if (subcommand === 'remote') return action === 'update' || action === 'show';
  if (subcommand === 'lfs') return action === 'fetch' || action === 'pull' || action === 'clone';
  if (subcommand === 'archive') {
    return args.some((arg) => arg === '--remote' || arg.startsWith('--remote='));
  }
  return false;
}

/** Whether a package manager is asked about a published package, or to fetch and run one. */
function packageManagerFetches(verb: string, args: readonly string[]): boolean {
  const [first, second] = positionals(args, PACKAGE_VALUE_FLAGS);
  if (first === undefined) return false;
  if (PACKAGE_LOOKUPS.has(first) || first === 'dlx') return true;
  if (verb === 'npm' && (first === 'exec' || first === 'x')) return true;
  if (verb === 'bun' && first === 'x') return true;
  return (first === 'pm' || first === 'npm') && second !== undefined && PACKAGE_LOOKUPS.has(second);
}

/** Whether an interpreter's arguments or script reach the network. */
function scriptFetches(verb: string, segment: ShellSegment, args: readonly string[]): boolean {
  if (/^pip[\d.]*$/.test(args[1] ?? '') && args[0] === '-m' && args[2] === 'download') return true;
  if ([...args, ...segment.scripts].some((text) => URL.test(text))) return true;
  // `perl -MLWP::Simple`, `ruby -rnet/http`: a module loaded by a flag.
  const modules = args.filter((arg) => /^-[Mr]./.test(arg)).map((arg) => arg.slice(2));
  // `python3 -m urllib.request`: a module run as the program.
  if (verb === 'python') {
    modules.push(...args.flatMap((arg, at) => (arg === '-m' ? [args[at + 1] ?? ''] : [])));
    modules.push(...args.filter((arg) => /^-m./.test(arg)).map((arg) => arg.slice(2)));
  }
  // PowerShell's script is its arguments; the shell guard's reader does not know it.
  const scripts = POWERSHELLS.has(verb) ? args : scriptTexts(segment);
  return [...scripts, ...modules].some((text) => NETWORK_CALL.test(text));
}

/** Whether a command that a wrapper runs, somewhere in its first words, reaches the network. */
function wrappedFetches(words: readonly string[], scripts: string[], depth: number): boolean {
  for (let at = 0; at < Math.min(words.length, MAX_WRAPPER_SCAN); at += 1) {
    if (segmentFetches({ words: words.slice(at), redirects: [], scripts }, depth + 1)) return true;
  }
  return false;
}

/** Whether an AppleScript opens a web address, or runs a fetching command through the shell. */
function appleScriptFetches(texts: readonly string[], depth: number): boolean {
  for (const text of texts) {
    if (URL.test(text)) return true;
    for (const match of text.matchAll(DO_SHELL_SCRIPT)) {
      // A command built from a variable could be any command.
      if (match[1] === undefined) return true;
      if (lineFetches(match[1].replace(/\\(.)/g, '$1'), depth + 1)) return true;
    }
  }
  return false;
}

/** Whether any command a wrapper or `find -exec` runs reaches the network. */
function runsAFetch(verb: string, segment: ShellSegment, args: string[], depth: number): boolean {
  if (WRAPPERS.has(verb) && wrappedFetches(args, segment.scripts, depth)) return true;
  // `xargs -a urls.txt curl`: the prefix's own flags hide the program from `commandOf`.
  const xargs = segment.words.findIndex((word) => path.basename(word) === 'xargs');
  if (xargs !== -1 && wrappedFetches(segment.words.slice(xargs + 1), [], depth)) return true;
  if (verb === 'find') {
    for (let at = 0; at < args.length; at += 1) {
      if (!FIND_RUNS.has(args[at]!)) continue;
      const inner = { words: args.slice(at + 1), redirects: [], scripts: [] };
      if (segmentFetches(inner, depth + 1)) return true;
    }
  }
  if (verb === 'alias') {
    for (const arg of args) {
      const value = /^[^=\s]+=(.*)$/s.exec(arg)?.[1];
      if (value && lineFetches(value, depth + 1)) return true;
    }
  }
  return false;
}

/** Whether a web address among the words means the command fetches it. */
function namesAWebAddress(verb: string, segment: ShellSegment, args: readonly string[]): boolean {
  if (TEXT_ONLY.has(verb)) return false;
  if (verb === 'git') {
    const [subcommand] = positionals(args, GIT_VALUE_FLAGS);
    if (subcommand !== undefined && GIT_TEXT_ONLY.has(subcommand)) return false;
  }
  return segment.words.some((word) => URL_WORD.test(word));
}

/**
 * Whether one command, by what it runs, reaches the network.
 *
 * @param segment - One command, as the shell guard's parser split it.
 * @param depth - How many wrappers deep this is; callers leave it out.
 */
export function segmentFetches(segment: ShellSegment, depth = 0): boolean {
  // `command -v curl` asks whether a program is there; it runs nothing.
  if (
    path.basename(segment.words[0] ?? '') === 'command' &&
    /^-[vV]$/.test(segment.words[1] ?? '')
  ) {
    return false;
  }
  const { verb: rawVerb, args } = commandOf(segment);
  const verb = programName(rawVerb);
  if (!verb) return false;
  // A program named by a variable or a `$(…)` could be any program.
  if (/[$`]/.test(verb)) return true;
  if (NETWORK_PROGRAMS.has(verb) || PACKAGE_RUNNERS.has(verb)) return true;
  if (namesAWebAddress(verb, segment, args)) return true;
  if ([...segment.words, ...segment.redirects].some((word) => SOCKET_FILE.test(word))) return true;
  if (verb === 'openssl') return OPENSSL_CONNECTS.has(positionals(args, NO_VALUE_FLAGS)[0] ?? '');
  if (verb === 'osascript' && appleScriptFetches([...args, ...segment.scripts], depth)) return true;
  if (verb === 'git') return gitFetches(args, depth);
  if (verb === 'rsync') {
    return args.some((arg) => !arg.startsWith('-') && /^(?:rsync:\/\/|[^/\\]+:)/.test(arg));
  }
  if (PACKAGE_MANAGERS.has(verb) && packageManagerFetches(verb, args)) return true;
  if (/^pip[\d.]*$/.test(verb)) return positionals(args, NO_VALUE_FLAGS)[0] === 'download';
  if (verb === 'pipx') return positionals(args, NO_VALUE_FLAGS)[0] === 'run';
  if (verb === 'go') {
    const [subcommand, ...rest] = positionals(args, NO_VALUE_FLAGS);
    return subcommand === 'run' && rest.some((arg) => /^[^./][^@]*@/.test(arg));
  }
  if (SCRIPT_RUNNERS.has(verb) && scriptFetches(verb, segment, args)) return true;
  return depth === 0 && runsAFetch(verb, segment, args, depth);
}

/** Whether a command line, read on its own, reaches the network. */
function lineFetches(line: string, depth: number): boolean {
  return withNested(parseShell(line)).some((segment) => segmentFetches(segment, depth));
}

/**
 * Whether a program's script text holds a web address or a common network call: what is typed
 * into an interpreter that is running.
 *
 * @param text - The script.
 */
export function scriptTextFetches(text: string): boolean {
  return URL.test(text) || NETWORK_CALL.test(text);
}
