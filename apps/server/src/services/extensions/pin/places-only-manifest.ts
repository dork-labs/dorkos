/**
 * The manifest half of a places-only update (DOR-4282, option C2): whether
 * two `extension.json` texts differ only by newly added places and, at most,
 * their `version`. Pure; split from `places-only-update.ts`, which reads the
 * texts from two digest-checked snapshots.
 *
 * @module services/extensions/pin/places-only-manifest
 */
import { ExtensionManifestSchema, isContributionKey } from '@dorkos/extension-api';

/**
 * Whether a JSON text repeats a key inside one object, or uses `__proto__` as
 * a key anywhere. `JSON.parse` keeps the last repeat silently, so two readers
 * could disagree on what the file says. Call it only on text `JSON.parse`
 * accepted.
 *
 * @param text - A valid JSON text.
 */
export function hasRepeatedOrPrototypeKey(text: string): boolean {
  const frames: Array<{ keys: Set<string> | null; wantsKey: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') frames.push({ keys: new Set(), wantsKey: true });
    else if (char === '[') frames.push({ keys: null, wantsKey: false });
    else if (char === '}' || char === ']') frames.pop();
    else if (char === ',') {
      const top = frames[frames.length - 1];
      if (top?.keys) top.wantsKey = true;
    } else if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = frames[frames.length - 1];
      if (top?.keys && top.wantsKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (key === '__proto__' || top.keys.has(key)) return true;
        top.keys.add(key);
        top.wantsKey = false;
      }
      i = end;
    }
  }
  return false;
}

/** A value with every object's keys in sorted order, for an equality check. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

/**
 * A manifest text read the loader's way, or null when the loader would refuse
 * it or it repeats a key.
 */
function readManifest(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (hasRepeatedOrPrototypeKey(text)) return null;
  if (!ExtensionManifestSchema.safeParse(parsed).success) return null;
  return parsed as Record<string, unknown>;
}

/** A plain object of places, or null when it is anything else. */
function placesMap(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What a places-only manifest change moved between. */
export interface ManifestMove {
  /** The manifest id, the same on both sides. */
  id: string;
  /** The approved manifest's version. */
  fromVersion: string;
  /** The new manifest's version. */
  toVersion: string;
}

/**
 * How two manifest texts differ, when they differ only by newly added places
 * (each exactly `true`) and at most their `version`. Pure. A changed version
 * alone is not enough: at least one place must be added. Whether the version
 * may change is the caller's rule: only for a dork-apps rebuild, and never
 * downward; for any other app a changed version counts as changed.
 *
 * @param before - The approved `extension.json`, as text.
 * @param after - The one installed now, as text.
 * @returns The id and both versions, or null when anything else changed.
 */
export function placesOnlyManifestMove(before: string, after: string): ManifestMove | null {
  const old = readManifest(before);
  const now = readManifest(after);
  if (!old || !now) return null;
  const { contributions: oldPlaces, version: oldVersion, ...oldRest } = old;
  const { contributions: newPlaces, version: newVersion, ...newRest } = now;
  if (JSON.stringify(canonical(oldRest)) !== JSON.stringify(canonical(newRest))) return null;
  // The schema already holds both to strings; this only narrows the type.
  if (typeof oldVersion !== 'string' || typeof newVersion !== 'string') return null;
  const was = placesMap(oldPlaces);
  const is = placesMap(newPlaces);
  if (!was || !is) return null;
  // Nothing removed, and nothing it had changed value.
  for (const [key, value] of Object.entries(was)) {
    if (!Object.hasOwn(is, key) || is[key] !== value) return null;
  }
  const added = Object.keys(is).filter((key) => !Object.hasOwn(was, key));
  if (added.length === 0 || !added.every((key) => isContributionKey(key) && is[key] === true)) {
    return null;
  }
  return { id: String(now.id), fromVersion: oldVersion, toVersion: newVersion };
}

/**
 * Whether two manifest texts differ only by newly added places, each set to
 * exactly `true`, with the same `version`: the rule for an app no build tool
 * stamps, where a changed version counts as changed. Pure.
 *
 * @param before - The approved `extension.json`, as text.
 * @param after - The one installed now, as text.
 */
export function manifestOnlyAddsPlaces(before: string, after: string): boolean {
  const move = placesOnlyManifestMove(before, after);
  return move !== null && move.fromVersion === move.toVersion;
}
