import { describe, expect, it } from 'vitest';
import {
  ConnectorEventPayloadProtector,
  normalizeConnectorEventContent,
} from '../event-content.js';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
const key = new Uint8Array(32).fill(17);
const scope = {
  providerInstanceId: 'provider-one',
  subscriptionId: 'subscription-one',
  providerEventId: 'event-one',
  expiresAt: '2026-09-14T00:00:00.000Z',
};
const content = { version: 1 as const, title: 'New email', text: 'subject: private project' };
const now = Date.parse('2026-09-07T00:00:00.000Z');
function protector() {
  return new ConnectorEventPayloadProtector({
    activeKeyId: 'key1',
    keys: new Map([['key1', key]]),
  });
}

describe('event content protection', () => {
  it('encrypts randomized envelopes and recovers exact content after a new protector is constructed', () => {
    const first = protector().protect(content, scope);
    const second = protector().protect(content, scope);
    expect(first).not.toBe(second);
    expect(first).not.toContain('private project');
    expect(protector().reveal(first, scope, now)).toEqual(content);
  });
  it.each(['providerInstanceId', 'subscriptionId', 'providerEventId', 'expiresAt'] as const)(
    'rejects ciphertext transplanted to another %s',
    (field) => {
      const envelope = protector().protect(content, scope);
      const changed = {
        ...scope,
        [field]: field === 'expiresAt' ? '2026-09-15T00:00:00.000Z' : 'another',
      };
      expect(() => protector().reveal(envelope, changed, now)).toThrow(
        'Event content is unavailable.'
      );
    }
  );
  it('refuses expiry and tampering without leaking plaintext', () => {
    const envelope = protector().protect(content, scope);
    expect(() => protector().reveal(envelope, scope, Date.parse(scope.expiresAt))).toThrow(
      'Event content is unavailable.'
    );
    const pieces = envelope.split('.');
    pieces[4] = Buffer.from('tampered').toString('base64url');
    expect(() => protector().reveal(pieces.join('.'), scope, now)).toThrow(
      'Event content is unavailable.'
    );
  });
  it('retains only allowlisted bounded string fields', () => {
    const result = normalizeConnectorEventContent(
      { displayName: 'New email' } as ConnectorEventDefinition,
      {
        subject: 'Hello',
        token: 'secret-token',
        nested: { password: 'secret' },
        message: 'x'.repeat(9000),
        title: { nested: true },
      }
    );
    expect(result.title).toBe('New email');
    expect(result.text.startsWith('subject: Hello')).toBe(true);
    expect(result.text).not.toContain('secret');
    expect(result.text).not.toContain('nested');
    expect(result.text).toHaveLength('subject: Hello\nmessage: '.length + 8000);
  });
  it('supports old-key reads during rotation while new writes use the active key', () => {
    const old = protector().protect(content, scope);
    const rotated = new ConnectorEventPayloadProtector({
      activeKeyId: 'key2',
      keys: new Map([
        ['key1', key],
        ['key2', new Uint8Array(32).fill(23)],
      ]),
    });
    expect(rotated.reveal(old, scope, now)).toEqual(content);
    expect(rotated.protect(content, scope).startsWith('v1.key2.')).toBe(true);
  });
});
