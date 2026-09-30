import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The per-job watermark and the per-post roster are bounded to one community by the shared
 * queries in `content/watermark.ts` and `content/roster.ts`, and index-coverage.integration.test
 * bounds what those queries read (DOR-2572). That proves nothing if a caller stops using them.
 * These checks read the source: each known caller must import and call its shared query, and no
 * other module may bring back the shapes that read a whole community or host.
 */

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(SOURCE_ROOT, path), 'utf8');

/** The modules that own the bounded queries, and may spell out their SQL. */
const OWNERS = new Set(['content/watermark.ts', 'content/roster.ts']);

/** Every non-test TypeScript source file, relative to src/. */
function sources(dir = SOURCE_ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(SOURCE_ROOT, path)] : [];
  });
}

describe('bounded per-job and per-post queries', () => {
  it.each([
    ['erasure/erasure.ts', 'channelWatermarks', '../content/watermark.js'],
    ['exports/worker.ts', 'channelWatermarks', '../content/watermark.js'],
    ['routes/community/channels.ts', 'channelRoster', '../../content/roster.js'],
    ['routes/community/entries.ts', 'channelRoster', '../../content/roster.js'],
  ])('%s reads through %s', (path, name, module) => {
    // Purpose: fails if a caller drops the shared query for an inline copy.
    const source = read(path);
    expect(source).toMatch(
      new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '${module.replaceAll('.', '\\.')}'`)
    );
    expect(source).toMatch(new RegExp(`\\b${name}\\(`));
  });

  it('keeps the whole-community shapes out of every other module', () => {
    // Purpose: fails if a watermark grouped over a community's messages, or a channel's members
    // joined to members by id alone (a hash of every membership on the host), comes back
    // anywhere outside the owning modules. The agents half is not listed: a single-owner EXISTS
    // (exports/authority.ts) joins agents by id and reads one channel's agents, not the host.
    const shapes = [
      /max\(\s*seq\s*\)[^`]*?GROUP\s+BY\s+channel_id/i,
      /channel_members\s+\w+\s+JOIN\s+members\s+\w+\s+ON\s+\w+\.id\s*=\s*\w+\.member_id/i,
    ];
    const found = sources()
      .filter((path) => !OWNERS.has(path))
      .flatMap((path) => {
        const source = read(path);
        return shapes.filter((shape) => shape.test(source)).map((shape) => `${path}: ${shape}`);
      });
    expect(found).toEqual([]);
  });
});
