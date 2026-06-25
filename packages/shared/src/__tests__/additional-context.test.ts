import { describe, it, expect } from 'vitest';
import {
  CONTEXT_TAG,
  ClientContextSchema,
  AdditionalContextEntrySchema,
  type ContextKind,
} from '../additional-context.js';
import { SendMessageRequestSchema } from '../schemas.js';

const ALL_KINDS: ContextKind[] = ['git_status', 'ui_state', 'queue_note', 'env', 'relay_context'];

const SAMPLE_UI_STATE = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, tasks: false, relay: false },
  sidebar: { open: true, activeTab: 'sessions' },
  agent: { id: 'abc', cwd: '/proj' },
};

describe('CONTEXT_TAG', () => {
  it('has exactly one entry per ContextKind member', () => {
    // Runtime exhaustiveness mirror of the compile-time `satisfies` check.
    expect(Object.keys(CONTEXT_TAG).sort()).toEqual([...ALL_KINDS].sort());
    expect(Object.keys(CONTEXT_TAG)).toHaveLength(ALL_KINDS.length);
  });

  it('maps each kind to a non-empty tag name', () => {
    for (const kind of ALL_KINDS) {
      expect(CONTEXT_TAG[kind]).toBeTypeOf('string');
      expect(CONTEXT_TAG[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('ClientContextSchema', () => {
  it('accepts { uiState, queued: true }', () => {
    const parsed = ClientContextSchema.parse({ uiState: SAMPLE_UI_STATE, queued: true });
    expect(parsed.queued).toBe(true);
    expect(parsed.uiState).toBeDefined();
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(ClientContextSchema.parse({})).toEqual({});
  });

  it('accepts { queued: true } with no uiState', () => {
    expect(ClientContextSchema.parse({ queued: true })).toEqual({ queued: true });
  });

  it('rejects a malformed uiState shape', () => {
    const result = ClientContextSchema.safeParse({ uiState: { canvas: 'nope' } });
    expect(result.success).toBe(false);
  });
});

describe('AdditionalContextEntrySchema', () => {
  it('validates a git_status entry', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'git_status',
      scope: 'per-turn',
      data: { isRepo: true, branch: 'main', clean: true },
    });
    expect(result.success).toBe(true);
  });

  it('validates a queue_note entry', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'queue_note',
      scope: 'per-turn',
      data: { composedDuringPrevTurn: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    const result = AdditionalContextEntrySchema.safeParse({
      kind: 'bogus',
      scope: 'per-turn',
      data: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('SendMessageRequestSchema context wiring (DOR migration)', () => {
  it('accepts { content, context: { uiState, queued: true } }', () => {
    const result = SendMessageRequestSchema.safeParse({
      content: 'hi',
      context: { uiState: SAMPLE_UI_STATE, queued: true },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.context?.queued).toBe(true);
  });

  it('no longer carries a top-level uiState field (it lives in context)', () => {
    const result = SendMessageRequestSchema.parse({
      content: 'hi',
      uiState: SAMPLE_UI_STATE,
    });
    // The standalone `uiState` key is gone from the schema — Zod strips it.
    expect(result).not.toHaveProperty('uiState');
    expect(result.content).toBe('hi');
  });

  it('accepts a bare content message with no context', () => {
    const result = SendMessageRequestSchema.safeParse({ content: 'hi' });
    expect(result.success).toBe(true);
  });
});
