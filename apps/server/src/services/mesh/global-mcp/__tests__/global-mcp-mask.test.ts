/**
 * What a person is shown of a server's arguments and address (DOR-3802): no
 * credential, key, path or query from a URL, and nothing after a secret-named flag.
 */
import { describe, expect, it } from 'vitest';
import { isSecretName } from '@dorkos/shared/global-mcp-schemas';

import { holdsMask, maskedArgs, maskUrls } from '../global-mcp-mask.js';

describe('maskUrls', () => {
  it.each([
    ['postgres://user:pass@db.example.test/app', 'postgres://•••@db.example.test/•••'],
    // A password can hold an @; none of it may survive.
    ['postgres://user:p@ss@db.example.test/app', 'postgres://•••@db.example.test/•••'],
    ['https://mcp.example.test/made-up-key/mcp', 'https://mcp.example.test/•••'],
    ['https://mcp.example.test/v1?key=abc#frag', 'https://mcp.example.test/•••?•••'],
    ['https://mcp.example.test', 'https://mcp.example.test'],
    ['https://mcp.example.test/', 'https://mcp.example.test'],
    ['--db=mysql://u:p@h:3306/x', '--db=mysql://•••@h:3306/•••'],
  ])('%s', (input, shown) => {
    expect(maskUrls(input)).toBe(shown);
  });

  it('leaves a file URL, which names what runs and holds no key', () => {
    expect(maskUrls('file:///opt/server.js')).toBe('file:///opt/server.js');
    expect(maskUrls('git+file:///opt/repo')).toBe('git+file:///opt/repo');
  });
});

describe('maskedArgs', () => {
  it.each(['--pass', '--pwd', '--bearer', '--token', '--api-key', '--db-password'])(
    'hides what %s holds, either way it is written',
    (flag) => {
      expect(maskedArgs([`${flag}=made-up`])).toEqual([`${flag}=•••`]);
      expect(maskedArgs([flag, 'made-up', 'next'])).toEqual([flag, '•••', 'next']);
    }
  );
});

describe('secret names', () => {
  it.each(['DB_PASS', 'DATABASE_URL', 'PGPASSWORD', 'MY_PWD', 'BEARER', 'SENTRY_DSN'])(
    '%s is secret',
    (name) => {
      expect(isSecretName(name)).toBe(true);
    }
  );

  it('LOG_LEVEL is not', () => {
    expect(isSecretName('LOG_LEVEL')).toBe(false);
  });
});

describe('holdsMask', () => {
  it('finds a mask a client sent back', () => {
    expect(holdsMask(['-y', '--token=•••'])).toBe(true);
    expect(holdsMask(['-y', '--token=real'])).toBe(false);
  });
});
