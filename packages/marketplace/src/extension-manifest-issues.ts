/**
 * What the package check says about a bundled extension manifest the schema
 * refused: one issue per schema problem, except that an app naming another
 * app (one it calls, or one its exports admit) by anything but its exact id
 * gets a single refusal in the designer's
 * words (DOR-3293), the same on install and update, naming no id the app
 * made up.
 *
 * @module marketplace/extension-manifest-issues
 */
import type { ValidationIssue } from './package-validator.js';

/** One schema problem, as the extension manifest schema reports it. */
interface SchemaIssue {
  path: readonly PropertyKey[];
  message: string;
}

/**
 * Whether a schema problem is about another app the manifest names: one it
 * calls (`capabilities.http.apps`) or one an exported route admits
 * (`exports.http[].callers`).
 */
function isCalledAppPath(issuePath: readonly PropertyKey[]): boolean {
  const [a, b, c, d] = issuePath;
  if (a === 'capabilities' && b === 'http' && c === 'apps') return true;
  return a === 'exports' && b === 'http' && d === 'callers';
}

/** The app's own name from its manifest, else its folder name. */
function appNameOf(raw: unknown, folder: string): string {
  const name = (raw as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : folder;
}

/**
 * The issues for one refused manifest.
 *
 * @param schemaIssues - What the schema found.
 * @param raw - The manifest as parsed JSON, for the app's name.
 * @param folder - The extension's folder name, when the manifest has no name.
 * @param relPath - The manifest's path in the package.
 */
export function manifestSchemaIssues(
  schemaIssues: readonly SchemaIssue[],
  raw: unknown,
  folder: string,
  relPath: string
): ValidationIssue[] {
  const refusal: ValidationIssue[] = schemaIssues.some((issue) => isCalledAppPath(issue.path))
    ? [
        {
          level: 'error',
          code: 'EXTENSION_CALLED_APP_INVALID',
          message: `${appNameOf(raw, folder)} can’t be installed. It names another app in a way DorkOS doesn’t accept. Ask its maker for an update.`,
          path: relPath,
        },
      ]
    : [];
  return [
    ...refusal,
    ...schemaIssues
      .filter((issue) => !isCalledAppPath(issue.path))
      .map((issue): ValidationIssue => ({
        level: 'error',
        code: 'EXTENSION_MANIFEST_INVALID',
        message: `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`,
        path: relPath,
      })),
  ];
}
