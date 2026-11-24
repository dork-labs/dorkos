/**
 * The one error the release commit throws when it refuses: the input is not
 * releasable as it stands (no fragments, a version that does not move forward,
 * a file in a shape the edits cannot change exactly). The CLI exits 1 on it and
 * 2 on anything else, so a workflow can tell "nothing to ship today" from a
 * broken tool.
 *
 * @module scripts/release/errors
 */

/** A refusal: the release point cannot be released as it stands. */
export class ReleaseCommitError extends Error {
  /** Create a refusal with a sentence a person can act on. */
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseCommitError';
  }
}
