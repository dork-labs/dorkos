/**
 * Where the quarantine list is READ FROM and WRITTEN TO: the data branch.
 *
 * Split from the commands so that "how the list travels" is one file. Every
 * read here goes through `readQuarantine`'s guards except `rawEntries`, which
 * exists only to repair a list those guards have refused — see its own note.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Env } from './commands.ts';
import { prepareDataDir, publish, removeDataDir } from './data-branch.ts';
import {
  emptyQuarantine,
  QuarantineSchema,
  readQuarantine,
  type QuarantineEntry,
  type QuarantineRead,
} from './quarantine.ts';

/**
 * Read `quarantine.json` straight off the remote data branch, shallowly.
 *
 * No worktree and no full fetch: one `--depth=1` fetch of the branch and one
 * `git show`, which is all a queue job can afford and all it needs.
 *
 * @param env - The environment.
 * @param opts - `offline` reads whatever the local ref already has.
 * @returns The file's text, or `null` with the reason it could not be read.
 */
export function fetchQuarantineText(
  env: Env,
  opts: { offline?: boolean } = {}
): { text: string | null; problem?: string } {
  const branch = env.files.config.data_branch;
  const file = env.files.config.quarantine.file;
  const refs = [`refs/remotes/origin/${branch}`, 'FETCH_HEAD'];
  if (!opts.offline) {
    try {
      env.git(env.root, [
        'fetch',
        '--quiet',
        '--depth=1',
        'origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
    } catch (e) {
      return {
        text: null,
        problem: `could not fetch ${branch} (${e instanceof Error ? e.message.split('\n')[0] : String(e)}).`,
      };
    }
  }
  for (const ref of refs) {
    try {
      return { text: env.git(env.root, ['show', `${ref}:${file}`]) };
    } catch {
      continue;
    }
  }
  return { text: null, problem: `${branch} has no ${file}.` };
}

/** Read the list from wherever this invocation says, applying every guard. */
export function loadList(
  env: Env,
  opts: { file?: string; offline?: boolean }
): QuarantineRead & { raw: string | null } {
  const cfg = env.files.config.quarantine;
  if (opts.file) {
    // A named list that is not there is a broken step, not an empty lane. The
    // workflow's `quarantine-list --out` always writes the file (it writes an
    // empty list on any problem), so ABSENT means that step never ran, and
    // reading it as "nothing is quarantined" would quietly turn a wiring bug
    // into a gate that excuses nothing and says nothing.
    if (!existsSync(opts.file)) {
      throw new Error(
        `no quarantine list at ${opts.file}. \`ci-steward quarantine-list --out\` always writes one, even when nothing is quarantined, so a missing file means that step did not run. This gate will not guess which it was.`
      );
    }
    const text = readFileSync(opts.file, 'utf8');
    return { ...readQuarantine(text, cfg, env.now), raw: text };
  }
  const got = fetchQuarantineText(env, opts);
  const read = readQuarantine(got.text, cfg, env.now);
  if (got.problem) read.notes.unshift(`${got.problem} Nothing is quarantined.`);
  return { ...read, raw: got.text };
}

/**
 * The entries the file literally holds, with no read-time guard applied.
 *
 * Only `remove` uses this, and only to repair: a list refused for one bad entry
 * still parses, and the entry has to come out somehow. Returns `null` when the
 * file is not even parseable, which is what `reset` is for.
 *
 * @param env - The environment.
 * @param opts - Where to read the list from.
 */
export function rawEntries(
  env: Env,
  opts: { listFile?: string; offline?: boolean }
): QuarantineEntry[] | null {
  let text: string | null;
  try {
    text = opts.listFile
      ? existsSync(opts.listFile)
        ? readFileSync(opts.listFile, 'utf8')
        : null
      : fetchQuarantineText(env, opts).text;
  } catch {
    return null;
  }
  if (text === null) return [];
  try {
    const parsed = QuarantineSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.entries : null;
  } catch {
    return null;
  }
}

/**
 * Write the list back to the data branch, or, without `--publish`, print
 * exactly what would be written and change nothing.
 */
export function publishList(
  env: Env,
  entries: readonly QuarantineEntry[],
  message: string,
  doPublish: boolean
): number {
  const file = env.files.config.quarantine.file;
  const next: unknown = {
    ...emptyQuarantine(env.now),
    entries,
  };
  const parsed = QuarantineSchema.safeParse(next);
  if (!parsed.success) {
    env.io.err(
      `quarantine: refusing to write a list that does not validate (${parsed.error.issues.map((i) => i.message).join('; ')}).\n`
    );
    return 1;
  }
  const text = `${JSON.stringify(parsed.data, null, 1)}\n`;
  if (!doPublish) {
    env.io.out(
      `\n${text}\nquarantine: nothing was published (dry run). Re-run with --publish to write ${file} on the ${env.files.config.data_branch} branch; it takes effect on the next queue build.\n`
    );
    return 0;
  }
  const r = {
    repo: env.root,
    remote: 'origin',
    branch: env.files.config.data_branch,
    tagPrefix: env.files.config.data_tag_prefix,
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-steward-quarantine-'));
  rmSync(dir, { recursive: true, force: true });
  try {
    prepareDataDir(env.git, r, dir);
    writeFileSync(path.join(dir, file), text);
    const sha = publish(env.git, r, dir, message);
    env.io.out(
      sha === 'nothing'
        ? 'quarantine: already up to date.\n'
        : `quarantine: pushed ${sha.slice(0, 12)} to ${r.branch}; it takes effect on the next queue build.\n`
    );
    return 0;
  } finally {
    removeDataDir(env.git, r, dir);
  }
}
