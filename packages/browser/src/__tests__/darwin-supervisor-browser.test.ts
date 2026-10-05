import { SupervisorActionSchema } from '../runtime/darwin-supervisor-protocol.js';
import { expect, it } from 'vitest';
import { parseOwnedDevToolsEndpoint } from '../runtime/darwin-supervisor-browser.js';
it('accepts only the bounded generated browser websocket path on loopback', () => {
  const path = '/devtools/browser/12345678-1234-1234-1234-123456789abc';
  expect(parseOwnedDevToolsEndpoint(Buffer.from(`12345\n${path}\n`))).toBe(
    `ws://127.0.0.1:12345${path}`
  );
  for (const bytes of [
    '65536\n' + path,
    '0\n' + path,
    '123\nws://remote/' + path,
    '123\n/devtools/page/12345678-1234-1234-1234-123456789abc',
    '123\n' + path + '\nextra',
  ])
    expect(() => parseOwnedDevToolsEndpoint(Buffer.from(bytes))).toThrow();
  expect(() => parseOwnedDevToolsEndpoint(new Uint8Array(1025))).toThrow();
});

it('refuses executable and non-web navigation schemes before supervisor admission', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///private/tmp/x',
    'about:blank',
  ])
    expect(SupervisorActionSchema.safeParse({ kind: 'navigate', tab: 1, url }).success).toBe(false);
  expect(
    SupervisorActionSchema.safeParse({ kind: 'navigate', tab: 1, url: 'https://example.test/' })
      .success
  ).toBe(true);
});
