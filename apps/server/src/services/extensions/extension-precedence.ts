/**
 * Which plugin-carried copy of an extension id runs, when several are
 * installed (spec `flow-multiproject` §9.2, N5).
 *
 * Discovery hands this module every plugin-carried copy it found, in the
 * global plugins and in every known project's plugins, after the core and
 * directly installed copies have taken their ids. Per id, the first rule that
 * matches wins:
 *
 * | #   | Candidate                                            | Rule                                     |
 * | --- | ---------------------------------------------------- | ---------------------------------------- |
 * | 3   | a copy approved by path, outside the origin family   | the approved copy wins                   |
 * | 4   | copies whose trusted origin equals the approved one  | the highest manifest version wins        |
 * | 4b  | copies from a source in `extensions.trustedSources`  | the highest manifest version wins        |
 * | 5   | any other copy                                       | global first, then sorted root, plugin   |
 *
 * Row 3 and row 4 overlap when the path-approved copy itself has the approved
 * origin, which is the ordinary case (a person approved flow in repo A, then
 * installed a newer flow in repo B from the same source). Then row 4 governs,
 * so the newer copy runs and the approved one steps aside: that is the whole
 * point of the approval carrying an origin. Row 3 keeps its old meaning only
 * for a path-approved copy that is NOT part of that family.
 *
 * A version tie goes to the global copy, then the sorted project root, then
 * the sorted plugin name: the order discovery already hands the copies in.
 * The copies a row-4 or row-4b winner beat, from its own trusted origin, are
 * reported back as shadowed so `GET /api/extensions` can say an older copy
 * sits in a project. A copy with no trusted origin never joins rows 4 or 4b,
 * whatever its files claim, so a cloned repo carrying a "newer" copy cannot
 * run without its own approval.
 *
 * Pure: no I/O.
 *
 * @module services/extensions/extension-precedence
 */
import { rcompare, valid } from 'semver';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionsConfig, CoreExtensionInfo } from './extension-enable-resolution.js';
import { isApprovedByPath, isFromTrustedSource } from './extension-load-policy.js';
import { sameOrigin } from './extension-trusted-origin.js';
import { logger } from '../../lib/logger.js';

/** A record before its `origin` is resolved. */
export type DiscoveredRecord = Omit<ExtensionRecord, 'origin'>;

/** A copy losing to a newer copy of the same trusted origin. */
export interface ShadowedCopy {
  /** The copy that does not run. */
  record: DiscoveredRecord;
  /** The path of the copy that runs instead. */
  shadowedBy: string;
}

/**
 * Newest manifest version first. A version that is not semver sorts after
 * every one that is; otherwise the incoming order (global first, then sorted
 * root, then sorted plugin) breaks ties, because `Array.prototype.sort` is
 * stable.
 *
 * @param a - One copy.
 * @param b - The other.
 */
export function byNewestVersion(a: DiscoveredRecord, b: DiscoveredRecord): number {
  const va = valid(a.manifest.version);
  const vb = valid(b.manifest.version);
  if (va && vb) return rcompare(va, vb);
  if (va) return -1;
  if (vb) return 1;
  return 0;
}

/**
 * The winner of a family of copies from one trusted origin, and the copies it
 * shadows.
 *
 * @param family - Copies sharing a trusted origin, in discovery order.
 */
function newestOf(family: readonly DiscoveredRecord[]): {
  chosen: DiscoveredRecord;
  shadowed: ShadowedCopy[];
} {
  const [chosen, ...rest] = [...family].sort(byNewestVersion);
  if (!chosen) throw new Error('newestOf needs at least one copy');
  return {
    chosen,
    shadowed: rest
      .filter((copy) => sameOrigin(copy.trustedOrigin, chosen.trustedOrigin))
      .map((record) => ({ record, shadowedBy: chosen.path })),
  };
}

