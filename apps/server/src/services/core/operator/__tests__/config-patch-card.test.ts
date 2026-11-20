/**
 * The `config_patch` approval card lists every setting, riskiest first, in an
 * order the agent cannot choose (DOR-4775).
 */
import { describe, it, expect } from 'vitest';
import {
  CONFIG_PATCH_DETAIL_MAX_LENGTH,
  CONFIG_PATCH_STAKE_RANK,
  CONFIG_PATCH_SENTENCE_NAMES_MAX_LENGTH,
  configPatchCardFits,
  describePatchDetail,
  describePatchLines,
  describePatchSentence,
} from '../config-patch-card.js';
import { OPERATOR_ONLY_STAKES } from '../operator-only-stakes.js';

describe('describePatchLines', () => {
  it('puts a risky key first however many long harmless keys come before it', () => {
    const ui: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) ui[`someLongHarmlessSettingName${i}`] = 'y'.repeat(70);
    const patch = { ui, tunnel: { enabled: true } };

    const lines = describePatchDetail(patch).split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe('tunnel.enabled: yes (needs you)');
    for (let i = 0; i < 20; i++) {
      expect(lines).toContain(`ui.someLongHarmlessSettingName${i}: "${'y'.repeat(70)}"`);
    }
    expect(describePatchSentence(patch)).toBe(
      'wants to change 21 settings. 1 needs you: tunnel.enabled'
    );
  });

  it('orders by rank, 0 to 5, then by path, never by the agent’s order', () => {
    // One key per rank, sent in reverse, plus a tie at the bottom.
    const patch = {
      ui: { zeta: 1, alpha: 2 },
      rooms: { maxAgentDepth: 9 },
      runtimes: { codex: { binaryPath: '/bin/codex' }, defaultTrustStop: 'ask' },
      tunnel: { enabled: true },
      cloud: { credits: { offer: true } },
    };
    expect(describePatchLines(patch)).toEqual([
      'cloud.credits.offer: yes (needs you)',
      'tunnel.enabled: yes (needs you)',
      'runtimes.defaultTrustStop: "ask" (needs you)',
      'runtimes.codex.binaryPath: "/bin/codex" (needs you)',
      'rooms.maxAgentDepth: 9 (needs you)',
      'ui.alpha: 2',
      'ui.zeta: 1',
    ]);
    expect(describePatchSentence(patch)).toBe(
      'wants to change 7 settings. 5 need you: credits.offer, tunnel.enabled, runtimes.defaultTrustStop and 2 more'
    );
  });

  it('ranks every stake on file', () => {
    for (const group of OPERATOR_ONLY_STAKES) {
      expect(CONFIG_PATCH_STAKE_RANK[group.stake]).toBeGreaterThanOrEqual(0);
      expect(CONFIG_PATCH_STAKE_RANK[group.stake]).toBeLessThan(5);
    }
  });

  it('says a secret is set, never what it is, and names a list’s items', () => {
    const lines = describePatchLines({
      providers: { x: { apiKey: 'sk-live-very-secret' } },
      ui: { statusBar: { pins: ['a', 'b'] } },
    });
    expect(lines).toEqual(['providers.x.apiKey: set (needs you)', 'ui.statusBar.pins: "a", "b"']);
    expect(lines.join('\n')).not.toContain('sk-live');
  });

  it('caps a long value but keeps the key', () => {
    const [line] = describePatchLines({ ui: { theme: 'z'.repeat(500) } });
    expect(line!.startsWith('ui.theme: "zzz')).toBe(true);
    expect(line!.endsWith('…')).toBe(true);
    expect(line!.length).toBeLessThanOrEqual('ui.theme: '.length + 80);
  });

  it('names each setting in the sentence by its last two plain parts, never cut', () => {
    expect(
      describePatchSentence({
        runtimes: {
          claudeCode: { projectAccounts: { '/tmp/made-up/client.app': { allow: ['work'] } } },
          doe: { inference: { credentialEndpoint: 'https://keys.example.test/v1' } },
        },
      })
    ).toBe(
      'wants to change 2 settings. 2 need you: projectAccounts.allow, inference.credentialEndpoint'
    );
    // A long name is shown whole; the detail under it gives the full path.
    const own = `${'acct-'.repeat(40)}end`;
    const sentence = describePatchSentence({
      providers: { [own]: { label: 'x' } },
      tunnel: { enabled: true },
    });
    expect(sentence).toBe(`wants to change 2 settings. 2 need you: ${own}.label, tunnel.enabled`);
    expect(sentence).not.toContain('…');
  });

  it('counts a name too long for the sentence rather than cutting it', () => {
    const huge = 'n'.repeat(CONFIG_PATCH_SENTENCE_NAMES_MAX_LENGTH);
    expect(describePatchSentence({ providers: { [huge]: { label: 'x' } } })).toBe(
      'wants to change 1 setting. 1 needs you, listed below'
    );
    expect(describePatchSentence({ ui: { [huge]: 1 } })).toBe(
      'wants to change 1 setting, listed below'
    );
  });

  it('never cuts the value of a person’s setting, however long (DOR-4778)', () => {
    const domain = `${'north-shop.'.repeat(30)}example.test`;
    const [line] = describePatchLines({ tunnel: { domain } });
    expect(line).toBe(`tunnel.domain: "${domain}" (needs you)`);
  });

  it('sweeps a token-shaped value before cutting it, so no prefix of it survives', () => {
    // 60 harmless characters, then a 40-character hex run the 80-character cut would split.
    const [line] = describePatchLines({ ui: { theme: `${'q'.repeat(60)}${'f'.repeat(40)}` } });
    expect(line).not.toContain('ffff');
  });

  it('says nothing for an empty patch', () => {
    expect(describePatchSentence({})).toBe('wants to change nothing');
    expect(describePatchDetail({})).toBe('');
    expect(describePatchSentence({ ui: { theme: 'dark' } })).toBe(
      'wants to change 1 setting: ui.theme'
    );
  });
});

