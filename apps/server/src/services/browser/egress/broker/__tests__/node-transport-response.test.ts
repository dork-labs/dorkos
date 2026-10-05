import { expect, it } from 'vitest';
import { renderResponse } from '../responses.js';
import { brokerLimits } from '../limits.js';
const response = (setCookies: readonly string[]) => ({
  status: 200,
  headers: {},
  setCookies,
  head: new Uint8Array(),
  body: {} as never,
});
it('charges each repeated cookie field against header count and byte limits', () => {
  expect(() =>
    renderResponse(response(['a=one', 'b=two']), false, brokerLimits({ headerFields: 1 }))
  ).toThrow('FRAMING_REFUSED');
  expect(() =>
    renderResponse(response(['a=' + 'x'.repeat(100)]), false, brokerLimits({ headerBytes: 64 }))
  ).toThrow('FRAMING_REFUSED');
});
it('rejects cookie field injection and competing scalar/repeated representations', () => {
  expect(() => renderResponse(response(['a=one\r\nInjected: yes']), false, brokerLimits())).toThrow(
    'FRAMING_REFUSED'
  );
  expect(() =>
    renderResponse(
      { ...response(['a=one']), headers: { 'set-cookie': 'b=two' } },
      false,
      brokerLimits()
    )
  ).toThrow('FRAMING_REFUSED');
});
it('strips nominated cookies while preserving the legacy scalar response contract', () => {
  const stripped = renderResponse(
    { ...response(['a=one']), headers: { connection: 'set-cookie' } },
    false,
    brokerLimits()
  ).toString();
  expect(stripped).not.toContain('a=one');
  expect(
    renderResponse(
      { ...response([]), headers: { 'set-cookie': 'a=one' } },
      false,
      brokerLimits()
    ).toString()
  ).toContain('set-cookie: a=one\r\n');
});
