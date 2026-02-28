import { describe, it, expect } from 'vitest';
import {
  SessionStrategySchema,
  AdapterBindingSchema,
  CreateBindingRequestSchema,
  BindingListResponseSchema,
  BindingResponseSchema,
} from '../relay-schemas.js';

describe('SessionStrategySchema', () => {
  it('accepts valid strategies', () => {
    expect(SessionStrategySchema.parse('per-chat')).toBe('per-chat');
    expect(SessionStrategySchema.parse('per-user')).toBe('per-user');
    expect(SessionStrategySchema.parse('stateless')).toBe('stateless');
  });

  it('rejects invalid strategies', () => {
    expect(() => SessionStrategySchema.parse('invalid')).toThrow();
    expect(() => SessionStrategySchema.parse('')).toThrow();
    expect(() => SessionStrategySchema.parse(123)).toThrow();
  });
});

describe('AdapterBindingSchema', () => {
  const validBinding = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    adapterId: 'telegram-main',
    agentId: 'agent-1',
    agentDir: '/home/user/agents/alpha',
    sessionStrategy: 'per-chat',
    label: 'Main bot',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('validates a complete binding', () => {
    expect(AdapterBindingSchema.parse(validBinding)).toEqual(validBinding);
  });

  it('accepts optional chatId and channelType', () => {
    const binding = {
      ...validBinding,
      chatId: '12345',
      channelType: 'dm',
      sessionStrategy: 'per-user',
    };
    expect(AdapterBindingSchema.parse(binding)).toEqual(binding);
  });

  it('rejects invalid UUID for id', () => {
    expect(() =>
      AdapterBindingSchema.parse({ ...validBinding, id: 'not-a-uuid' }),
    ).toThrow();
  });

  it('rejects invalid channelType', () => {
    expect(() =>
      AdapterBindingSchema.parse({ ...validBinding, channelType: 'invalid' }),
    ).toThrow();
  });

  it('rejects invalid datetime for createdAt', () => {
    expect(() =>
      AdapterBindingSchema.parse({ ...validBinding, createdAt: 'not-a-date' }),
    ).toThrow();
  });
});

describe('CreateBindingRequestSchema', () => {
  it('applies defaults for sessionStrategy and label', () => {
    const input = {
      adapterId: 'telegram-main',
      agentId: 'agent-1',
      agentDir: '/home/user/agents/alpha',
    };
    const parsed = CreateBindingRequestSchema.parse(input);
    expect(parsed.sessionStrategy).toBe('per-chat');
    expect(parsed.label).toBe('');
  });

  it('does not include id, createdAt, or updatedAt in output', () => {
    const input = {
      id: 'should-not-be-here',
      adapterId: 'telegram-main',
      agentId: 'agent-1',
      agentDir: '/home/user/agents/alpha',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const parsed = CreateBindingRequestSchema.parse(input);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('createdAt');
    expect(parsed).not.toHaveProperty('updatedAt');
  });

  it('accepts optional chatId and channelType', () => {
    const input = {
      adapterId: 'telegram-main',
      agentId: 'agent-1',
      agentDir: '/home/user/agents/alpha',
      chatId: '12345',
      channelType: 'group',
    };
    const parsed = CreateBindingRequestSchema.parse(input);
    expect(parsed.chatId).toBe('12345');
    expect(parsed.channelType).toBe('group');
  });
});

describe('BindingListResponseSchema', () => {
  it('validates a list response with bindings', () => {
    const response = {
      bindings: [
        {
          id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          adapterId: 'telegram-main',
          agentId: 'agent-1',
          agentDir: '/agents/alpha',
          sessionStrategy: 'per-chat',
          label: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    expect(BindingListResponseSchema.parse(response)).toEqual(response);
  });

  it('validates an empty list response', () => {
    expect(BindingListResponseSchema.parse({ bindings: [] })).toEqual({ bindings: [] });
  });
});

describe('BindingResponseSchema', () => {
  it('validates a single binding response', () => {
    const response = {
      binding: {
        id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        adapterId: 'telegram-main',
        agentId: 'agent-1',
        agentDir: '/agents/alpha',
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    expect(BindingResponseSchema.parse(response)).toEqual(response);
  });
});
