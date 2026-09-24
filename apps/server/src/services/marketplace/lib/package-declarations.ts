/**
 * Read the JSON declarations a Claude Code plugin ships, safely, for the
 * permission preview.
 *
 * A plugin declares the programs it runs in two kinds of place, and Claude Code
 * reads both: a default file in the package (`hooks/hooks.json`, `.mcp.json`,
 * `.lsp.json`, `monitors/monitors.json`) and a field of
 * `.claude-plugin/plugin.json` that is an inline value, a package-relative
 * path to another file, or a list of either. {@link declarationsOf} turns both
 * into one list of what to read.
 *
 * ## Only the package's own files
 *
 * The preview is returned to whoever asked for it, an agent included, so a
 * declaration must never read a file outside the package. A path that climbs
 * out, a declaration that is itself a symbolic link, or one whose real location
 * is outside the package's real root is reported unreadable and not opened:
 * `.mcp.json -> ~/.claude.json` would otherwise hand a person's own MCP
 * configuration, secrets and all, to the caller.
 *
 * @module services/marketplace/lib/package-declarations
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/** Where a Claude Code plugin's own manifest lives, package-relative. */
export const PLUGIN_JSON = '.claude-plugin/plugin.json';

/** What reading one declaration file found. */
export type DeclarationRead =
  { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'ok'; value: unknown };

/** One place a declaration lives: a file to read, or a value already inline in plugin.json. */
export type DeclarationSource =
  | { kind: 'file'; path: string; required: boolean }
  | { kind: 'inline'; path: string; value: unknown };

/** A path that stays inside its root once normalized. */
function staysInside(path: string): boolean {
  const inside = normalize(path);
  return !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`);
}

/**
 * Read one package-relative file as text, refusing anything that is not the
 * package's own: a path out of the package, a symbolic link, anything but a
 * regular file, or a file whose real location is outside the package's real root.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param path - The file's package-relative path.
 * @returns Absent, unreadable, or the file's text.
 */
export async function readPackageText(
  packagePath: string,
  path: string
): Promise<{ kind: 'absent' } | { kind: 'unreadable' } | { kind: 'ok'; text: string }> {
  if (!staysInside(path)) return { kind: 'unreadable' };
  const full = join(packagePath, normalize(path));
  try {
    const stats = await lstat(full);
    if (stats.isSymbolicLink() || !stats.isFile()) return { kind: 'unreadable' };
    const [realRoot, realFile] = await Promise.all([realpath(packagePath), realpath(full)]);
    if (!staysInside(relative(realRoot, realFile))) return { kind: 'unreadable' };
    return { kind: 'ok', text: await readFile(full, 'utf-8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable' };
  }
}

/**
 * Read one package-relative JSON file through {@link readPackageText}.
 *
 * @param packagePath - Absolute path to the staged package.
 * @param path - The declaration's package-relative path.
 * @returns Absent, unreadable (not the package's own, or not JSON), or the parsed value.
 */
export async function readDeclarationJson(
  packagePath: string,
  path: string
): Promise<DeclarationRead> {
  const read = await readPackageText(packagePath, path);
  if (read.kind !== 'ok') return read;
  try {
    return { kind: 'ok', value: JSON.parse(read.text) as unknown };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** A plain object, as opposed to an array, `null` or a scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The package's `.claude-plugin/plugin.json`, when it has a readable one. A
 * missing or unreadable manifest declares nothing extra; Claude Code refuses to
 * load a plugin whose manifest does not parse.
 *
 * @param packagePath - Absolute path to the staged package.
 * @returns The manifest object, or `undefined`.
 */
export async function readPluginJson(
  packagePath: string
): Promise<Record<string, unknown> | undefined> {
  const read = await readDeclarationJson(packagePath, PLUGIN_JSON);
  return read.kind === 'ok' && isRecord(read.value) ? read.value : undefined;
}

/**
 * Every place one kind of declaration lives: the default file, then whatever
 * the plugin.json field adds (a path, an inline value, or a list of either).
 * A path the field names is required: a missing file there is reported, not
 * skipped. The default file is not listed twice when the field names it too.
 *
 * @param defaultPath - The package-relative default file.
 * @param field - The plugin.json field's value, when present.
 * @returns The sources, in the order Claude Code reads them.
 */
export function declarationsOf(defaultPath: string, field: unknown): DeclarationSource[] {
  const sources: DeclarationSource[] = [{ kind: 'file', path: defaultPath, required: false }];
  if (field === undefined) return sources;
  const items =
    Array.isArray(field) && field.every((i) => typeof i === 'string' || isRecord(i))
      ? field
      : [field];
  for (const item of items) {
    if (typeof item === 'string') {
      if (normalize(item) === normalize(defaultPath)) {
        sources[0] = { kind: 'file', path: defaultPath, required: true };
      } else {
        sources.push({ kind: 'file', path: item, required: true });
      }
    } else {
      sources.push({ kind: 'inline', path: PLUGIN_JSON, value: item });
    }
  }
  return sources;
}
