/**
 * Programs that start another program for a project (DOR-5261): `pnpm exec tsx x.ts`, `pnpm tsx
 * x.ts`, `yarn exec …`, `uv run x.py`, `poetry run python x.py`, `pipenv run python x.py`. The
 * command they start is read as if it were typed, so its network programs and script files count.
 *
 * @module services/runtimes/shared/tools/script-launchers
 */
import { commandOf } from '../../claude-code/shell-guard/shell-command.js';
import type { ShellSegment } from '../../claude-code/shell-guard/shell-words.js';

/** How one launcher names the command it starts. */
interface Launcher {
  /** The word before the command (`exec`, `run`). */
  run: string;
  /** Flags that take the next word as their value. */
  values: ReadonlySet<string>;
  /** Whether a known interpreter right after its own flags is started too (`pnpm tsx x.ts`). */
  bins?: boolean;
  /** Whether a `.py` file in place of the command is run by Python (`uv run x.py`). */
  python?: boolean;
}

const NODE_PACKAGE_VALUES: ReadonlySet<string> = new Set([
  '-C',
  '--dir',
  '--prefix',
  '--filter',
  '-F',
  '--cwd',
]);

const LAUNCHERS: Readonly<Record<string, Launcher>> = {
  pnpm: { run: 'exec', values: NODE_PACKAGE_VALUES, bins: true },
  yarn: { run: 'exec', values: NODE_PACKAGE_VALUES, bins: true },
  uv: {
    run: 'run',
    values: new Set([
      ...['--with', '--python', '-p', '--directory', '--project', '--package', '--env-file'],
      ...['--extra', '--group', '--index', '--from', '--with-requirements'],
    ]),
    python: true,
  },
  poetry: { run: 'run', values: new Set(['-C', '--directory', '-P', '--project']) },
  pipenv: { run: 'run', values: new Set() },
};

/** Interpreters a package manager starts by name from the project's own tools. */
const PROJECT_BINS: ReadonlySet<string> = new Set(['tsx', 'ts-node', 'node', 'vite-node']);

/**
 * The command a launcher starts, as its own command; `undefined` when the segment is no launcher.
 *
 * @param segment - One command.
 */
export function launchedCommand(segment: ShellSegment): ShellSegment | undefined {
  const { verb, args } = commandOf(segment);
  const launcher = LAUNCHERS[verb];
  if (!launcher) return undefined;
  let at = 0;
  let started = false;
  for (; at < args.length; at += 1) {
    const arg = args[at]!;
    if (launcher.values.has(arg)) at += 1;
    else if (arg === '--' && started) {
      at += 1;
      break;
    } else if (!arg.startsWith('-')) {
      if (started) break;
      if (arg === launcher.run) started = true;
      else if (launcher.bins && PROJECT_BINS.has(arg)) break;
      else return undefined;
    }
  }
  const words = args.slice(at);
  if (words.length === 0) return undefined;
  if (launcher.python && /\.py$/.test(words[0]!)) words.unshift('python');
  return { words, redirects: segment.redirects, scripts: segment.scripts };
}
