/**
 * `hono`, built in for every extension's server half (DOR-2857): an esbuild
 * plugin that resolves `hono` and `hono/<subpath>` to DorkOS's own copy and
 * bundles it inline.
 *
 * An extension in `~/.dork/extensions` has no `node_modules` above it, so a
 * bare `import { Hono } from 'hono'` could not resolve there. Inline, not
 * external, so the bundle stays one self-contained file: the same bytes run
 * in the server's process and in an isolated child, which can read nothing
 * but its own bundle.
 *
 * DorkOS's copy always wins, even over one the extension ships itself, so an
 * extension written against the docs builds the same everywhere. Files are
 * read with Node's `fs`, not by esbuild: inside the packaged desktop app the
 * copy sits in an archive only Node can read.
 *
 * Only what `hono`'s own `exports` map offers resolves (its `./utils/*`
 * pattern only for plain names), and nothing a `hono` file imports may leave
 * its package folder.
 *
 * @module services/extensions/server-bundle/host-hono
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'esbuild';

/** The esbuild namespace DorkOS's `hono` files load in. */
export const HOST_HONO_NAMESPACE = 'dorkos-host-hono';

/** Bare imports this plugin answers: `hono` and `hono/<subpath>`. */
const HONO_IMPORT = /^hono(?:\/.*)?$/;

/** Where DorkOS's own `hono` is: its package folder, version and exports. */
interface HostHono {
  root: string;
  version: string;
  exports: Record<string, unknown>;
}

let cached: HostHono | null | undefined;

/**
 * Find DorkOS's own `hono`, from this module's own location, once.
 *
 * @returns Where it is, or `null` when this install has none.
 */
export function hostHono(): HostHono | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve('hono'));
    while (
      path.basename(dir) !== 'hono' ||
      !path.basename(path.dirname(dir)).endsWith('node_modules')
    ) {
      const parent = path.dirname(dir);
      if (parent === dir) return cached;
      dir = parent;
    }
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      version?: unknown;
      exports?: unknown;
    };
    if (typeof pkg.version !== 'string' || !pkg.exports || typeof pkg.exports !== 'object') {
      return cached;
    }
    cached = { root: dir, version: pkg.version, exports: pkg.exports as Record<string, unknown> };
  } catch {
    // No `hono` beside this server: the plugin says so on the import.
  }
  return cached;
}

/**
 * The ES module target of one `exports` entry, or `undefined`.
 *
 * @param entry - The entry: a path, or conditions.
 */
function importTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  const conditions = entry as Record<string, unknown>;
  return [conditions.import, conditions.default].find(
    (value): value is string => typeof value === 'string'
  );
}

/** A subpath a `*` pattern may stand for: plain names, no `.`, `..` or empty segments. */
const PATTERN_MATCH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/**
 * The file `hono`'s `exports` map names for an import, preferring the ES
 * module build (so unused parts are left out of the bundle). An exact key
 * wins; otherwise a key with one `*` (`./utils/*`) matches a plain subpath.
 *
 * @param hono - DorkOS's `hono`.
 * @param specifier - `hono` or `hono/<subpath>`.
 * @returns The absolute path, or `null` when `hono` offers no such import.
 */
function exportedFile(hono: HostHono, specifier: string): string | null {
  const key = specifier === 'hono' ? '.' : `.${specifier.slice('hono'.length)}`;
  let target = Object.hasOwn(hono.exports, key) ? importTarget(hono.exports[key]) : undefined;
  if (!target) {
    for (const [pattern, entry] of Object.entries(hono.exports)) {
      const star = pattern.indexOf('*');
      if (star === -1 || pattern.indexOf('*', star + 1) !== -1) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      if (key.length < prefix.length + suffix.length) continue;
      const matched = key.slice(prefix.length, key.length - suffix.length);
      const template = importTarget(entry);
      if (!PATTERN_MATCH.test(matched) || !template) continue;
      target = template.split('*').join(matched);
      break;
    }
  }
  if (!target) return null;
  return inside(hono.root, path.resolve(hono.root, target));
}

/**
 * `file` when it is inside `root`, else `null`.
 *
 * @param root - The package folder.
 * @param file - An absolute path.
 */
function inside(root: string, file: string): string | null {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? file : null;
}

/**
 * The esbuild plugin. Put it before any plugin that would refuse `hono` for
 * resolving outside the extension's folder: it claims the import first.
 */
export function hostHonoPlugin(): Plugin {
  return {
    name: 'dorkos-host-hono',
    setup(build) {
      build.onResolve({ filter: HONO_IMPORT }, (args) => {
        const hono = hostHono();
        if (!hono) {
          return { errors: [{ text: `'${args.path}' is not available in this DorkOS install.` }] };
        }
        const file = exportedFile(hono, args.path);
        if (!file) {
          return {
            errors: [{ text: `'${args.path}' is not something hono ${hono.version} offers.` }],
          };
        }
        return { path: file, namespace: HOST_HONO_NAMESPACE };
      });
      // A `hono` file's own relative imports, kept inside its package.
      build.onResolve({ filter: /^\.\.?\//, namespace: HOST_HONO_NAMESPACE }, (args) => {
        const hono = hostHono();
        const file =
          hono && inside(hono.root, path.resolve(path.dirname(args.importer), args.path));
        if (!file) return { errors: [{ text: `'${args.path}' is outside hono's own folder.` }] };
        return { path: file, namespace: HOST_HONO_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: HOST_HONO_NAMESPACE }, async (args) => ({
        contents: await fs.readFile(args.path, 'utf8'),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }));
    },
  };
}
