/**
 * Which status a spec's artifact files mean — the one list both
 * `spec-manifest-ops.ts` and the `spec-status-sync.sh` hook read (DOR-2704).
 *
 * The hook used to map any `04-*` or `05-*` file to `implemented`, so writing
 * `04-acceptance.md` or `05-live-checklist.md` promoted a spec that was not
 * built. Keeping the names here means the two can never disagree again.
 *
 * Run directly to print the status a spec folder's files mean (nothing when
 * no known artifact is there):
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     .claude/scripts/spec-artifact-status.ts specs/<slug>
 */
import { existsSync, readdirSync } from 'node:fs';

/** The status each numbered stage means once one of its known artifacts exists. */
export const ARTIFACT_TO_STATUS: Record<number, string> = {
  1: 'ideation',
  2: 'specified',
  3: 'specified',
  4: 'implemented',
  5: 'implemented',
};

// Fails closed: an artifact file only counts toward status if its exact name
// is a KNOWN one for that numbered stage. Only naming what promotes, rather
// than naming what to skip, means a future file this list has never seen
// (the visual-companion skill's `04-design-decisions.md` was exactly that
// case, DOR-818; `04-acceptance.md` and `05-live-checklist.md` were the next,
// DOR-2704) does not silently promote a spec's status — an unrecognized
// `0N-*` name is a no-op here, not a guess. Sourced from every `0[1-5]-*.md`
// / `.json` name actually in use under specs/ at the time of writing:
// 01-ideation.md; 02-spec.md and 02-specification.md (both seen); 03-tasks.md
// and 03-tasks.json; 04-implementation.md; 05-bootstrap.md and
// 05-feedback.md (post-implementation runbooks/feedback, both still
// 'implemented' per ARTIFACT_TO_STATUS[5]).
const STATUS_BEARING_ARTIFACTS = new Set([
  '01-ideation.md',
  '02-spec.md',
  '02-specification.md',
  '03-tasks.md',
  '03-tasks.json',
  '04-implementation.md',
  '05-bootstrap.md',
  '05-feedback.md',
]);

/**
 * The highest numbered stage with a known artifact in a spec folder, or 0.
 *
 * @param dir - The spec folder.
 */
export function highestArtifact(dir: string): number {
  if (!existsSync(dir)) return 0;
  let highest = 0;
  for (const file of readdirSync(dir)) {
    if (!STATUS_BEARING_ARTIFACTS.has(file)) continue;
    const match = file.match(/^0([1-5])-.*\.(md|json)$/);
    if (match) highest = Math.max(highest, parseInt(match[1], 10));
  }
  return highest;
}

if (import.meta.filename === process.argv[1] && process.argv[2]) {
  const status = ARTIFACT_TO_STATUS[highestArtifact(process.argv[2])];
  if (status) process.stdout.write(status + '\n');
}
