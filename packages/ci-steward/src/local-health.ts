/** The health block's view of the local exports under `local/<clone>/`. */
import { localExportDays, type Health } from './data.ts';
import type { HandFiles } from './load.ts';

/**
 * Local-export ages for the health block.
 *
 * A stale clone is a failure only while no clone exports fresh. A clone's name
 * digests the machine's hostname (`defaultCloneName`), and macOS renames
 * itself per network (`x.local`, `x.lan`, `mac.lan`), so one machine with one
 * checkout leaves a trail of names that stop exporting the day it moves. Those
 * are warnings while another name exports fresh. With no fresh clone at all
 * the export really stopped: that stays a failure, even once every clone has
 * aged into `retired`.
 *
 * @param dataDir - The data branch working tree.
 * @param files - The hand files.
 * @param today - The current UTC day.
 */
export function localExportHealth(
  dataDir: string,
  files: HandFiles,
  today: string
): { exports: Health['local_exports']; failures: string[]; warnings: string[] } {
  const { stale_after_days: stale, retired_after_days: retired } = files.config.local;
  const exports: Health['local_exports'] = {};
  for (const [clone, last] of Object.entries(localExportDays(dataDir))) {
    const age = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000
    );
    const state = age > retired ? 'retired' : age > stale ? 'stale' : 'fresh';
    exports[clone] = { last, age_days: age, state };
  }
  const entries = Object.entries(exports);
  const fresh = entries.filter(([, e]) => e.state === 'fresh').map(([c]) => c);
  const staleOnes = entries.filter(([, e]) => e.state === 'stale');
  const failures: string[] = [];
  const warnings: string[] = [];
  const fix = `Approve or re-run the ci-local-export scheduled skill on that machine (Schedules page, Full autonomy).`;
  if (fresh.length) {
    for (const [clone, e] of staleOnes)
      warnings.push(
        `The local export from clone ${clone} is ${e.age_days} days old (last ${e.last}), but ${fresh.join(', ')} exported fresh; most likely the same machine under a new hostname. It retires after ${retired} days.`
      );
  } else if (staleOnes.length) {
    for (const [clone, e] of staleOnes)
      failures.push(
        `The local export from clone ${clone} is ${e.age_days} days old (last ${e.last}) and no clone exported in the last ${stale} days; local-commit and local-push are going stale. ${fix}`
      );
  } else if (entries.length) {
    const [clone, e] = entries.sort(([, a], [, b]) => a.age_days - b.age_days)[0]!;
    failures.push(
      `No clone has exported in ${e.age_days} days (newest ${clone}, last ${e.last}); local-commit and local-push are stale. ${fix}`
    );
  }
  return { exports, failures, warnings };
}
