/**
 * No copy on the MCP surfaces says keeping a server from an agent hides its key
 * from that agent's shell (DOR-3837). Keep-from takes a server's tools and key
 * out of that agent's chats; it is not a wall against a program that runs as
 * the same user on this computer, so no line may promise one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The folders whose files a person or an agent reads about MCP servers. */
const SOURCE_DIRS = [
  'apps/client/src/layers/features/global-mcp-servers',
  'apps/server/src/services/mesh/global-mcp',
] as const;

/** Single files on the same surfaces. */
const SOURCE_FILES = [
  'apps/server/src/routes/mcp-servers.ts',
  'docs/connections/index.mdx',
] as const;

/** Words that would promise the key is out of a shell's reach. */
const OVER_CLAIMS = [/can[’']t see/i, /never sees?\b/i, /\bonly you\b/i] as const;

/**
 * The one line allowed through, matched whole: it is about who can change an
 * app's access once login is on, not about MCP servers. Any edit to it makes
 * this guard read it again.
 */
const ALLOWED_LINES = new Set([
  "One kind of write does not have that protection: changing who can use an app — sharing it, narrowing it, disconnecting it. With login off, DorkOS cannot tell that write apart from one the app itself made, so anything with a shell on this machine can make it, the same as the app could. **Every agent** is just the widest version of that change, not a special case. Turning login on closes the gap for all of them, because from then on only you, signed in, can make those writes. Until then, changing an app's access is a choice for a machine you trust.",
]);

/** Every source file under `dir`, tests left out. */
function sourcesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(tsx?|mdx?)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).includes('__tests__'));
}

/** The over-claim a line makes, if any. */
function overClaim(line: string): RegExp | undefined {
  return OVER_CLAIMS.find((pattern) => pattern.test(line));
}

describe('MCP copy never promises keep-from hides a key (DOR-3837)', () => {
  it('finds no over-claim on any MCP surface', () => {
    const files = [...SOURCE_DIRS.flatMap(sourcesIn), ...SOURCE_FILES];
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          overClaim(line) && !ALLOWED_LINES.has(line)
            ? [`${file}:${index + 1}: ${line.trim()}`]
            : []
        )
    );
    expect(found).toEqual([]);
  });

  it('the allowed line is still in the guide, so the exception cannot outlive it', () => {
    const guide = readFileSync('docs/connections/index.mdx', 'utf8').split('\n');
    for (const line of ALLOWED_LINES) expect(guide).toContain(line);
  });

  it('catches each over-claim and leaves plain wording alone', () => {
    expect(overClaim("Agents you keep it from can't see its key.")).toBeDefined();
    expect(overClaim('An agent kept from it never sees the value.')).toBeDefined();
    expect(overClaim('Only you can read this key.')).toBeDefined();
    expect(overClaim('You can keep it from some agents.')).toBeUndefined();
    expect(overClaim('A hidden value does not show on the page again.')).toBeUndefined();
  });
});
