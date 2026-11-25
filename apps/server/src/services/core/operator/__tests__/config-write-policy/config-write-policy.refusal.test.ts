import { describe, it, expect } from 'vitest';
import {
  OPERATOR_ONLY_CONFIG_PATHS,
  findOperatorOnlyPaths,
  operatorOnlyAreasForPatch,
} from '../../config-write-policy.js';
import { OPERATOR_ONLY_STAKES } from '../../operator-only-stakes.js';
import { describeOperatorOnlyRefusal } from '../../operator-only-refusal.js';

/**
 * A patch that writes exactly one policy path, `[]` segments turned into a
 * one-element list, so the guard sees it the way a real patch reaches it.
 */
function pathPatch(path: string): Record<string, unknown> {
  const segments = path.split('.');
  let value: unknown = 'x';
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]!;
    if (segment.endsWith('[]')) value = { [segment.slice(0, -2)]: [value] };
    else value = { [segment]: value };
  }
  return value as Record<string, unknown>;
}

describe('describeOperatorOnlyRefusal', () => {
  it('names what was refused and what to do instead', () => {
    const message = describeOperatorOnlyRefusal(['auth.enabled']);
    expect(message).toContain('auth.enabled');
    expect(message).toContain('DorkOS changed nothing');
    expect(message).toMatch(/ask the person/i);
  });

  it('keeps the reach description for the settings it is true of', () => {
    const message = describeOperatorOnlyRefusal(['auth.enabled', 'tunnel.domain']);
    expect(message).toContain(
      'Who can reach this instance, and how far it reaches on this machine'
    );
    expect(message).toContain('auth.enabled, tunnel.domain');
  });

  it('describes a raw MCP server as a tool DorkOS attaches, not as a way in', () => {
    // A configured raw-MCP server is an endpoint DorkOS reaches OUT to and hands
    // sessions as a tool. Nothing about it lets anybody in, so the inbound
    // "who can reach this instance" sentence is the wrong claim: it sits with
    // the approved lists, which is what the module's own prose says about it.
    const message = describeOperatorOnlyRefusal([
      'connectors.rawMcpServers[].url',
      'extensions.approvedToRun',
    ]);
    expect(message).toContain(
      'Which code this server runs, and which outside tools it attaches to: ' +
        'connectors.rawMcpServers[].url, extensions.approvedToRun.'
    );
    expect(message).not.toMatch(/who can reach this instance/i);
  });

  it('describes a room bound as what it is, not as a security control', () => {
    // A reply ceiling is not the login gate. Telling a model it is teaches the
    // model something false about the product (DOR-1044).
    const message = describeOperatorOnlyRefusal([
      'rooms.engagedWindowMinutes',
      'rooms.maxAgentDepth',
    ]);
    expect(message).toContain('When your agents speak on their own');
    expect(message).toContain('rooms.engagedWindowMinutes, rooms.maxAgentDepth');
    expect(message).not.toMatch(/who can reach this instance/i);
    expect(message).not.toMatch(/credentials/i);
    expect(message).not.toMatch(/leaves this machine/i);
  });

  it('describes a greeting cap as what it is', () => {
    const message = describeOperatorOnlyRefusal(['welcomeBack.maxPosts']);
    expect(message).toContain('When your agents speak on their own');
    expect(message).not.toMatch(/who can reach this instance/i);
    expect(message).not.toMatch(/credentials/i);
    expect(message).not.toMatch(/leaves this machine/i);
  });

  it('gives a mixed refusal one sentence per stake, each naming its own paths', () => {
    const message = describeOperatorOnlyRefusal([
      'auth.enabled',
      'telemetry.usage',
      'welcomeBack.enabled',
    ]);
    expect(message).toContain(
      'Who can reach this instance, and how far it reaches on this machine: auth.enabled.'
    );
    expect(message).toContain('What leaves this machine: telemetry.usage.');
    expect(message).toContain('welcomeBack.enabled.');
  });

  it('reaches the stake copy for a list the caller replaced wholesale (DOR-1113)', () => {
    // Written the long way round — patch in, refusal out — because until DOR-1113
    // the matcher never returned a `[]` path, so the clause filed for these four
    // was DEAD: correct, tested against a hand-written path list, and impossible
    // for a real caller to ever read.
    const refusedServers = findOperatorOnlyPaths({
      connectors: { rawMcpServers: [{ slug: 'evil', url: 'https://evil.test/mcp' }] },
    });
    expect(describeOperatorOnlyRefusal(refusedServers)).toContain(
      'Which code this server runs, and which outside tools it attaches to: ' +
        'connectors.rawMcpServers[].slug, connectors.rawMcpServers[].url.'
    );

    const refusedAccounts = findOperatorOnlyPaths({
      runtimes: { claudeCode: { accounts: [{ path: '/tmp/evil' }] } },
    });
    expect(describeOperatorOnlyRefusal(refusedAccounts)).toContain(
      'Which account and keys the work runs on, and who pays for it: ' +
        'runtimes.claudeCode.accounts[].path.'
    );
  });

  it('asks every operator-only setting in a floor area (spec agent-permissions D6)', () => {
    // An agent's config patch touching one of these asks the person in that
    // area on a card instead of bouncing off a flat refusal. A stake with no
    // area would leave its settings decided in DorkOS settings, which is Ask on
    // every preset but Allowed on an undecided install: never acceptable for a
    // setting only a person may change.
    for (const group of OPERATOR_ONLY_STAKES) {
      expect(['safety', 'reach', 'permissions'], group.stake).toContain(group.area);
    }
    for (const path of OPERATOR_ONLY_CONFIG_PATHS) {
      expect(operatorOnlyAreasForPatch(pathPatch(path)), path).toHaveLength(1);
    }
  });

  it('describes a memory bound as a memory bound, not as a security control', () => {
    // Warm sessions are safety-neutral — same executable, same permissions, same
    // per-dispatch boundary check — and the refusal must not imply otherwise
    // just because the setting is now refused (DOR-1044, applied to DOR-1497).
    const message = describeOperatorOnlyRefusal([
      'runtimes.claudeCode.persistentSession',
      'uploads.maxFiles',
    ]);
    expect(message).toContain(
      'How much of this machine the work may take up: ' +
        'runtimes.claudeCode.persistentSession, uploads.maxFiles.'
    );
    expect(message).not.toMatch(/who can reach this instance/i);
    expect(message).not.toMatch(/credentials/i);
    expect(message).not.toMatch(/speak on their own/i);
  });

  it('names the DM view and Show sessions as what the chat shows you (DOR-3074)', () => {
    const message = describeOperatorOnlyRefusal(['ui.dmView', 'ui.showSessions']);
    expect(message).toContain(
      'How your chats are drawn, and what they show you about the work behind them: ' +
        'ui.dmView, ui.showSessions.'
    );
    expect(operatorOnlyAreasForPatch({ ui: { showSessions: false } })).toEqual(['safety']);
  });

  it('stays honest about a path with no stake on file', () => {
    const message = describeOperatorOnlyRefusal(['some.future.setting']);
    expect(message).toContain('some.future.setting');
    expect(message).toContain('Settings the person keeps for themselves');
    expect(message).not.toMatch(/who can reach this instance/i);
  });
});
