/**
 * Types for `space-server.mjs`, which reads `ci/space-server.env`: where the
 * space server lives in this repository. See that file for why.
 *
 * @module scripts/lib/space-server
 */

/** The space server's folders, each relative to the repository root. */
export interface SpaceServer {
  /** The space server's folder: package, Dockerfile, migrations, acceptance proof, built server. */
  spaceDir: string;
  /** Its source code. */
  spaceSrcDir: string;
  /** Its web pages. */
  spaceWebDir: string;
}

/**
 * Parse the text of a `space-server.env` file, refusing anything that would
 * read differently in bash, `$GITHUB_ENV` and here.
 *
 * @param text - The file's contents.
 * @param source - What to call the file in an error.
 */
export function parseSpaceServerEnv(text: string, source?: string): SpaceServer;

/**
 * Read `ci/space-server.env` from a repository.
 *
 * @param repoRoot - The repository to read it from; defaults to this one.
 */
export function readSpaceServer(repoRoot?: string): SpaceServer;
