import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('../../packages/', import.meta.url));

/**
 * Workspace packages the DorkOS server imports that ship only a built `default` entry. The
 * redaction mirror test runs the server's own room and search code against a real Community
 * server; CI's community job builds only the packages the Community itself needs, so these
 * resolve to their `types` entry, which in each is the TypeScript source.
 */
const SERVER_SOURCE_PACKAGES = new Set([
  'a2a-gateway',
  'connector-providers',
  'extension-api',
  'harness',
  'marketplace',
  'memory',
  'mesh',
  'operating-skills',
  'relay',
  'skills',
]);

/** Resolve `@dorkos/<pkg>` and `@dorkos/<pkg>/<subpath>` through the package's `types` export. */
function serverPackagesFromSource(): Plugin {
  const exportsOf = new Map<string, Record<string, { types?: string } | string>>();
  return {
    name: 'server-packages-from-source',
    enforce: 'pre',
    resolveId(source) {
      const match = /^@dorkos\/([^/]+)(\/.+)?$/.exec(source);
      if (!match || !SERVER_SOURCE_PACKAGES.has(match[1])) return null;
      const name = match[1];
      if (!exportsOf.has(name)) {
        const manifest = JSON.parse(readFileSync(`${packages}${name}/package.json`, 'utf8')) as {
          exports: Record<string, { types?: string } | string>;
        };
        exportsOf.set(name, manifest.exports);
      }
      const entry = exportsOf.get(name)![match[2] ? `.${match[2]}` : '.'];
      const types = typeof entry === 'object' ? entry.types : undefined;
      return types?.endsWith('.ts') && !types.endsWith('.d.ts')
        ? `${packages}${name}/${types.slice(2)}`
        : null;
    },
  };
}

export default defineConfig({
  plugins: [serverPackagesFromSource()],
  test: {
    name: 'community-pg',
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
