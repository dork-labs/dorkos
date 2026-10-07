import { expect, it, vi } from 'vitest';
import {
  readSharedSANH2Endpoint,
  assertOriginalSharedSANH2Campaign,
} from './shared-san-h2-campaign.fixture.js';

it.each([
  undefined,
  {},
  { allowedOrigin: 'http://allowed.example', deniedOrigin: 'https://denied.example' },
  { allowedOrigin: 'https://127.0.0.1', deniedOrigin: 'https://denied.example' },
  { allowedOrigin: 'https://allowed.example:8443', deniedOrigin: 'https://denied.example' },
  { allowedOrigin: 'https://same.example', deniedOrigin: 'https://same.example' },
])(
  'refuses missing or unsuitable external endpoint input without creating observations %j',
  (value) => {
    expect(() => readSharedSANH2Endpoint(value)).toThrow();
  }
);

it('produces exact original-navigation URLs without declaring that endpoint qualified', () => {
  expect(
    readSharedSANH2Endpoint({
      allowedOrigin: 'https://allowed.example',
      deniedOrigin: 'https://denied.example',
    })
  ).toEqual({
    allowedOrigin: 'https://allowed.example',
    deniedOrigin: 'https://denied.example',
    allowedAuthority: 'allowed.example:443',
    deniedAuthority: 'denied.example:443',
    warmURL: 'https://allowed.example/warm',
    deniedURL: 'https://denied.example/forbidden',
    continueURL: 'https://allowed.example/continue',
  });
});

it('a fabricated bank is refused without invoking its getter despite plausible upstream rows', () => {
  const get = vi.fn(() => {
    throw false;
  });
  const originalProjection = new Proxy({}, { get });
  expect(() =>
    assertOriginalSharedSANH2Campaign({
      endpoint: {
        allowedOrigin: 'https://allowed.example',
        deniedOrigin: 'https://denied.example',
      },
      originalProjection,
      browserId: 'B'.repeat(22),
      browserGeneration: 0,
      allowedSession: 1,
      rows: [
        { session: 1, authority: 'allowed.example:443', path: '/warm' },
        { session: 1, authority: 'allowed.example:443', path: '/continue' },
      ],
    })
  ).toThrow('ORIGINAL_NATIVE_CONNECT_BANK_REQUIRED');
  expect(get).not.toHaveBeenCalled();
});
