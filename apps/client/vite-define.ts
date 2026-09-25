/** Build-time constants shared by the web app and desktop renderer. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Read build constants relative to this file, so both bundlers use the same version.
 * @returns JSON-encoded values for Vite's define option.
 */
export function clientDefines(): Record<string, string> {
  // The release version, from the one package.json that carries it — the whole
  // monorepo bumps together at release, and `packages/cli` (what ships) reads
  // the same number. The client's own package.json is the `0.0.0` sentinel, so
  // it cannot be the source.
  const { version } = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
  ) as { version: string };

  return {
    // The build's identity, for anything that must start over when the build
    // changes. Today that is the persisted query cache's `buster`
    // (`shared/lib/query-persister.ts`): a new build may have changed the shape
    // of a payload, so it starts from an empty local memory rather than
    // hydrating yesterday's shape into today's components.
    __APP_VERSION__: JSON.stringify(version),
  };
}
