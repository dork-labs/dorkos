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

import { lexWithoutComments } from '../../../../scripts/lib/code-only.mjs';

const INDEX_PATH = fileURLToPath(new URL('../index.ts', import.meta.url));

/**
 * Drop comments, so the scan sees only what the server actually mints.
 *
 * The comments in `index.ts` name `127.0.0.1` several times on purpose — they
 * explain why it must not be used — and flagging those would push the next
 * person to delete the explanation.
 *
 * The repo's shared stripper, not the non-greedy block-comment regex this file
 * used to warn about: that regex was measured wrong here (178k characters
 * collapsed to 26k, two of the three real mint sites swallowed) because a
 * closing delimiter inside a string re-pairs the spans, and the whole-line `//`
 * filter that replaced it was blind to a trailing comment after code. The
 * shared stripper finds comment spans only after the parser has blanked every
 * literal, so neither failure is reachable.
 *
 * `lexWithoutComments` and not `lex`: a loopback URL IS a string literal, so
 * the stripper that blanks literals would leave this scan nothing to find and
 * the offender list would be empty for the one reason a green must never mean.
 *
 * @param source - `index.ts` as read from disk.
 * @returns The same text with comment spans blanked and every literal intact.
 */
function stripComments(source: string): string {
  const { code, parseErrors } = lexWithoutComments(source, INDEX_PATH);
  expect(parseErrors, 'index.ts did not parse, so this scan read guesswork').toBe(0);
  return code;
}

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

  it('mints no codex UI bridge, because there is no longer one to mint', async () => {
    // The site DOR-723 was filed about, asserted from the other side now. The
    // scoped `dorkos_ui` server it dialled is retired (spec `canvas-agent-seat`
    // §5): `control_ui` is a `ui` capability on the loopback `dorkos` server,
    // which the connector listener already mints its own URL for. A line that
    // came back would be a second copy of a tool that has one.
    const source = stripComments(await readFile(INDEX_PATH, 'utf8'));
    expect(source).not.toContain('mcpUiUrl');
    expect(source).not.toContain('/codex-ui-mcp');
  });

  it('still mints something for every site that used to, so nothing was fixed by deletion', async () => {
    // The guard on the guard. The check above is satisfied by an `index.ts` that
    // mints no URLs at all, which is the shape a careless "fix" takes.
    const source = stripComments(await readFile(INDEX_PATH, 'utf8'));
    // Two today: the local origin and the connector callback base. It was three
    // until the codex `dorkos_ui` bridge was retired with the stub it dialled.
    // Stated as a floor rather than an exact count so adding a mint site is not
    // a test edit — losing one is.
    const mints = [...source.matchAll(/localDialHost\(env\.DORKOS_HOST\)/g)];
    expect(mints.length).toBeGreaterThanOrEqual(2);
  });
});
