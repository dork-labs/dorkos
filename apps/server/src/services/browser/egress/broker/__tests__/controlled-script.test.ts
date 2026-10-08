import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import {
  originalControlledScriptKey,
  originalControlledScriptReply,
  requireOriginalControlledScriptResult,
} from './controlled-script.fixture.js';
const nonce = '11111111-2222-3333-4444-555555555555';
// Portable producer/oracle controls only: VM execution is not native browser loading proof.
it.each(['allowed', 'denied'] as const)(
  'serves the actual named %s script whose original code supplies the execution marker',
  (role) => {
    const path = role === 'allowed' ? `/script/${nonce}.js` : `/forbidden/${nonce}/script.js`;
    const reply = originalControlledScriptReply(role, path);
    expect(reply?.contentType).toBe('application/javascript');
    if (!reply) throw new Error('ORIGINAL_SCRIPT_REPLY_REQUIRED');
    const context: Record<string, unknown> = Object.create(null);
    runInNewContext(reply.body, context);
    const key = originalControlledScriptKey(nonce, role);
    expect(
      requireOriginalControlledScriptResult(
        { outcome: 'load', marker: context[key] },
        nonce,
        'executed'
      )
    ).toEqual({ outcome: 'load', marker: nonce });
    expect(
      context[originalControlledScriptKey(nonce, role === 'allowed' ? 'denied' : 'allowed')]
    ).toBeUndefined();
  }
);
it('accepts actual denied loader result only when no named script execution marker exists', () => {
  expect(
    requireOriginalControlledScriptResult({ outcome: 'error', marker: null }, nonce, 'denied')
  ).toEqual({ outcome: 'error', marker: null });
});
it.each([
  { outcome: 'load', marker: null },
  { outcome: 'error', marker: nonce },
  { outcome: 'load', marker: 'foreign' },
])('refuses unavailable or foreign execution provenance %j', (value) => {
  expect(() => requireOriginalControlledScriptResult(value, nonce, 'executed')).toThrow();
});
it.each([
  { outcome: 'load', marker: nonce },
  { outcome: 'error', marker: nonce },
  { outcome: 'error', marker: null, inventedReceipt: true },
])('does not label execution or an extended result as denial %j', (value) => {
  expect(() => requireOriginalControlledScriptResult(value, nonce, 'denied')).toThrow();
});
it('refuses role changes and does not invent a script response for adjacent endpoints', () => {
  expect(() => originalControlledScriptReply('denied', `/script/${nonce}.js`)).toThrow(
    'CONTROLLED_SCRIPT_ROLE_REQUIRED'
  );
  expect(originalControlledScriptReply('allowed', `/script/${nonce}.js?foreign=1`)).toBeUndefined();
  expect(originalControlledScriptReply('allowed', '/adjacent.js')).toBeUndefined();
});
