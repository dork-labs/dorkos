/**
 * The bearer-refused detector replayed against recorded `query.mcpServerStatus()`
 * output from real turns (see the module doc of `mcp-revocation.ts`).
 */
import { describe, it, expect } from 'vitest';
import observedStatus from './fixtures/mcp-server-status-401.observed.json' with { type: 'json' };
import observedStatus268 from './fixtures/mcp-server-status-401-0.3.268.observed.json' with { type: 'json' };
import observed280 from './fixtures/mcp-server-status-401-0.3.280.observed.json' with { type: 'json' };

describe('reading a turn’s status snapshot', () => {
  it('catches the bearer-refused server in the ACTUAL observed snapshot', async () => {
    // The anchor for the whole design, replayed from the recorded output of a
    // real turn rather than from a hand-written idea of what one looks like.
    //
    // Provenance: `fixtures/mcp-server-status-401.observed.json` is the verbatim
    // `query.mcpServerStatus()` array from one turn against
    // `@anthropic-ai/claude-agent-sdk` 0.3.177, with two MCP servers pointed at
    // an always-401 endpoint — one carrying a DorkOS-style bearer, one with no
    // credentials at all. Unrelated servers from that machine were removed; the
    // four entries kept are unedited. The harness is described in the module doc
    // of `mcp-revocation.ts` and is not run by any suite (it spends a real turn).
    const { mcpAuthEvidenceFrom } = await import('../mcp-revocation.js');
    const observed: Array<{ name: string; status?: string }> = observedStatus;

    // The bearer-carrying server is `failed`, NOT `needs-auth` — which is why
    // the first version of this feature never fired. Reverting the filter to
    // `needs-auth` only drops it and reddens this against real recorded data.
    expect(observed.find((s) => s.name.startsWith('dor981-bearer'))?.status).toBe('failed');
    expect(mcpAuthEvidenceFrom(observed)).toContain(
      observed.find((s) => s.name.startsWith('dor981-bearer'))!.name
    );
    // …and the two servers that were merely still connecting are left alone.
    expect(mcpAuthEvidenceFrom(observed)).not.toContain('shadcn');
  });

  it('catches the same two on a snapshot re-observed two SDK versions later', async () => {
    // Provenance: `fixtures/mcp-server-status-401-0.3.268.observed.json` is the
    // same harness re-run on 2026-09-11 against
    // `@anthropic-ai/claude-agent-sdk` 0.3.268, on the bump from 0.3.224. Rows
    // belonging to that machine's own servers were removed; the three kept are
    // unedited.
    //
    // Two things the 0.3.177 snapshot could not show, and the reason a second
    // anchor is worth committing rather than refreshing the first:
    //
    // - the tokenless refusal now carries WORDS ("Dynamic Client Registration
    //   rejected (HTTP 401)…") where it used to carry an empty string, so a
    //   detector keying on the message text would read the two versions
    //   differently. This one deliberately keys on neither;
    // - a REAL `needs-auth` row appears, which the first run never produced —
    //   and it carries no `error` field at all, exactly as the binary reading
    //   said it would.
    const { mcpAuthEvidenceFrom } = await import('../mcp-revocation.js');
    const observed: Array<{ name: string; status?: string; error?: string }> = observedStatus268;

    expect(observed.find((s) => s.name === 'probe-bearer')?.status).toBe('failed');
    expect(observed.find((s) => s.name === 'probe-tokenless')?.error).toMatch(
      /Dynamic Client Registration rejected/
    );
    expect(observed.find((s) => s.status === 'needs-auth')).not.toHaveProperty('error');
    // `errorCode` still does not cross the SDK boundary — point 2 of the anchor,
    // now with live evidence at 0.3.268 rather than a binary read alone.
    for (const row of observed) expect(row).not.toHaveProperty('errorCode');
    expect(mcpAuthEvidenceFrom(observed)).toEqual(['probe-bearer', 'probe-tokenless', 'linear']);
  });

  it('catches all three on the 0.3.280 re-run, first frame included', async () => {
    // Provenance: `fixtures/mcp-server-status-401-0.3.280.observed.json` is the
    // same harness re-run on 2026-09-22 against 0.3.280, with a THIRD always-401
    // server declared in the cwd's `.mcp.json`. 0.3.274 stopped the first turn
    // waiting for settings-file and plugin servers whose tools tool search
    // defers, so such a server could read `pending` in the first frame again.
    // This one did not: it came up `failed` in `system/init`, beside the two
    // `options.mcpServers` ones. Rows now carry the additive `source`.
    const { mcpAuthEvidenceFrom } = await import('../mcp-revocation.js');
    const { firstInit, status } = observed280 as {
      firstInit: Array<{ name: string; status?: string; source?: string }>;
      status: Array<{ name: string; status?: string; error?: string; source?: string }>;
    };

    expect(firstInit.map((s) => s.status)).toEqual(['failed', 'failed', 'failed']);
    expect(status.find((s) => s.name === 'probe-bearer')?.error).toMatch(
      /rejected the configured Authorization header/
    );
    expect(status.find((s) => s.name === 'probe-project')?.source).toBe('project');
    for (const row of status) expect(row).not.toHaveProperty('errorCode');
    expect(mcpAuthEvidenceFrom(firstInit)).toEqual([
      'probe-project',
      'probe-bearer',
      'probe-tokenless',
    ]);
    expect(mcpAuthEvidenceFrom(status)).toEqual([
      'probe-project',
      'probe-bearer',
      'probe-tokenless',
    ]);
  });

  it('looks at every server that did not come up — `failed` above all', async () => {
    const { mcpAuthEvidenceFrom } = await import('../mcp-revocation.js');

    expect(
      mcpAuthEvidenceFrom([
        // THE headline case, and the one the first version of this feature
        // missed entirely: a server carrying a DorkOS bearer that the server
        // refuses reports `failed`, never `needs-auth`. Observed live against
        // SDK 0.3.177 — see the module doc's empirical anchor.
        { name: 'bearer-refused', status: 'failed' },
        // The tokenless refusal. Worth looking at too, but never worth trusting:
        // the CLI replays this one from a 15-minute disk cache.
        { name: 'tokenless-refused', status: 'needs-auth' },
        // Not evidence of anything. `pending` means the snapshot was taken
        // before that server finished connecting; `disabled` means nobody asked.
        { name: 'slow', status: 'pending' },
        { name: 'off', status: 'disabled' },
        { name: 'fine', status: 'connected' },
        { name: 'unreported' },
      ])
    ).toEqual(['bearer-refused', 'tokenless-refused']);
  });
});