describe('a key or value that tries to forge a line', () => {
  it('cannot start a line with a setting it is not', () => {
    const patch = {
      'a\ntunnel.enabled: no': true,
      ui: { theme: 'x\ntunnel.enabled: no' },
      tunnel: { enabled: true },
    };
    const detail = describePatchDetail(patch);
    const lines = detail.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith('tunnel.enabled'))).toEqual([
      'tunnel.enabled: yes (needs you)',
    ]);
    expect(lines).toContain('["a\\ntunnel.enabled: no"]: yes');
    expect(lines).toContain('ui.theme: "x\\ntunnel.enabled: no"');
    for (const line of describePatchLines(patch)) expect(line).not.toMatch(/[\n\r\u2028\u2029]/);
  });

  it('escapes the other characters that break or reorder a line', () => {
    const lines = describePatchLines({ ui: { 'a b': 'c‮d' } });
    expect(lines).toEqual(['ui["a\\u2028b"]: "c\\u202ed"']);
  });
});

describe('describePatchDetail on a large patch', () => {
  it('keeps every one of 200 keys and stays under the cap', () => {
    const ui: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) ui[`setting${String(i).padStart(3, '0')}`] = 'v'.repeat(80);
    const detail = describePatchDetail({ ui });
    expect(detail.length).toBeLessThanOrEqual(CONFIG_PATCH_DETAIL_MAX_LENGTH);
    for (let i = 0; i < 200; i++) {
      expect(detail).toContain(`ui.setting${String(i).padStart(3, '0')}`);
    }
  });

  it('drops values from the harmless end first, keeping every path and the risky values', () => {
    const ui: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) ui[`setting${String(i).padStart(3, '0')}`] = 'v'.repeat(80);
    const detail = describePatchDetail({ ui, tunnel: { enabled: true } });
    expect(detail.length).toBeLessThanOrEqual(CONFIG_PATCH_DETAIL_MAX_LENGTH);
    const lines = detail.split('\n');
    expect(lines).toHaveLength(301);
    expect(lines[0]).toBe('tunnel.enabled: yes (needs you)');
    expect(lines[300]).toBe('ui.setting299');
    expect(configPatchCardFits({ ui, tunnel: { enabled: true } })).toBe(true);
  });

  it('never shortens a setting’s name, however long', () => {
    const name = `acct${'n'.repeat(400)}`;
    const patch = { providers: { [name]: { label: 'x' } }, ui: { theme: 'dark' } };
    const lines = describePatchDetail(patch).split('\n');
    expect(lines[0]).toBe(`providers.${name}.label: "x" (needs you)`);
    expect(describePatchDetail(patch)).not.toContain('…');
    expect(configPatchCardFits(patch)).toBe(true);
  });

  it('refuses a patch that would need a person-only name shortened to fit', () => {
    const name = `acct${'n'.repeat(CONFIG_PATCH_DETAIL_MAX_LENGTH)}`;
    const patch = { providers: { [name]: { label: 'x' } } };
    expect(configPatchCardFits(patch)).toBe(false);
    // Nothing of a person's setting is shortened to make it fit: it is refused whole.
    expect(describePatchDetail(patch)).toBe(`providers.${name}.label: "x" (needs you)`);
  });

  it('drops only an agent’s own values to fit, never a person’s, and refuses when that is not enough', () => {
    const ui: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) ui[`setting${String(i).padStart(3, '0')}`] = 'v'.repeat(80);
    const domain = `${'north-shop.'.repeat(Math.floor((CONFIG_PATCH_DETAIL_MAX_LENGTH - 4000) / 11))}test`;
    const fits = { ui, tunnel: { domain } };
    const lines = describePatchDetail(fits).split('\n');
    expect(lines[0]).toBe(`tunnel.domain: "${domain}" (needs you)`);
    expect(lines.slice(1).every((line) => line.startsWith('ui.setting'))).toBe(true);
    expect(configPatchCardFits(fits)).toBe(true);

    const bigger = `${'north-shop.'.repeat(400)}${domain}`;
    const tooBig = { ui, tunnel: { domain: bigger } };
    expect(configPatchCardFits(tooBig)).toBe(false);
    expect(describePatchDetail(tooBig).split('\n')[0]).toBe(
      `tunnel.domain: "${bigger}" (needs you)`
    );
  });

  it('says a patch too large to list in full does not fit, so it is refused before any card', () => {
    const ui: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) ui[`setting${String(i).padStart(4, '0')}`] = 1;
    expect(configPatchCardFits({ ui })).toBe(false);
    expect(describePatchDetail({ ui })).not.toMatch(/more not shown/);
  });
});

