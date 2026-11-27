/**
 * The prompt-kind registry (DOR-4794): one kind today, every kind asks by default, and a floor
 * kind (one that always asks) carries no switch a setting could lower.
 */
import { describe, expect, it } from 'vitest';
import { PROMPT_KINDS, PROMPT_KIND_KEYS, promptKind, type PromptKind } from '../prompt-kinds.js';

const kinds: PromptKind[] = PROMPT_KIND_KEYS.map((key) => PROMPT_KINDS[key]);

describe('the prompt-kind registry', () => {
  it('holds the one kind, under its own key', () => {
    expect(PROMPT_KIND_KEYS).toEqual(['connector.write.marked-same-source']);
    for (const key of PROMPT_KIND_KEYS) expect(promptKind(key).key).toBe(key);
  });

  it('gives no floor kind a switch', () => {
    for (const kind of kinds.filter((k) => k.floor)) expect(kind.switch).toBeUndefined();
  });

  it('asks by default for every kind', () => {
    for (const kind of kinds) expect(kind.default).toBe('ask');
  });

  it('names the same-source kind’s switch, Activity line and Settings home', () => {
    expect(PROMPT_KINDS['connector.write.marked-same-source']).toMatchObject({
      floor: false,
      switch: { store: 'connection', field: 'writes_back_unasked' },
      auditKind: 'agent.same_source_write',
      settingsHome: { page: 'permissions', group: 'sending-outside' },
    });
  });
});
