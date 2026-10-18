/**
 * Where the space server lives, read from `ci/space-server.env` (DOR-3007).
 *
 * That file is the one source of truth for the space server's folder: the
 * workflows append it to `$GITHUB_ENV`, the bash scripts `source` it, and the
 * TypeScript readers (the vocabulary gate, the one-shot-route gate, the
 * two-desktop journey and their tests) come through here. Plain JavaScript, like
 * `code-only.mjs` beside it, so a script under tsx and a package under a bundler
 * import the same reader.
 *
 * @module scripts/lib/space-server
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root this module sits in. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The keys the file must define, each a repository-relative folder. */
const KEYS = ['SPACE_DIR', 'SPACE_SRC_DIR', 'SPACE_WEB_DIR'];

/**
 * A KEY=value line, starting in the first column, with a key the workflows' grep
 * (`^SPACE_[A-Z_]*=.`) would keep. Anything else that is not a comment or blank
 * is refused, so a line bash would read but the workflows would drop (an
 * indented assignment, an `export`, a key outside that pattern) never reaches
 * only some of the readers.
 */
const LINE = /^(SPACE_[A-Z_]*)=(.*)$/;

/**
 * Parse the text of a `space-server.env` file.
 *
 * Refuses a line it cannot read, a missing or empty key, and a value that is
 * absolute, has a trailing slash, quotes, spaces or a `..` segment: each would
 * read differently in bash, in `$GITHUB_ENV` and here.
 *
 * @param {string} text - The file's contents.
 * @param {string} [source] - What to call the file in an error.
 * @returns {{ spaceDir: string, spaceSrcDir: string, spaceWebDir: string }}
 */
export function parseSpaceServerEnv(text, source = 'ci/space-server.env') {
  /** @type {Record<string, string>} */
  const values = {};
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) {
      throw new Error(
        `${source}:${index + 1}: not a SPACE_*=value line starting in the first column: ${line}`
      );
    }
    values[match[1]] = match[2];
  }
  for (const key of KEYS) {
    const value = values[key];
    if (!value) throw new Error(`${source}: ${key} is missing or empty`);
    if (
      value.startsWith('/') ||
      value.endsWith('/') ||
      /["'\s\\$]/.test(value) ||
      value.split('/').includes('..')
    ) {
      throw new Error(`${source}: ${key}=${value} is not a plain repository-relative folder`);
    }
  }
  return {
    spaceDir: values.SPACE_DIR,
    spaceSrcDir: values.SPACE_SRC_DIR,
    spaceWebDir: values.SPACE_WEB_DIR,
  };
}

/**
 * Read `ci/space-server.env` from a repository.
 *
 * @param {string} [repoRoot] - The repository to read it from; defaults to this one.
 * @returns {{ spaceDir: string, spaceSrcDir: string, spaceWebDir: string }}
 */
export function readSpaceServer(repoRoot = REPO_ROOT) {
  const path = join(repoRoot, 'ci/space-server.env');
  return parseSpaceServerEnv(readFileSync(path, 'utf8'), path);
}