describe('old → new against the stored config (DOR-4775 PR 2)', () => {
  const stored = {
    tunnel: { enabled: false, domain: null },
    ui: { theme: 'light' },
    providers: { x: { apiKey: 'sk-live-old-secret-value' } },
    runtimes: {
      claudeCode: {
        accounts: [
          { id: 'work', label: 'Work', path: '/tmp/made-up/.claude-work' },
          { id: 'side', label: null, path: '/tmp/made-up/.claude-side' },
        ],
        projectAccounts: { '/tmp/made-up/client.app': { allow: ['default', 'work'] } },
      },
      doe: { inference: { credentialEndpoint: 'https://old.example.test/token' } },
    },
    connectors: {
      rawMcpServers: [
        {
          slug: 'notes',
          displayName: 'Notes',
          url: 'https://notes.example.test/mcp',
          transport: 'http',
        },
        {
          slug: 'old',
          displayName: 'Old tool',
          url: 'https://old.example.test/mcp',
          transport: 'sse',
        },
      ],
    },
  };

  it('reads each value against the one it replaces, and says when nothing changes', () => {
    expect(
      describePatchLines(
        { tunnel: { enabled: true, domain: 'shop.example.test' }, ui: { theme: 'light' } },
        stored
      )
    ).toEqual([
      'tunnel.domain: null → "shop.example.test" (needs you)',
      'tunnel.enabled: no → yes (needs you)',
      'ui.theme: "light" (no change)',
    ]);
    expect(describePatchLines({ ui: { density: 'compact' } }, stored)).toEqual([
      'ui.density: not set → "compact"',
    ]);
  });

  it('says a secret is set, changed or cleared, and never shows either value', () => {
    const lines = [
      ...describePatchLines({ providers: { x: { apiKey: 'sk-live-new-secret-value' } } }, stored),
      ...describePatchLines({ providers: { x: { apiKey: null } } }, stored),
      ...describePatchLines({ providers: { y: { apiKey: 'sk-live-new-secret-value' } } }, stored),
      ...describePatchLines({ providers: { x: { apiKey: 'sk-live-old-secret-value' } } }, stored),
    ];
    expect(lines).toEqual([
      'providers.x.apiKey: changed (needs you)',
      'providers.x.apiKey: cleared (needs you)',
      'providers.y.apiKey: set (needs you)',
      'providers.x.apiKey: no change (needs you)',
    ]);
    expect(lines.join('\n')).not.toMatch(/sk-live|secret-value/);
  });

  it('shows where a credential endpoint points, leaving off any sign-in or query', () => {
    const [line] = describePatchLines(
      {
        runtimes: {
          doe: {
            inference: {
              credentialEndpoint: 'https://user:hunter2@new.example.test/token?key=abc123',
            },
          },
        },
      },
      stored
    );
    expect(line).toBe(
      'runtimes.doe.inference.credentialEndpoint: "https://old.example.test/token" → "https://new.example.test/token…" (needs you)'
    );
    expect(line).not.toMatch(/hunter2|abc123|user/);
  });

  it('keeps any other secret-named address a secret, since a token can sit in its path', () => {
    const hook = 'https://hooks.example.test/services/T000/B000/made-up-path-token';
    const lines = describePatchLines(
      { relay: { slack: { tokenUrl: hook, secretEndpoint: hook } } },
      { relay: { slack: { tokenUrl: 'https://hooks.example.test/old-path-token' } } }
    );
    expect(lines.map((line) => line.replace(' (needs you)', ''))).toEqual([
      'relay.slack.secretEndpoint: set',
      'relay.slack.tokenUrl: changed',
    ]);
    expect(lines.join('\n')).not.toMatch(/path-token|hooks\.example/);
  });

  it('lists the servers a patch adds, changes and removes, by name and address', () => {
    const [line] = describePatchLines(
      {
        connectors: {
          rawMcpServers: [
            {
              slug: 'notes',
              displayName: 'Notes',
              url: 'https://elsewhere.example.test/mcp',
              transport: 'http',
            },
            {
              slug: 'crm',
              displayName: 'CRM',
              url: 'https://crm.example.test/mcp',
              transport: 'http',
            },
          ],
        },
      },
      stored
    );
    expect(line).toBe(
      'connectors.rawMcpServers: changes "Notes" at "https://elsewhere.example.test/mcp", ' +
        'adds "CRM" at "https://crm.example.test/mcp", ' +
        'removes "Old tool" at "https://old.example.test/mcp" (needs you)'
    );
  });

  it('names the accounts a project limit adds and removes by label, Main included', () => {
    const [line] = describePatchLines(
      {
        runtimes: {
          claudeCode: {
            projectAccounts: { '/tmp/made-up/client.app': { allow: ['side', 'work'] } },
          },
        },
      },
      stored
    );
    expect(line).toBe(
      'runtimes.claudeCode.projectAccounts["/tmp/made-up/client.app"].allow: adds "side", removes "Main" (needs you)'
    );
    const [unknown] = describePatchLines(
      {
        runtimes: { claudeCode: { projectAccounts: { '/tmp/made-up/new': { allow: ['work'] } } } },
      },
      stored
    );
    expect(unknown).toBe(
      'runtimes.claudeCode.projectAccounts["/tmp/made-up/new"].allow: adds "Work" (needs you)'
    );
  });

  it('measures the longer old → new card when deciding whether it fits', () => {
    const long = 'v'.repeat(Math.floor(CONFIG_PATCH_DETAIL_MAX_LENGTH / 2) + 10);
    const patch = { tunnel: { domain: long } };
    expect(configPatchCardFits(patch)).toBe(true);
    expect(configPatchCardFits(patch, { tunnel: { domain: `${long}x` } })).toBe(false);
  });
});
