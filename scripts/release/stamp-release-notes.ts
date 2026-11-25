/**
 * Stamp the agent release notes a release shipped (DOR-5123, design §3, 6.3a).
 *
 * A daily release commit can't edit code, so a note ships as `version: 'next'`
 * and the build reads it as its own version (`BUILT_VERSION` in
 * `agent-release-notes.ts`). The back-merge then runs this on main, so the
 * next release does not read the same note as new again. It stamps only the
 * notes that were `next` at the release point: a note main gained after the
 * cut stays `next` for the release that ships it.
 *
 *   node scripts/release/stamp-release-notes.ts --version 0.142.0 \
 *     --released <the notes file as it was at the release point> \
 *     --file apps/server/src/services/runtimes/shared/awareness/agent-release-notes.ts
 *
 * It reads both files as text and runs nothing from either. `--file` is
 * rewritten in place. Notes are matched by `name`.
 *
 * Exit 0: stamped. Exit 3: nothing to stamp. Exit 1: refused, a file whose
 * notes it can't read exactly. Exit 2: bad arguments or an unreadable file.
 *
 * @module scripts/release/stamp-release-notes
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runIfMain } from '../../packages/cli/scripts/release-branch/entry.ts';
import { ReleaseCommitError } from './errors.ts';

/** The exit code when no note was `next` at the release point. */
export const NOTHING_TO_STAMP_EXIT = 3;

/** One note as written: its name, its version and where the version literal sits. */
interface WrittenNote {
  readonly name: string;
  readonly version: string;
  /** Offset of the version's opening quote in the whole file. */
  readonly versionAt: number;
  /** The version literal, quotes included. */
  readonly literal: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const QUOTED = String.raw`'((?:[^'\\\n]|\\.)*)'`;

/** The index just past the string literal that opens at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  throw new ReleaseCommitError('The release notes file has a string that never closes.');
}

/** The `{ … }` objects directly inside the `AGENT_RELEASE_NOTES` array, with offsets. */
function noteObjects(text: string): { body: string; at: number }[] {
  const head = /export const AGENT_RELEASE_NOTES\b[^=]*=\s*\[/.exec(text);
  if (!head)
    throw new ReleaseCommitError('The release notes file has no AGENT_RELEASE_NOTES array.');
  const objects: { body: string; at: number }[] = [];
  let depth = 0;
  let open = -1;
  for (let i = head.index + head[0].length; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i) - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
      if (i <= 0) break;
    } else if (c === '{' || c === '[') {
      if (depth === 0 && c === '{') open = i;
      depth++;
    } else if (c === '}' || c === ']') {
      if (depth === 0 && c === ']') return objects;
      depth--;
      if (depth === 0 && c === '}') objects.push({ body: text.slice(open, i + 1), at: open });
    }
  }
  throw new ReleaseCommitError('The AGENT_RELEASE_NOTES array never closes.');
}

/** Every note in a release notes file, refusing any it can't read exactly. */
export function readNotes(text: string): WrittenNote[] {
  const seen = new Set<string>();
  return noteObjects(text).map(({ body, at }) => {
    const versions = [...body.matchAll(new RegExp(String.raw`^\s*version:\s*${QUOTED},`, 'gm'))];
    const names = [...body.matchAll(new RegExp(String.raw`^\s*name:\s*${QUOTED},`, 'gm'))];
    if (versions.length !== 1 || names.length !== 1) {
      throw new ReleaseCommitError(
        `A release note must have one single-quoted name and version on their own lines:\n${body}`
      );
    }
    const version = versions[0]!;
    const name = names[0]![1]!;
    if (version[1] !== 'next' && !VERSION.test(version[1]!)) {
      throw new ReleaseCommitError(
        `The note "${name}" has version '${version[1]}', not 'next' or X.Y.Z.`
      );
    }
    if (seen.has(name)) throw new ReleaseCommitError(`Two release notes are named "${name}".`);
    seen.add(name);
    const offset = version[0].indexOf("'");
    return {
      name,
      version: version[1]!,
      versionAt: at + version.index! + offset,
      literal: `'${version[1]}'`,
    };
  });
}

/** What a stamp did: the new text, the notes it stamped and the ones it left. */
export interface StampResult {
  readonly text: string;
  readonly stamped: readonly string[];
  /** `next` at the release point but no longer `next` on main (removed, or already stamped). */
  readonly gone: readonly string[];
}

/**
 * Stamp `version` on every note of `current` that is `next` there and was
 * `next` in `released`, the notes file as the release point had it.
 */
export function stampReleaseNotes(released: string, current: string, version: string): StampResult {
  if (!VERSION.test(version)) throw new ReleaseCommitError(`--version ${version} is not X.Y.Z.`);
  const shipped = new Set(
    readNotes(released)
      .filter((n) => n.version === 'next')
      .map((n) => n.name)
  );
  const notes = readNotes(current);
  const targets = notes.filter((n) => n.version === 'next' && shipped.has(n.name));
  let text = current;
  for (const note of [...targets].sort((a, b) => b.versionAt - a.versionAt)) {
    text = `${text.slice(0, note.versionAt)}'${version}'${text.slice(note.versionAt + note.literal.length)}`;
  }
  const stampedNames = new Set(targets.map((n) => n.name));
  return {
    text,
    stamped: targets.map((n) => n.name),
    gone: [...shipped].filter((name) => !stampedNames.has(name)),
  };
}

/** Run the CLI over `argv`; returns the exit code. */
export function main(argv: readonly string[]): number {
  let values: { version?: string; released?: string; file?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        version: { type: 'string' },
        released: { type: 'string' },
        file: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!values.version || !values.released || !values.file) {
    console.error('--version, --released and --file are all required.');
    return 2;
  }
  let released: string;
  let current: string;
  try {
    released = readFileSync(values.released, 'utf8');
    current = readFileSync(values.file, 'utf8');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const result = stampReleaseNotes(released, current, values.version);
    for (const name of result.gone) console.log(`not stamped, no longer next on main: ${name}`);
    if (result.stamped.length === 0) {
      console.log('No release note to stamp.');
      return NOTHING_TO_STAMP_EXIT;
    }
    writeFileSync(values.file, result.text);
    for (const name of result.stamped) console.log(`stamped ${values.version}: ${name}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof ReleaseCommitError ? 1 : 2;
  }
}

runIfMain(import.meta.url, () => main(process.argv.slice(2)));
