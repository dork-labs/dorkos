import { describe, expect, it, vi } from 'vitest';
import { AccountsAccessContext, formatAccountsAccess } from '../accounts-access-context.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../connectors/runtime-capability-scope.js';
import { buildCodexPrompt } from '../../codex/turn-input.js';
import { buildOpenCodeParts } from '../../opencode/messaging/turn-input.js';
import { renderContextEntry } from '../../claude-code/messaging/context-builder.js';

const TURN = { serviceCatalog: true } as const;

describe('Accounts turn awareness', () => {
  it('coalesces snapshots per agent/session and never acknowledges undelivered or failed context', async () => {
    let revision = 'one';
    const read = vi.fn(async () => ({ accountCount: 1, revision }));
    const tools = { accessSnapshot: read } as unknown as ConnectorRuntimeTools;
    const gate = new AccountsAccessContext();
    const first = await gate.select(tools, 'agent', 'existing-session', TURN);
    expect(first.entry.data).toEqual({ accountCount: 1, changed: false, serviceCatalog: true });
    first.commit();
    revision = 'two';
    expect((await gate.select(tools, 'agent', 'existing-session', TURN)).entry.data).toEqual({
      accountCount: 1,
      changed: true,
      serviceCatalog: true,
    });
    // No commit models a failed dispatch. The notice remains owed.
    const delivered = await gate.select(tools, 'agent', 'existing-session', TURN);
    expect(delivered.entry.data).toMatchObject({ changed: true });
    delivered.commit();
    expect((await gate.select(tools, 'agent', 'existing-session', TURN)).entry.data).toMatchObject({
      changed: false,
    });
    expect((await gate.select(tools, 'agent', 'other-session', TURN)).entry.data).toMatchObject({
      changed: false,
    });
    read.mockRejectedValueOnce(new Error('private error'));
    expect((await gate.select(tools, 'agent', 'existing-session', TURN)).entry.data).toEqual({
      accountCount: null,
      changed: false,
      serviceCatalog: true,
    });
    expect(read).toHaveBeenCalledWith('agent', 'existing-session');
  });

  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'renders the registered capability names for %s',
    (runtime) => {
      const text = formatAccountsAccess(
        { accountCount: 1, changed: true, serviceCatalog: true },
        runtime
      );
      for (const id of CONNECTOR_RUNTIME_CAPABILITY_IDS) {
        const name =
          runtime === 'claude-code'
            ? `mcp__dorkos__${id}`
            : runtime === 'codex'
              ? `mcp__dorkos_connections__${id}`
              : `dorkos_connections_${id.replaceAll('.', '_')}`;
        expect(text).toContain(name);
      }
      expect(text).toContain('profile lookup cannot list messages');
      expect(text).not.toContain('dorkos capabilities');
      // Service names are discoverable, never guessed: the in-session catalog tool
      // is named with this runtime's prefix for the `dorkos` server.
      expect(text).toContain(
        runtime === 'opencode'
          ? 'dorkos_connector_list_toolkits'
          : 'mcp__dorkos__connector_list_toolkits'
      );
      expect(text).toContain('A command-line login in a shell');
    }
  );

  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'names no lookup tool for %s when this turn did not attach the dorkos server',
    (runtime) => {
      for (const serviceCatalog of [false, undefined]) {
        const text = formatAccountsAccess(
          { accountCount: 0, changed: false, ...(serviceCatalog === false && { serviceCatalog }) },
          runtime
        );
        expect(text).not.toContain('connector_list_toolkits');
        expect(text).toContain('do not guess one');
        expect(text).toContain('A command-line login in a shell');
      }
    }
  );

  it('delivers the same fresh account facts through all three real turn renderers', () => {
    const entry = {
      kind: 'accounts_access',
      scope: 'per-turn',
      data: { accountCount: 0, changed: true },
    } as const;
    const outputs = [
      renderContextEntry(entry),
      buildCodexPrompt('question', { additionalContext: [entry] } as never),
      JSON.stringify(buildOpenCodeParts('question', { additionalContext: [entry] } as never)),
    ];
    for (const output of outputs) {
      expect(output).toContain('Currently granted accounts for this agent session: 0');
      expect(output).toContain('Access changed');
    }
  });
});
