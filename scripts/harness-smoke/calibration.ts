/**
 * The calibration diff — `harnessCoverage()` against the binary's own listing,
 * on the same tree.
 *
 * Kept apart from `./oracles.ts` because it is the one verdict that reads the
 * ENGINE rather than the harness: every other oracle asks the binary a question
 * and reads its answer, while this one asks both sides the same question and
 * reports where they disagree. It is also the half that pays off on every run
 * whatever the listing says — the vendor-facts table is compiled from
 * documentation, and this is the only thing in the repository that ever compares
 * it to a binary.
 *
 * A disagreement is a `finding`, never a failure. That is the point of the tier
 * (`plans/harness-sync-test-plan.md` §11 line 13: "not a CI red; a report"), and
 * DOR-1856's first free run produced none — which is itself the positive control
 * that the two models agree on a tree they both walked.
 *
 * @module harness-smoke/calibration
 */
import { isAbsolute, relative } from 'node:path';
import { harnessCoverage } from '../../packages/harness/dist/vendor-facts/coverage.js';
import type { ListingObservation, SmokeHarness } from './harnesses.js';
import type { Verdict } from './oracles.js';

/** One disagreement between the engine's coverage walk and the binary's own listing. */
export interface CalibrationFinding {
  /** Which side claimed it. */
  side: 'coverage-only' | 'listing-only';
  /** The skill key in dispute. */
  key: string;
  /** Where it was seen. */
  where: string;
}

/**
 * The calibration diff — `harnessCoverage()` against the binary's own listing,
 * on the same tree.
 *
 * This is the half of the H tier that pays off every time it runs, whatever the
 * listing says: the vendor-facts table is compiled from documentation, and this
 * is the only thing that ever compares it to a binary.
 *
 * The direction is per harness, and honestly so. Codex reports an absolute path
 * beside every entry, so the listing can be scoped to the fixture and BOTH
 * directions checked. Claude Code reports names only and mixes its own built-in
 * skills into the same array, so only "everything the walk discovered is listed"
 * is checkable — the other direction would report every built-in as a finding.
 *
 * @param harness - the harness being asked.
 * @param repoRoot - the fixture root.
 * @param observed - the listing, or `undefined` when the harness has no surface.
 * @returns the verdict and every disagreement behind it.
 */
export function calibrationVerdict(
  harness: SmokeHarness,
  repoRoot: string,
  observed: ListingObservation | undefined
): { verdict: Verdict; findings: CalibrationFinding[] } {
  const question = `Does \`harnessCoverage('${harness.harnessId}')\` agree with what ${harness.label} listed?`;
  if (!observed) {
    return {
      verdict: {
        id: 'calibration',
        capabilities: ['SK-13', 'SK-14'],
        question,
        status: 'unknown',
        detail: `No listing surface to compare against. ${harness.listing.note}`,
      },
      findings: [],
    };
  }

  const walk = harnessCoverage(harness.harnessId, repoRoot);
  const listedNames = new Set(observed.skills);
  const findings: CalibrationFinding[] = [];

  for (const found of walk.discovered) {
    if (!listedNames.has(found.key)) {
      findings.push({
        side: 'coverage-only',
        key: found.key,
        where: relative(repoRoot, found.skillMd),
      });
    }
  }

  if (harness.calibration === 'both') {
    const walkKeys = new Set(walk.discovered.map((found) => found.key));
    for (const [index, name] of observed.skills.entries()) {
      const path = observed.skillPaths[index];
      // Only entries the fixture owns can disagree with a walk of the fixture.
      if (path === undefined || !insideFixture(path, repoRoot)) continue;
      if (!walkKeys.has(name)) {
        findings.push({ side: 'listing-only', key: name, where: relative(repoRoot, path) });
      }
    }
  }

  return {
    verdict: {
      id: 'calibration',
      capabilities: ['SK-13', 'SK-14'],
      question,
      status: findings.length === 0 ? 'pass' : 'finding',
      detail:
        findings.length === 0
          ? `${walk.discovered.length} skills discovered by the walk, all of them listed` +
            `${harness.calibration === 'both' ? ', and every fixture entry the listing carried was discovered' : ''}.` +
            `${walk.uncertain.length > 0 ? ` The walk also reported ${walk.uncertain.length} undecidable, which is data for the facts table, not a failure.` : ''}`
          : `${findings.length} disagreement(s) between the compiled vendor facts and the binary. ` +
            `That is the finding this tier exists to produce; it does not fail the run.`,
    },
    findings,
  };
}

/** Whether a path a harness reported lives inside the fixture. */
function insideFixture(path: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
