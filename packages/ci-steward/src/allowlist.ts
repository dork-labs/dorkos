/**
 * Applies `ci/census-allowlist.yaml` to the census's findings.
 *
 * An entry excuses exactly one site (workflow, job, optional step, kind). It
 * stops excusing anything on its `expires` date, and an expired entry is a
 * finding of its own, so an exception that was meant to be temporary cannot
 * quietly become permanent. An entry that excuses nothing is stale and fails
 * too, so the file only ever lists exceptions that are still needed.
 */
import type { Finding } from './finding.ts';
import type { AllowlistEntry } from './schemas.ts';

/** A place the census may want to excuse. */
interface AllowlistSite {
  workflow: string;
  job: string;
  step?: string;
  kind: AllowlistEntry['kind'];
}

/** Tracks which entries were used, so the leftovers can be reported. */
export interface AllowlistTracker {
  /** True when a live (unexpired) entry excuses the site; marks the entry used. */
  covers(site: AllowlistSite): boolean;
  /** Findings for expired entries and for live entries that excused nothing. */
  leftovers(): Finding[];
}

/**
 * True when the entry has expired at `now` (from 00:00 UTC on its `expires` date).
 *
 * @param entry - The allowlist entry.
 * @param now - The clock.
 */
function isExpired(entry: AllowlistEntry, now: Date): boolean {
  return entry.expires !== undefined && now.getTime() >= Date.parse(`${entry.expires}T00:00:00Z`);
}

function describe(e: AllowlistEntry): string {
  return `${e.workflow} › ${e.job}${e.step ? ` › ${e.step}` : ''} (${e.kind})`;
}

/**
 * Build a tracker over the allowlist.
 *
 * @param entries - The parsed entries.
 * @param now - The clock that decides expiry.
 * @param allowlistPath - Repo-relative path, for findings.
 */
export function trackAllowlist(
  entries: readonly AllowlistEntry[],
  now: Date,
  allowlistPath: string
): AllowlistTracker {
  const used = new Set<number>();
  return {
    covers(site) {
      const i = entries.findIndex(
        (e) =>
          e.workflow === site.workflow &&
          e.job === site.job &&
          e.kind === site.kind &&
          (e.step ?? null) === (site.step ?? null)
      );
      if (i === -1) return false;
      used.add(i);
      return !isExpired(entries[i]!, now);
    },
    leftovers() {
      const out: Finding[] = [];
      entries.forEach((e, i) => {
        if (isExpired(e, now)) {
          out.push({
            code: 'allowlist/expired',
            file: allowlistPath,
            where: describe(e),
            message: `This exception expired on ${e.expires} and no longer excuses anything. Its reason was: "${e.reason}"`,
            fix: `Remove the underlying ${e.kind} from .github/workflows/${e.workflow} and delete this entry (the expiry is the planned flip), or, if it must stay, renew it with a new reason and date in a PR that carries a ci/ledger entry.`,
          });
        } else if (!used.has(i)) {
          out.push({
            code: 'allowlist/stale',
            file: allowlistPath,
            where: describe(e),
            message:
              'This exception excuses nothing: no job or step in the workflows matches it any more.',
            fix: 'Delete the entry. If the step was renamed, update `step:` to its new name (or id).',
          });
        }
      });
      return out;
    },
  };
}
