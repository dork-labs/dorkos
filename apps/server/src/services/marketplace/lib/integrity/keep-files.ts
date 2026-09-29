/**
 * "Keep these as mine" (DOR-2341), end to end: make the files an update kept
 * but nothing could sort the person's, and, for a global package held back
 * from sessions, record the approval the person was shown, the same as a
 * Review.
 *
 * Ownership and activation are two decisions. Keeping the files changes only
 * the installed-files record (`keep-unproven.ts`). For a global package held
 * back from sessions, it also approves what the package discloses now, like a
 * Review: only when the caller sends back exactly what `GET /held-back`
 * listed, only when the package still is that (`recordHeldBackDecision`), and
 * under the same install lock as the keep. Otherwise the files are still kept,
 * the package still waits for a Review, and the answer says so.
 *
 * The caller is a person: the route refuses anyone else before this runs.
 *
 * @module services/marketplace/lib/integrity/keep-files
 */
import path from 'node:path';
import type { DisclosedEffects, KeepFilesResult } from '@dorkos/shared/marketplace-schemas';
import {
  partitionGlobalPlugins,
  recordHeldBackDecision,
} from '../../consent/global-plugin-consent.js';
import { keepUnprovenFiles } from './keep-unproven.js';

/** The key the person was shown no longer matches: nothing was written. */
export class KeptFilesChangedError extends Error {
  /**
   * Build the error.
   *
   * @param name - The package name.
   */
  constructor(name: string) {
    super(
      `The files ${name} kept changed since you looked, so nothing was changed. Look at them again.`
    );
    this.name = 'KeptFilesChangedError';
  }
}

/** One sentence for what was kept, and where a global package stands. */
function describeKept(
  name: string,
  count: number,
  global: { approved: boolean; stillHeldBack: boolean } | undefined
): string {
  const files = count === 1 ? `The file ${name} kept is` : `The ${count} files ${name} kept are`;
  const base = `${files} yours now. Nothing was moved or deleted.`;
  if (global?.approved) return `${base} ${name} loads into sessions from the next message on.`;
  if (global?.stillHeldBack) {
    return `${base} ${name} still waits for your Review before it runs in sessions.`;
  }
  return base;
}

/**
 * Keep the files an update kept unsorted as the person's, and approve a held-
 * back global package when the person was shown what it runs.
 *
 * @param opts.dorkHome - The resolved DorkOS data directory.
 * @param opts.root - The install folder.
 * @param opts.name - The package name, for the answer.
 * @param opts.global - Whether this is a global install.
 * @param opts.keepKey - The key the person was shown.
 * @param opts.review - What `GET /held-back` listed, when the person saw it.
 * @returns What was done, in one sentence.
 * @throws {KeptFilesChangedError} When the kept files, or the installed
 *   version, differ from what the key covers.
 */
export async function keepPackageFiles(opts: {
  dorkHome: string;
  root: string;
  name: string;
  global: boolean;
  keepKey: string;
  review?: { effects: DisclosedEffects; bindsTo: string };
}): Promise<KeepFilesResult> {
  const dirName = path.basename(opts.root);
  let approved = false;
  // Under the same install lock as the keep, so an update landing between the
  // two cannot be approved on what the person was shown of the old install.
  const review = opts.global ? opts.review : undefined;
  const kept = await keepUnprovenFiles(
    opts.root,
    opts.keepKey,
    review
      ? async () => {
          approved = await recordHeldBackDecision(opts.dorkHome, dirName, review, 'allow');
        }
      : undefined
  );
  if (kept.outcome === 'changed') throw new KeptFilesChangedError(opts.name);
  if (kept.outcome === 'not-needed') {
    return {
      outcome: 'not-needed',
      message: `${opts.name} has no kept files to sort any more.`,
    };
  }
  if (!opts.global) {
    return {
      outcome: 'kept',
      files: kept.files,
      message: describeKept(opts.name, kept.files.length, undefined),
    };
  }
  const stillHeldBack =
    !approved &&
    (await partitionGlobalPlugins(opts.dorkHome)).withheld.some((w) => w.name === dirName);
  return {
    outcome: 'kept',
    files: kept.files,
    ...((approved || stillHeldBack) && { approved }),
    message: describeKept(opts.name, kept.files.length, { approved, stillHeldBack }),
  };
}
