import fs from 'fs/promises';
import path from 'path';
import { OVERRIDES_ROOT } from './config.js';
import { getShot, SHOTS, shotTargetDimensions, type Shot } from './shots.js';
import { writeLoop, writeStill, type AssetEntry, type OverrideProvenance } from './optimize.js';

/**
 * Human overrides: committed, hand-captured media that beats the automated
 * capture for a shot. An owner drops files under `overrides/<shot-id>/` and
 * they replace the auto-processed output for that shot — run through the *same*
 * optimization path (palette-quantized PNG; fps-normalized, two-pass VP9 with
 * poster), so an override is never a lower-quality second class.
 *
 * Overrides are applied on top of the auto-processed set every process run, so
 * wiping the output dir first stays safe. See `README.md` (Human overrides) for
 * the owner's workflow.
 *
 * @module capture/overrides
 */

/** Accepted container extensions for a loop override source. */
const LOOP_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv'] as const;

/** The still override file name (light theme is the only still a shot ships). */
const STILL_FILE = 'still-light.png';

/** Optional sidecar metadata file. */
const META_FILE = 'override.json';

/** Parsed `override.json` sidecar. */
interface OverrideMeta extends OverrideProvenance {
  /** When true, the record phase skips this shot — the override is the sole source. */
  skipAuto?: boolean;
}

/** A discovered override directory for one shot. */
export interface DiscoveredOverride {
  readonly shot: Shot;
  /** Absolute path to the still override, if present. */
  readonly stillPath?: string;
  /** Absolute path to the loop override source, if present. */
  readonly loopPath?: string;
  readonly meta: OverrideMeta;
}

/** Read and parse the `override.json` sidecar, or return an empty meta. */
async function readMeta(dir: string): Promise<OverrideMeta> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8')) as OverrideMeta;
  } catch {
    return {};
  }
}

/** Find the first loop-override source file in a shot's override dir, if any. */
async function findLoopSource(dir: string): Promise<string | undefined> {
  for (const ext of LOOP_EXTENSIONS) {
    const candidate = path.join(dir, `loop-dark${ext}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try the next extension
    }
  }
  return undefined;
}

/**
 * Discover every committed override. Each subdirectory of `overrides/` must
 * name a registered shot; an unknown id fails loudly so a typo never silently
 * ships nothing.
 */
export async function discoverOverrides(
  root: string = OVERRIDES_ROOT
): Promise<DiscoveredOverride[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const found: DiscoveredOverride[] = [];
  for (const id of entries.sort()) {
    const dir = path.join(root, id);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    const shot = getShot(id);
    if (!shot) {
      throw new Error(
        `overrides/${id}/ does not match any registered shot — check the id against capture/shots.ts`
      );
    }
    const stillPath = path.join(dir, STILL_FILE);
    const hasStill = await fs
      .access(stillPath)
      .then(() => true)
      .catch(() => false);
    const loopPath = await findLoopSource(dir);
    if (!hasStill && !loopPath) continue; // a bare/meta-only dir is a no-op
    if (loopPath && shot.kind !== 'loop') {
      throw new Error(
        `overrides/${id}/ supplies a loop, but "${id}" is a still-only shot (see capture/shots.ts)`
      );
    }
    found.push({
      shot,
      stillPath: hasStill ? stillPath : undefined,
      loopPath,
      meta: await readMeta(dir),
    });
  }
  return found;
}

/**
 * Ids of shots the record phase should skip. A shot is skipped when its
 * registry entry is flagged `skipAuto`, or when its `override.json` sets
 * `skipAuto: true` — either way, a human override is its sole source.
 */
export async function autoSkippedShotIds(root: string = OVERRIDES_ROOT): Promise<Set<string>> {
  const overrides = await discoverOverrides(root);
  const ids = new Set<string>(SHOTS.filter((s) => s.skipAuto).map((s) => s.id));
  for (const o of overrides) if (o.meta.skipAuto) ids.add(o.shot.id);
  return ids;
}

/**
 * Apply every override on top of the auto-processed set, returning the merged
 * asset list. A manual asset replaces the auto asset with the same file name;
 * a manual loop replaces both the webm and its poster. Each replaced/added
 * asset is tagged `source: 'manual'` with its override provenance.
 *
 * @param autoAssets - The auto-processed asset entries.
 * @param now - ISO timestamp to record as the override's `capturedAt`.
 * @returns The merged asset list with overrides applied.
 */
export async function applyOverrides(autoAssets: AssetEntry[], now: string): Promise<AssetEntry[]> {
  const overrides = await discoverOverrides();
  if (overrides.length === 0) return autoAssets;

  const byFile = new Map(autoAssets.map((a) => [a.file, a]));
  for (const { shot, stillPath, loopPath, meta } of overrides) {
    const provenance: OverrideProvenance = {
      reason: meta.reason,
      capturedBy: meta.capturedBy,
      date: meta.date,
    };
    const tag = (entry: AssetEntry): AssetEntry => ({
      ...entry,
      source: 'manual',
      capturedAt: meta.date ?? now,
      override: provenance,
    });

    if (stillPath) {
      const entry = tag(
        await writeStill(await fs.readFile(stillPath), shot.id, 'light', {
          target: shotTargetDimensions(shot, 'still'),
        })
      );
      byFile.set(entry.file, entry);
      process.stdout.write(`  ✎ override ${entry.file} (manual)\n`);
    }
    if (loopPath) {
      const target = shotTargetDimensions(shot, 'loop');
      const produced = await writeLoop({
        sourcePath: loopPath,
        surface: shot.id,
        width: target.width,
        height: target.height,
        headTrimMs: 0,
        validateSourceAspect: true,
        posterFrame: shot.posterFrame,
      });
      for (const entry of produced.map(tag)) {
        byFile.set(entry.file, entry);
        process.stdout.write(`  ✎ override ${entry.file} (manual)\n`);
      }
    }
  }
  return [...byFile.values()];
}
