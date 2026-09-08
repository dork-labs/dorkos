/**
 * `--allow-hooks <package>` — recording a person's yes to an installed package's
 * hook commands, and the two things that must be true before it is written down.
 *
 * It lives apart from `harness-sync-command.ts` because it is the only place the
 * sync command WRITES a decision rather than a projection, and the ordering of
 * its guards is the whole safety of it. Both refusals happen before anything
 * opens the config store:
 *
 * 1. an unreadable `config.json` — `initConfigManager` would run `conf`'s
 *    corrupt-recovery on it, replacing every setting with defaults, so being
 *    told to run the command that wipes your settings is worse than the withheld
 *    hook;
 * 2. a `hookPolicies` entry that suppresses every harness those hooks could
 *    reach — the yes is durable and outlives the manifest, so one taken here
 *    would install itself unprompted the day that line goes (DOR-1858 review).
 *
 * @module harness-sync-allow-hooks
 */
import {
  HARNESS_LABELS,
  HARNESS_MANIFEST_PATH,
  pluginHookReach,
  type HarnessManifest,
} from '@dorkos/harness';

import { configPathFor, readStoredDecisions } from './harness-consent.js';
import type { HookProjectionRequest } from '../server/services/harness/hook-consent.js';

/** The stored hook decisions, as `readStoredDecisions` returns them. */
type HookDecisions = Awaited<ReturnType<typeof readStoredDecisions>>;

/**
 * Resolve `--allow-hooks`, recording each named package's hooks as approved.
 *
 * @param opts - the repo root, resolved dork home, the manifest in force, the
 *   package names asked for, the decisions read so far, and the seam that lists
 *   which installed packages declare hooks.
 * @returns the decisions to project with, or an exit code when nothing was
 *   recorded and the run should stop.
 */
export async function resolveAllowHooks(opts: {
  repoRoot: string;
  dorkHome: string;
  manifest: HarnessManifest;
  allowHooks: readonly string[];
  decisions: HookDecisions;
  scanHookRequests: (repoRoot: string, dorkHome: string) => HookProjectionRequest[];
}): Promise<{ decisions: HookDecisions } | { exitCode: number }> {
  const { repoRoot, dorkHome, manifest, allowHooks } = opts;
  let decisions = opts.decisions;

  // Refused before anything opens the store, and that ordering is the whole
  // safety of it: `initConfigManager` on an unreadable `config.json` runs
  // `conf`'s corrupt-recovery, which backs the file up and replaces it with
  // defaults — every setting, not just these two lists. Being told to run
  // the command that wipes your settings is worse than the withheld hook.
  if (decisions.unreadable !== undefined) {
    console.error(`DorkOS could not read ${configPathFor(dorkHome)}: ${decisions.unreadable}`);
    console.error(
      '  Fix the file first. Allowing hooks writes to it, and DorkOS will not write over a file it cannot read.'
    );
    return { exitCode: 1 };
  }
  const requests = opts.scanHookRequests(repoRoot, dorkHome);
  const unknown = allowHooks.filter(
    (name) => !requests.some((request) => request.packageName === name)
  );
  if (unknown.length > 0) {
    // Nothing is written when any name is wrong: a typo must not half-record
    // a decision and leave the person to work out which half landed.
    console.error(
      `No installed package here declares hooks under ${unknown.map((n) => `'${n}'`).join(', ')}.`
    );
    console.error(
      requests.length > 0
        ? `  Packages with hooks in this project: ${requests.map((r) => r.packageName).join(', ')}`
        : '  No installed package in this project declares any hooks.'
    );
    return { exitCode: 1 };
  }

  // A yes recorded here is DURABLE and outlives the manifest that was in force
  // when it was given, so it must not be recorded when nothing in this project
  // can receive those hooks. The condition is `reached.length === 0` and nothing
  // narrower: whether a `hookPolicies` line is to blame changes only the
  // SENTENCE, never the answer. Both routes end the same way — the person is
  // told "Allowed acme" over an `Applied 0`, gets no `settings.local.json`, and
  // then has the hooks install themselves unprompted the day the manifest
  // changes (both reproduced in review).
  const reach = pluginHookReach(manifest);
  if (reach.reached.length === 0) {
    console.error('DorkOS did not record that: those hooks have nowhere to go here.');
    if (reach.suppressed.length > 0) {
      // A manifest line is to blame, so name it — that is the thing to edit.
      for (const { harness, projection } of reach.suppressed) {
        console.error(
          `  ${HARNESS_MANIFEST_PATH} says hookPolicies ${projection} for ${harness}, so DorkOS installs nothing for ${HARNESS_LABELS[harness]}.`
        );
      }
      console.error(
        '  Saying yes now would install them the day that line goes, without asking again.'
      );
      console.error('  Remove the line, then run this again.');
    } else {
      // No line to blame: every agent this project runs simply has no place
      // DorkOS writes hooks to. Pointing at the manifest here would send
      // somebody hunting for a policy that is not there.
      console.error(
        `  None of the agents this project uses (${manifest.harnesses
          .map((h) => HARNESS_LABELS[h])
          .join(', ')}) has a place DorkOS writes hooks to.`
      );
      console.error(
        '  Saying yes now would install them the day you turn on one that does, without asking again.'
      );
      console.error('  Turn on an agent that can take them, then run this again.');
    }
    return { exitCode: 1 };
  }

  const { initConfigManager } = await import('../server/services/core/config-manager.js');
  const { recordHookApproval } = await import('../server/services/harness/hook-consent.js');
  initConfigManager(dorkHome);
  for (const request of requests) {
    if (allowHooks.includes(request.packageName)) recordHookApproval(request);
  }
  decisions = await readStoredDecisions(dorkHome);
  console.log(
    `Allowed ${allowHooks.length} package${allowHooks.length === 1 ? '' : 's'} to install hooks here: ${allowHooks.join(', ')}`
  );
  console.log(
    `  Recorded in ${configPathFor(dorkHome)} — undo with \`dorkos harness hooks --revoke <package>\`.`
  );
  // Some targets, but not all. The yes is real and worth recording — it is
  // just narrower than the sentence above reads on its own.
  if (reach.suppressed.length > 0) {
    console.log(
      `  Not every agent gets them: your manifest's hookPolicies stops ${reach.suppressed
        .map(({ harness }) => HARNESS_LABELS[harness])
        .join(', ')}. They reach ${reach.reached.map((h) => HARNESS_LABELS[h]).join(', ')}.`
    );
  }
  console.log('');

  return { decisions };
}
