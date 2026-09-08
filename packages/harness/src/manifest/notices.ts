/**
 * What is wrong with the manifest itself — the lines `dorkos harness sync`
 * prints about `.agents/harness.manifest.json` rather than about a projection.
 *
 * Two things land here, and they are the same kind of thing: a statement in the
 * manifest that reaches nothing. A key the engine retired (DOR-1858) and a
 * `hookPolicies` entry naming a harness this manifest does not enable both look
 * like configuration and do nothing at all. The manifest is hand-authored and
 * per-repo, so nothing migrates it — the line IS the migration notice, and it
 * names exactly what to delete.
 *
 * These never change an exit code. Nothing is missing, nothing is stale on disk,
 * and a failing command a person cannot clear is how they learn to stop reading
 * the output.
 *
 * @module manifest/notices
 */
import {
  HARNESS_IDS,
  RETIRED_MANIFEST_KEYS,
  type HarnessId,
  type HarnessManifest,
} from './schema.js';
import { HARNESS_MANIFEST_PATH } from '../scaffold/manifest.js';

/**
 * Every line to print about a repo's manifest, in the order a person would fix
 * them: the retired keys first, then the hook policies that reach nothing.
 *
 * @param manifest - the validated manifest, as `loadManifest` returns it.
 * @returns one plain sentence per problem, or an empty array for a clean manifest.
 */
export function manifestNotices(manifest: HarnessManifest): string[] {
  const lines: string[] = [];

  // A retired key is present iff the parsed manifest carries it: the schema
  // types them `unknown`, and Zod leaves an absent optional key off the object
  // entirely, so there is no value a JSON file could hold that reads as absent.
  for (const key of RETIRED_MANIFEST_KEYS) {
    if (manifest[key] !== undefined) {
      lines.push(`${key} in ${HARNESS_MANIFEST_PATH} is no longer read — remove it`);
    }
  }

  const enabled = new Set<string>(manifest.harnesses);
  for (const policy of manifest.hookPolicies) {
    if (enabled.has(policy.tool)) continue;
    lines.push(
      isHarnessId(policy.tool)
        ? `hookPolicies in ${HARNESS_MANIFEST_PATH} names ${policy.tool}, which this manifest does not enable`
        : `hookPolicies in ${HARNESS_MANIFEST_PATH} names ${policy.tool}, which is not an agent DorkOS knows — the ones it knows are ${HARNESS_IDS.join(', ')}`
    );
  }

  return lines;
}

/** Whether a manifest's `hookPolicies[].tool` string is a harness at all. */
function isHarnessId(tool: string): tool is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(tool);
}
