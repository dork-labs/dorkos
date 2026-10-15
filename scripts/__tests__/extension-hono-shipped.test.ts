/**
 * Every build that ships the server ships `hono` beside it (DOR-2857).
 *
 * The extension compiler bundles DorkOS's own `hono` into every extension's
 * server half, reading it from the `node_modules` next to the server bundle
 * (`apps/server/src/services/extensions/server-bundle/host-hono.ts`). The
 * server bundle carries its own copy inline, so nothing else in a build needs
 * `hono` on disk, and a build that dropped the dependency would still pass
 * every other check while every Hono extension stopped building. These are
 * static assertions on the shipped packages' dependencies.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A package's runtime dependencies. */
function dependencies(relative: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, relative, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return pkg.dependencies ?? {};
}

describe('hono ships beside the server', () => {
  const server = dependencies('apps/server').hono;

  it.each(['packages/cli', 'apps/desktop'])('%s depends on the server’s hono', (pkg) => {
    expect(server).toBeDefined();
    expect(dependencies(pkg).hono).toBe(server);
  });
});
