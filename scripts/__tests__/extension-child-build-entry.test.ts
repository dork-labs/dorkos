/**
 * The extension child ships with every build that ships the server (DOR-2686
 * tasks 3.1 and 3.6).
 *
 * The server forks `extension-child.cjs` from beside its own bundle for every
 * extension that runs separately (`isolation/child-entry.ts`). A build that
 * forgot the entry would ship a server whose isolated extensions all fail to
 * start, and nothing else in CI would notice until a person installed one.
 * A full build is too slow for this suite, so these are static assertions on
 * the build scripts and the packaging config:
 *
 * - both the CLI and the desktop server builds bundle the child bootstrap to
 *   `server/extension-child.cjs`, as CommonJS;
 * - that file name is the one the server looks for;
 * - the desktop app unpacks it from `app.asar` (the permission model grants
 *   real files, not archive entries);
 * - no Electron fuse turns off run-as-node, which the child needs to run on
 *   the desktop app's own binary.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOTSTRAP = 'apps/server/src/services/extensions/isolation/child/bootstrap.ts';
const OUTFILE = 'server/extension-child.cjs';

/** Read a repo file. */
function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * The text of the esbuild `build({...})` call whose entry is the bootstrap.
 *
 * @param source - A build script.
 */
function childBuildCall(source: string): string | null {
  const at = source.indexOf(BOOTSTRAP);
  if (at === -1) return null;
  const start = source.lastIndexOf('await build(', at);
  const end = source.indexOf('});', at);
  return start === -1 || end === -1 ? null : source.slice(start, end);
}

describe('extension child build entry', () => {
  // Purpose: each production build bundles the bootstrap to the right file,
  // as CommonJS, inlining dependencies (bundle: true).
  it.each([['packages/cli/scripts/build.ts'], ['apps/desktop/scripts/build-server.ts']])(
    '%s bundles the child',
    (script) => {
      const source = read(script);
      const call = childBuildCall(source);
      expect(call, `${script} has no build() for ${BOOTSTRAP}`).not.toBeNull();
      // The outfile may be named in the call or in a variable just before it.
      const region = source.slice(
        Math.max(0, source.indexOf(call!) - 400),
        source.indexOf(call!) + call!.length
      );
      expect(region).toContain(OUTFILE);
      expect(call).toMatch(/format:\s*'cjs'/);
      expect(call).toMatch(/bundle:\s*true/);
      expect(call).toMatch(/platform:\s*'node'/);
    }
  );

  // Purpose: the name the builds emit is the name the server looks for.
  it('matches the name the server resolves', () => {
    const source = read('apps/server/src/services/extensions/isolation/child-entry.ts');
    const match = source.match(/export const CHILD_ENTRY_FILE = '([^']+)'/);
    expect(match?.[1]).toBe(path.basename(OUTFILE));
  });

  // Purpose: the desktop app ships the child as a real file.
  it('is unpacked from app.asar', () => {
    const config = read('apps/desktop/electron-builder.yml');
    expect(config).toMatch(/asarUnpack:[\s\S]*- 'dist\/server\/extension-child\.cjs'/);
  });

  // Purpose: run-as-node stays on. The packaged app forks its own binary with
  // ELECTRON_RUN_AS_NODE=1; a RunAsNode fuse set off would make every isolated
  // extension refuse to start (the self-check fails closed, but nothing would run).
  it('keeps the RunAsNode fuse on', () => {
    const config = read('apps/desktop/electron-builder.yml');
    expect(config).not.toMatch(/runAsNode:\s*false/i);
    for (const file of ['apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts']) {
      expect(read(file)).not.toMatch(/RunAsNode\]?\s*[:=]\s*false/);
    }
  });
});
