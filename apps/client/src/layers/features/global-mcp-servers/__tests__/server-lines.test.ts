import { describe, expect, it } from 'vitest';
import { createMockGlobalMcpServer } from '@dorkos/test-utils';
import {
  fieldLine,
  savedSecretCount,
  scopeLine,
  unencryptedSecretHeaders,
  wasNotConfirmed,
} from '../lib/server-lines';

const NAMES: Record<string, string> = { a: 'Atlas', b: 'Scout', c: 'Quill' };
const nameOf = (id: string) => NAMES[id];

describe('scopeLine', () => {
  it('names who a server skips, then counts the rest', () => {
    expect(scopeLine([], nameOf)).toBe('All agents');
    expect(scopeLine(['a'], nameOf)).toBe('All agents except Atlas');
    expect(scopeLine(['a', 'b', 'c'], nameOf)).toBe('All agents except Atlas, Scout +1 more');
  });

  it('counts an agent that is gone, and never shows its id', () => {
    expect(scopeLine(['gone-id'], nameOf)).toBe('All agents except 1');
    expect(scopeLine(['a', 'gone-id'], nameOf)).toBe('All agents except Atlas +1 more');
  });
});

describe('fieldLine', () => {
  it('masks a secret, which has no value to show', () => {
    expect(fieldLine({ name: 'MADE_UP_KEY', secret: true })).toBe('MADE_UP_KEY=••••••••');
    expect(fieldLine({ name: 'REGION', secret: false, value: 'eu' })).toBe('REGION=eu');
  });
});

describe('savedSecretCount', () => {
  it('counts env and header secrets', () => {
    expect(savedSecretCount(createMockGlobalMcpServer())).toBe(0);
    expect(
      savedSecretCount(
        createMockGlobalMcpServer({
          env: [
            { name: 'A_KEY', secret: true },
            { name: 'REGION', secret: false, value: 'eu' },
          ],
          headers: [{ name: 'Authorization', secret: true }],
        })
      )
    ).toBe(2);
  });
});

describe('unencryptedSecretHeaders', () => {
  const server = (url: string, secret = true) =>
    createMockGlobalMcpServer({
      transport: 'http',
      url,
      headers: [{ name: 'Authorization', secret, ...(secret ? {} : { value: 'x' }) }],
    });

  it('names a secret header going to a plain address off this computer', () => {
    expect(unencryptedSecretHeaders(server('http://mcp.example.test/v1'))).toEqual([
      'Authorization',
    ]);
  });

  it('says nothing for https, this computer, or no secret', () => {
    expect(unencryptedSecretHeaders(server('https://mcp.example.test'))).toEqual([]);
    expect(unencryptedSecretHeaders(server('http://localhost:3000'))).toEqual([]);
    expect(unencryptedSecretHeaders(server('http://127.0.0.1:3000'))).toEqual([]);
    expect(unencryptedSecretHeaders(server('http://[::1]:3000'))).toEqual([]);
    expect(unencryptedSecretHeaders(server('http://mcp.example.test', false))).toEqual([]);
  });

  it('a local-looking name on a real host still counts', () => {
    expect(unencryptedSecretHeaders(server('http://localhost.example.test'))).toEqual([
      'Authorization',
    ]);
  });
});

describe('wasNotConfirmed', () => {
  it('reads the held action’s refusal, and nothing else', () => {
    expect(wasNotConfirmed(Object.assign(new Error('x'), { code: 'step_up_required' }))).toBe(true);
    expect(wasNotConfirmed(Object.assign(new Error('x'), { code: 'name_taken' }))).toBe(false);
    expect(wasNotConfirmed(null)).toBe(false);
  });
});
