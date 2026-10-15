/**
 * The caller an isolated extension's fetch handler is told about, read from
 * the host's verdict header (DOR-2857): a well-formed verdict passes through,
 * and anything else refuses with the in-process words for an agent.
 */
import { describe, expect, it } from 'vitest';
import { callerFrom } from '../child/virtual-server.js';

const REFUSAL = {
  error: "Only a person can change Probe's settings.",
  code: 'extension_person_required',
  message: 'DorkOS changed nothing.',
};

describe('callerFrom', () => {
  it('passes a verdict the host sent', () => {
    expect(callerFrom(JSON.stringify({ ok: true }), REFUSAL)).toEqual({ person: { ok: true } });
    const refused = { ok: false, status: 403, body: { ...REFUSAL, message: 'From the host.' } };
    expect(callerFrom(JSON.stringify(refused), REFUSAL)).toEqual({ person: refused });
  });

  it.each([
    ['no header', null],
    ['an empty header', ''],
    ['garbled JSON', '{ok:true'],
    ['a truthy non-boolean', JSON.stringify({ ok: 'yes' })],
    ['a refusal with a success status', JSON.stringify({ ok: false, status: 200, body: REFUSAL })],
  ])('refuses %s, failing closed', (_label, raw) => {
    expect(callerFrom(raw, REFUSAL)).toEqual({
      person: { ok: false, status: 403, body: REFUSAL },
    });
  });

  it('is frozen, so a handler cannot rewrite it for the next one', () => {
    const caller = callerFrom(JSON.stringify({ ok: true }), REFUSAL);
    expect(Object.isFrozen(caller)).toBe(true);
    expect(Object.isFrozen(caller.person)).toBe(true);
  });
});
