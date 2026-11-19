/**
 * The `config_patch` approval card lists every setting, riskiest first, in an
 * order the agent cannot choose (DOR-4775).
 */
import { describe, it, expect } from 'vitest';
import {
  CONFIG_PATCH_DETAIL_MAX_LENGTH,
  CONFIG_PATCH_STAKE_RANK,
  configPatchCardFits,
  describePatchDetail,
  describePatchLines,
  describePatchSummary,
} from '../config-patch-card.js';
import { OPERATOR_ONLY_STAKES } from '../operator-only-stakes.js';

describe('describePatchLines', () => {
  it('puts a risky key first however many long harmless keys come before it', () => {
    const ui: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) ui[`someLongHarmlessSettingName${i}`] = 'y'.repeat(70);
    const patch = { ui, tunnel: { enabled: true } };

    const lines = describePatchDetail(patch).split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe('tunnel.enabled: yes');
    for (let i = 0; i < 20; i++) {
      expect(lines).toContain(`ui.someLongHarmlessSettingName${i}: "${'y'.repeat(70)}"`);
    }
    expect(describePatchSummary(patch)).toBe('21 settings, 1 needs you');
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
      'cloud.credits.offer: yes',
      'tunnel.enabled: yes',
      'runtimes.defaultTrustStop: "ask"',
      'runtimes.codex.binaryPath: "/bin/codex"',
      'rooms.maxAgentDepth: 9',
      'ui.alpha: 2',
      'ui.zeta: 1',
    ]);
    expect(describePatchSummary(patch)).toBe('7 settings, 5 need you');
  });

  it('ranks every stake on file', () => {
    for (const group of OPERATOR_ONLY_STAKES) {
      expect(CONFIG_PATCH_STAKE_RANK[group.stake]).toBeGreaterThanOrEqual(0);
      expect(CONFIG_PATCH_STAKE_RANK[group.stake]).toBeLessThan(5);
    }
  });

  it('lists a secret-named leaf and a list by path only', () => {
    const lines = describePatchLines({
      providers: { x: { apiKey: 'sk-live-very-secret' } },
      ui: { statusBar: { pins: ['a', 'b'] } },
    });
    expect(lines).toEqual(['providers.x.apiKey', 'ui.statusBar.pins']);
    expect(lines.join('\n')).not.toContain('sk-live');
  });

  it('caps a long value but keeps the key', () => {
    const [line] = describePatchLines({ ui: { theme: 'z'.repeat(500) } });
    expect(line!.startsWith('ui.theme: "zzz')).toBe(true);
    expect(line!.endsWith('…')).toBe(true);
    expect(line!.length).toBeLessThanOrEqual('ui.theme: '.length + 80);
  });

  it('sweeps a token-shaped value before cutting it, so no prefix of it survives', () => {
    // 60 harmless characters, then a 40-character hex run the 80-character cut would split.
    const [line] = describePatchLines({ ui: { theme: `${'q'.repeat(60)}${'f'.repeat(40)}` } });
    expect(line).not.toContain('ffff');
  });

  it('says nothing for an empty patch', () => {
    expect(describePatchSummary({})).toBe('nothing');
    expect(describePatchDetail({})).toBe('');
    expect(describePatchSummary({ ui: { theme: 'dark' } })).toBe('1 setting');
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
      'tunnel.enabled: yes',
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
    expect(lines[0]).toBe('tunnel.enabled: yes');
    expect(lines[300]).toBe('ui.setting299');
    expect(configPatchCardFits({ ui, tunnel: { enabled: true } })).toBe(true);
  });

  it('says a patch too large to list in full does not fit, so it is refused before any card', () => {
    const ui: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) ui[`setting${String(i).padStart(4, '0')}`] = 1;
    expect(configPatchCardFits({ ui })).toBe(false);
    expect(describePatchDetail({ ui })).not.toMatch(/more not shown/);
  });
});
