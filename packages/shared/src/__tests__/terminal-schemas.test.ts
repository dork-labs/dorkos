import { describe, it, expect } from 'vitest';
import {
  CreateTerminalRequestSchema,
  CreateTerminalResponseSchema,
  TerminalClientMessageSchema,
} from '../terminal-schemas.js';

/**
 * Round-trip and boundary tests for the terminal wire schemas — they guard the
 * REST create/teardown contract and the WebSocket control-message grammar
 * against silent drift.
 */
describe('terminal-schemas', () => {
  it('accepts a create request with and without an initial size', () => {
    expect(CreateTerminalRequestSchema.parse({ cwd: '/repo' })).toEqual({ cwd: '/repo' });
    const withSize = CreateTerminalRequestSchema.parse({
      cwd: '/repo',
      size: { cols: 120, rows: 40 },
    });
    expect(withSize.size).toEqual({ cols: 120, rows: 40 });
  });

  it('rejects an empty cwd and a non-positive viewport', () => {
    // A terminal must spawn somewhere, and a zero/negative grid is nonsensical.
    expect(CreateTerminalRequestSchema.safeParse({ cwd: '' }).success).toBe(false);
    expect(
      CreateTerminalRequestSchema.safeParse({ cwd: '/repo', size: { cols: 0, rows: 24 } }).success
    ).toBe(false);
  });

  it('round-trips the create response', () => {
    expect(CreateTerminalResponseSchema.parse({ id: 'abc' })).toEqual({ id: 'abc' });
  });

  it('discriminates input and resize control messages', () => {
    expect(TerminalClientMessageSchema.parse({ type: 'input', data: 'ls\r' })).toEqual({
      type: 'input',
      data: 'ls\r',
    });
    expect(TerminalClientMessageSchema.parse({ type: 'resize', cols: 80, rows: 24 })).toEqual({
      type: 'resize',
      cols: 80,
      rows: 24,
    });
  });

  it('rejects an unknown control-message type', () => {
    expect(TerminalClientMessageSchema.safeParse({ type: 'kill' }).success).toBe(false);
  });
});