/**
 * Pick one copy per id among the plugin-carried copies, for ids nothing ahead
 * of them already holds.
 *
 * A core id and an id installed directly both win over any plugin (rows 1-2,
 * with today's warning). A copy inside a project's plugin is dropped when its
 * id is approved for another copy it does not share an origin with, exactly
 * like a project's own extension. A global plugin's copy of such an id is
 * still listed, so a person can see it and approve it, but it runs nothing
 * until they do (`extension-load-policy.ts`).
 *
 * @param merged - Records resolved so far, keyed by id; updated in place.
 * @param pluginRecords - Plugin-carried records: global first, then each
 *   project root in sorted order, each group sorted by plugin name.
 * @param config - The stored extensions config: approvals and trusted sources.
 * @param core - Tier metadata for bundled core extensions, keyed by id.
 * @param approvedElsewhere - Whether a record's id is spoken for by another copy.
 * @returns The copies that lost on version to a copy of their own trusted origin.
 */
export function mergePluginRecords(
  merged: Map<string, DiscoveredRecord>,
  pluginRecords: readonly DiscoveredRecord[],
  config: ExtensionsConfig,
  core: Map<string, CoreExtensionInfo>,
  approvedElsewhere: (rec: DiscoveredRecord) => boolean
): ShadowedCopy[] {
  const byId = new Map<string, DiscoveredRecord[]>();
  for (const rec of pluginRecords) {
    const group = byId.get(rec.id);
    if (group) group.push(rec);
    else byId.set(rec.id, [rec]);
  }

  const shadowed: ShadowedCopy[] = [];
  for (const [id, candidates] of byId) {
    const carriers = candidates.map((c) => c.sourcePlugin).join(', ');
    const ahead = merged.get(id);
    if (core.has(id) || ahead) {
      logger.warn(
        `[Extensions] Ignoring the copy of '${id}' carried by the plugin(s) ${carriers}: ` +
          (core.has(id)
            ? 'that id ships with DorkOS.'
            : `the extension at ${ahead?.path} takes precedence.`)
      );
      continue;
    }
    const eligible = candidates.filter((c) => c.scope === 'global' || !approvedElsewhere(c));
    const [first] = eligible;
    if (!first) {
      logger.warn(
        `[Extensions] Ignoring the project plugin copy of '${id}' (${carriers}): that id is ` +
          `approved for another copy.`
      );
      continue;
    }

    const asCopy = (c: DiscoveredRecord) => ({ ...c, origin: 'user' as const });
    const approvedOrigin = config.approvedToRun.includes(id)
      ? config.approvedSources?.[id]?.origin
      : undefined;
    const originFamily = approvedOrigin
      ? eligible.filter((c) => sameOrigin(c.trustedOrigin, approvedOrigin))
      : [];
    const byPath = eligible.find((c) => isApprovedByPath(asCopy(c), config));
    const trustedFamily = eligible.filter((c) => isFromTrustedSource(asCopy(c), config));

    let chosen: DiscoveredRecord;
    if (originFamily.length > 0 && (!byPath || originFamily.includes(byPath))) {
      // Row 4: every copy of the approved trusted origin; the newest runs.
      const result = newestOf(originFamily);
      chosen = result.chosen;
      shadowed.push(...result.shadowed);
    } else if (byPath) {
      // Row 3: the copy a person approved by path.
      chosen = byPath;
    } else if (trustedFamily.length > 0) {
      // Row 4b: copies from a source the person trusts; the newest runs.
      const result = newestOf(trustedFamily);
      chosen = result.chosen;
      shadowed.push(...result.shadowed);
    } else {
      // Row 5: global before project, then sorted root, then sorted plugin.
      chosen = first;
    }

    if (candidates.length > 1) {
      logger.warn(
        `[Extensions] More than one installed plugin carries '${id}' (${carriers}); using ` +
          `the copy in '${chosen.sourcePlugin}' at ${chosen.path}.`
      );
    }
    merged.set(id, chosen);
  }
  return shadowed;
}
