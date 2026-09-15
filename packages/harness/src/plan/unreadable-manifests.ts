/**
 * Unreadable-manifest reporting — say out loud that a package you installed is
 * sitting there unusable.
 *
 * A package's `.dork/manifest.json` is what gives it a name, a type and a layer
 * list, so a manifest that will not parse leaves nothing to project. That was
 * treated as nothing to SAY, too: the scan skipped the package and it then had
 * no trace in the plan, the drop list, the status model or the terminal, at
 * either scope. Somebody who broke a manifest half an hour ago — a hand-edit, a
 * partial write, a merge conflict marker — watched a package they installed stop
 * being mentioned, with no line anywhere connecting the two (DOR-1933).
 *
 * It lives beside the installed-plugin projector for the reason
 * {@link plan/unreadable-hooks} gives: this is a SOURCE-READ loss, gathered
 * before any harness is considered and emitted once per plan.
 *
 * @module plan/unreadable-manifests
 */
import type { HarnessId } from '../manifest/schema.js';
import type { UnreadablePackageManifest } from '../sources/installed.js';
import type { ProjectionWarning } from './types.js';

/**
 * The harness an unreadable-manifest warning is attributed to.
 *
 * A PLACEHOLDER, and it carries `harnessAgnostic` beside it for the same reason
 * the unreadable-hook attribution does: the loss happened at read time, ahead of
 * every harness, so it reaches none of them and no `--harness <id>` filter may
 * hide it. `HarnessId` has no member meaning "none of them", so the field is
 * filled and the flag says what it means.
 */
const UNREADABLE_MANIFEST_ATTRIBUTION: HarnessId = 'claude-code';

/**
 * The one sentence a person reads about a package DorkOS could not make sense
 * of.
 *
 * Two claims, and both are load-bearing: which file, and what DorkOS did about
 * it. The second one is the half a bare "could not read this file" would leave
 * somebody to work out — the sweep deliberately keeps every link such a package
 * already has (clause 4 of the global predicate), so the tree they are looking
 * at is not tidied and that is on purpose.
 *
 * **It does not name the package, because every surface that prints it already
 * has.** The warning carries the package as its `name`, which the terminal
 * renders as `- plugin "<name>": <reason>` and the Skills page draws above the
 * sentence — so saying it again read as `plugin "badmanifest": badmanifest has a
 * file …`, measured on the built CLI.
 *
 * @param record - the package and the file that would not parse.
 * @returns the sentence, the same words in the terminal and on the screen.
 */
function unreadableManifestReason(record: UnreadablePackageManifest): string {
  return (
    `This package has a file DorkOS could not read: ${record.path}. ` +
    `Nothing from it is shared until that file is fixed, and the links it already has ` +
    `were left exactly as they are.`
  );
}

/**
 * Warn about every package whose manifest would not parse.
 *
 * A warning rather than a drop, deliberately, and on the same rule
 * `planUnreadableHookWarnings` follows: `plan.drops` reports a whole artifact
 * that has no home in a target harness, while this is a source file the engine
 * could not read at all. One warning per package, never one per enabled
 * harness.
 *
 * @param records - every unreadable manifest one scan found, at either scope.
 * @returns one warning per record, empty when every manifest parsed.
 */
export function planUnreadableManifestWarnings(
  records: readonly UnreadablePackageManifest[]
): ProjectionWarning[] {
  return records.map((record) => ({
    artifact: 'plugin' as const,
    harness: UNREADABLE_MANIFEST_ATTRIBUTION,
    harnessAgnostic: true,
    name: record.package,
    // The file, so the completeness check can match this warning to the source
    // it is about, and so the report has a path to print.
    source: record.path,
    reason: unreadableManifestReason(record),
  }));
}
