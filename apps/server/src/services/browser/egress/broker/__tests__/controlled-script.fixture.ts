import { z } from 'zod';
import type { OriginalQuickTunnelReply } from './quick-tunnel-preflight.fixture.js';

const nonceSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const resultSchema = z.strictObject({
  outcome: z.enum(['load', 'error']),
  marker: z.string().max(36).nullable(),
});
/** One unique execution key; neither endpoint reports nor injected page evaluation sets its value. */
export function originalControlledScriptKey(nonce: string, role: 'allowed' | 'denied'): string {
  nonceSchema.parse(nonce);
  if (role !== 'allowed' && role !== 'denied') throw new Error('CONTROLLED_SCRIPT_ROLE_REQUIRED');
  return '__dorkosControlledScript_' + role + '_' + nonce.replaceAll('-', '');
}
/** Genuine owned endpoint JavaScript only for the named allowed/denied script routes. */
export function originalControlledScriptReply(
  role: 'allowed' | 'denied',
  path: string
): OriginalQuickTunnelReply | undefined {
  const allowed = /^\/script\/([a-f0-9-]{36})\.js$/u.exec(path);
  const denied = /^\/forbidden\/([a-f0-9-]{36})\/script\.js$/u.exec(path);
  const nonce = allowed?.[1] ?? denied?.[1];
  if (nonce === undefined) return;
  if ((allowed && role !== 'allowed') || (denied && role !== 'denied'))
    throw new Error('CONTROLLED_SCRIPT_ROLE_REQUIRED');
  const key = originalControlledScriptKey(nonce, role);
  return Object.freeze({
    status: 200,
    contentType: 'application/javascript',
    body: `globalThis[${JSON.stringify(key)}] = ${JSON.stringify(nonce)};`,
  });
}
/** Decode actual load/error and execution marker; an upstream request alone cannot prove execution. */
export function requireOriginalControlledScriptResult(
  value: unknown,
  nonce: string,
  expected: 'executed' | 'denied'
) {
  nonceSchema.parse(nonce);
  const original = resultSchema.parse(value);
  if (
    expected === 'executed'
      ? original.outcome !== 'load' || original.marker !== nonce
      : original.outcome !== 'error' || original.marker !== null
  )
    throw new Error('CONTROLLED_ORIGINAL_SCRIPT_OUTCOME_REQUIRED');
  return Object.freeze(original);
}
