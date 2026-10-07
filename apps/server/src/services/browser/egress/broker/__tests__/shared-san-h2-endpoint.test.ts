import { expect, it } from 'vitest';
import { originalSharedSANAuthority } from './shared-san-h2-origin.fixture.js';
import { readOriginalSharedSANEndpointConfig } from './shared-san-h2-endpoint-entry.fixture.js';

it('the original HTTPS443 subjects accept the real omitted default port only', () => {
  for (const authority of ['allowed.example', 'allowed.example:443'])
    expect(originalSharedSANAuthority(authority, 'allowed.example', 'denied.example', 443)).toBe(
      'allowed'
    );
  for (const authority of ['denied.example', 'denied.example:443'])
    expect(originalSharedSANAuthority(authority, 'allowed.example', 'denied.example', 443)).toBe(
      'denied'
    );
  for (const authority of [
    'allowed.example:8443',
    'allowed.example.evil',
    'ALLOWED.example',
    'allowed.example:0443',
    'allowed.example@evil',
    'allowed.example/path',
  ])
    expect(
      originalSharedSANAuthority(authority, 'allowed.example', 'denied.example', 443)
    ).toBeNull();
  expect(
    originalSharedSANAuthority('allowed.example', 'allowed.example', 'denied.example', 8443)
  ).toBeNull();
  expect(
    originalSharedSANAuthority('allowed.example:8443', 'allowed.example', 'denied.example', 8443)
  ).toBe('allowed');
});

const config = {
  keyPath: '/owned/key.pem',
  certificatePath: '/owned/certificate.pem',
  allowedHostname: 'allowed.example',
  deniedHostname: 'denied.example',
  listenAddress: '0.0.0.0',
  observationsPath: '/owned/original-observation.json',
};
it('operator endpoint input requires exact subjects, separate output, and no trust bypass fields', () => {
  expect(readOriginalSharedSANEndpointConfig(config)).toEqual(config);
  for (const changed of [
    { allowedHostname: 'localhost' },
    { allowedHostname: '127.0.0.1' },
    { deniedHostname: 'allowed.example' },
    { observationsPath: '/owned/key.pem' },
    { rejectUnauthorized: false },
    { listenPort: 8443 },
  ])
    expect(() => readOriginalSharedSANEndpointConfig({ ...config, ...changed })).toThrow();
});
