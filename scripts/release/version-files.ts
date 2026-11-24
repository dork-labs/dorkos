/**
 * The version edits, made as text so nothing else in a file moves: the
 * `release-branch-contents` rule compares a package.json with its version
 * blanked and the API document byte for byte, so a reformat is refused there.
 *
 * Each edit first checks the file carries the previous version. A release
 * point whose files disagree with the last release is refused rather than
 * bumped from wherever it happens to be.
 *
 * @module scripts/release/version-files
 */
import { ReleaseCommitError } from './errors.ts';

/** The package.json files that move in lockstep with VERSION (release.md 6.3). */
export const PACKAGE_FILES = [
  'package.json',
  'packages/cli/package.json',
  'packages/cloud-api/package.json',
  'packages/connector-providers/package.json',
  'apps/desktop/package.json',
] as const;

/** The API document, which carries VERSION as `info.version` (release.md 6.2). */
export const API_DOCUMENT = 'docs/api/openapi.json';

/** Set VERSION, keeping whatever trailing whitespace the file had. */
export function bumpVersionFile(text: string, previous: string, version: string): string {
  const trailing = /\s*$/.exec(text)?.[0] ?? '';
  const current = text.slice(0, text.length - trailing.length);
  if (current !== previous)
    throw new ReleaseCommitError(
      `VERSION at the release point is "${current}", not ${previous}, the last release.`
    );
  return version + trailing;
}

/**
 * Change a package.json's top-level `version` and nothing else. Only the first
 * `"version": "<previous>"` is rewritten; if that was not the top-level field
 * the result is refused, never patched up.
 */
export function bumpPackageJson(
  path: string,
  text: string,
  previous: string,
  version: string
): string {
  const before = parseObject(path, text);
  if (before.version !== previous)
    throw new ReleaseCommitError(
      `${path} has version ${JSON.stringify(before.version)}, not ${previous}, the last release.`
    );
  const field = new RegExp(`("version"\\s*:\\s*)"${escapeRegExp(previous)}"`);
  const after = text.replace(field, `$1"${version}"`);
  const parsed = parseObject(path, after);
  const blank = (value: Record<string, unknown>) =>
    JSON.stringify({ ...value, version: undefined });
  if (parsed.version !== version || blank(parsed) !== blank(before))
    throw new ReleaseCommitError(
      `${path}: the first "version" field is not the top-level one, so it cannot be changed as text.`
    );
  return after;
}

/**
 * Change the API document's `info.version` exactly the way the rule checks it:
 * the document's first `"version": "<old>"` is the one `info` holds.
 */
export function bumpApiDocument(text: string, previous: string, version: string): string {
  const before = parseObject(API_DOCUMENT, text);
  const info = before.info;
  if (!isRecord(info) || info.version !== previous)
    throw new ReleaseCommitError(
      `${API_DOCUMENT} has info.version ${JSON.stringify(isRecord(info) ? info.version : undefined)}, not ${previous}, the last release.`
    );
  const field = (value: string) => `"version": ${JSON.stringify(value)}`;
  const after = text.replace(field(previous), field(version));
  const parsed = parseObject(API_DOCUMENT, after);
  if (!isRecord(parsed.info) || parsed.info.version !== version)
    throw new ReleaseCommitError(
      `${API_DOCUMENT}: the first "version": "${previous}" is not info.version, so it cannot be changed as text.`
    );
  return after;
}

function parseObject(path: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReleaseCommitError(`${path} is not valid JSON.`);
  }
  if (!isRecord(value)) throw new ReleaseCommitError(`${path} is not a JSON object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
