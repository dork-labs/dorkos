/**
 * The composition root mints no dial URL from a hardcoded loopback literal
 * (DOR-723).
 *
 * ## The bug this is a guard for
 *
 * A URL DorkOS hands to something that will DIAL it — a runtime's MCP client, an
 * OAuth callback — has to name a host that actually answers. The server binds
 * `env.DORKOS_HOST`, and Node resolves that to ONE address family, so:
 *
 * - On a host where `localhost` is `::1` (macOS, routinely), a `127.0.0.1` URL
 *   is connection-refused. Nothing is listening there.
 * - The shipped Docker image binds the wildcard `0.0.0.0`, which is not an
 *   address at all; Windows refuses to connect to it outright.
 *
 * `lib/local-dial-host.ts` is the answer, and three sites in `index.ts` already
 * used it. The `dorkos_ui` bridge did not, and shipped `http://127.0.0.1:PORT`
 * for a year. DOR-1613 fixed it while adding a second mint site beside it —
 * shipping the same bug twice is what this file exists to stop.
 *
 * ## Why it scans this file rather than the whole tree
 *
 * `127.0.0.1` is legitimate almost everywhere else it appears: `mcp-origin.ts`
 * and `trusted-origins.ts` build ALLOWLISTS, which must accept the literal
 * precisely because browsers send it. Those are the opposite of a mint — they
 * receive a host, they do not choose one. Scanning them would produce a guard
 * that has to be weakened, which is worse than no guard. So the scope is the
 * composition root, which is where dial URLs are minted.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Drop comment LINES, so the scan sees only code.
 *
 * The comments in `index.ts` name `127.0.0.1` several times on purpose — they
 * explain why it must not be used — and flagging those would push the next
 * person to delete the explanation.
 *
 * Deliberately line-oriented rather than the usual non-greedy block-comment
 * sweep, which was measured to be wrong on this file: it collapsed 178k
 * characters to 26k and swallowed two of the three real mint sites. A closing
 * block delimiter appearing anywhere inside a string or a line comment re-pairs
 * the delimiters, and every match after it lands on the wrong span. A code line
 * never begins with an asterisk or a double slash, so dropping those lines is
 * exact here and cannot run away.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

const INDEX_PATH = fileURLToPath(new URL('../index.ts', import.meta.url));

describe('dial URLs minted by the composition root', () => {
  it('never hardcodes a loopback literal', async () => {
    const source = stripComments(await readFile(INDEX_PATH, 'utf8'));
    const offenders = [...source.matchAll(/https?:\/\/(?:127\.0\.0\.1|\[?::1\]?)(?=[:/'"`])/g)].map(
      (match) => match[0]
    );
    expect(
      offenders,
      'these URLs name a loopback address the server may not be listening on. ' +
        'Mint through `localDialHost(env.DORKOS_HOST)` instead (DOR-723).'
    ).toEqual([]);
  });

  it('mints the codex dorkos_ui bridge through localDialHost', async () => {
    // Named specifically, because it is the site DOR-723 was filed about and a
    // blanket absence check would pass if the line were simply deleted.
    const source = stripComments(await readFile(INDEX_PATH, 'utf8'));
    const line = source.split('\n').find((candidate) => candidate.includes('mcpUiUrl:'));
    expect(line, 'the codex `mcpUiUrl` wiring is gone — has it moved?').toBeDefined();
    expect(line).toContain('localDialHost(env.DORKOS_HOST)');
    expect(line).toContain('/codex-ui-mcp');
  });

  it('still mints something for every site that used to, so nothing was fixed by deletion', async () => {
    // The guard on the guard. Both checks above are satisfied by an `index.ts`
    // that mints no URLs at all, which is the shape a careless "fix" takes.
    const source = stripComments(await readFile(INDEX_PATH, 'utf8'));
    // Three today: the local origin, the connector callback base, and the codex
    // `dorkos_ui` bridge this change converted. Stated as a floor rather than an
    // exact count so adding a fourth mint site is not a test edit — losing one
    // is.
    const mints = [...source.matchAll(/localDialHost\(env\.DORKOS_HOST\)/g)];
    expect(mints.length).toBeGreaterThanOrEqual(3);
  });
});
