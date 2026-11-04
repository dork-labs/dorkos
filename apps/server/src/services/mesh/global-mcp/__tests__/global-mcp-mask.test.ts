/**
 * What a person is shown of a server's arguments and address (DOR-3802): no
 * credential, key, path or query from a URL, and nothing after a secret-named flag.
 */
import { describe, expect, it } from 'vitest';
import { isSecretName, splitArgs } from '@dorkos/shared/global-mcp-schemas';

import { argsLookSecret, holdsMask, maskedArgs, maskUrls } from '../global-mcp-mask.js';

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

  it.each([
    ['http:user:CANARY@host.example.test', 'http:•••@host.example.test'],
    [
      '--db=https:user:CANARY@host.example.test/app?k=v',
      '--db=https:•••@host.example.test/•••?•••',
    ],
    ['http:/user:CANARY@host.example.test', 'http:/•••@host.example.test'],
    ['http:\\\\user:CANARY@host.example.test', 'http:\\\\•••@host.example.test'],
    ['http:host.example.test?key=CANARY', 'http:host.example.test?•••'],
  ])('a URL with no // is still a URL: %s', (input, shown) => {
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

describe('a secret that is not in a secret-named flag', () => {
  it.each([
    [
      ['--header', 'Authorization: Bearer abc'],
      ['--header', 'Authorization: •••'],
    ],
    [['--header=Authorization: Bearer abc'], ['--header=Authorization: •••']],
    [
      ['-H', 'X-Api-Key: abc'],
      ['-H', 'X-Api-Key: •••'],
    ],
    [['API_KEY=abc'], ['API_KEY=•••']],
    [
      ['--env', 'TOKEN=abc'],
      ['--env', 'TOKEN=•••'],
    ],
    [['Bearer abc'], ['Bearer •••']],
    [['--x=Bearer abc'], ['--x=Bearer •••']],
    [
      ['Bearer', 'abc', 'next'],
      ['Bearer', '•••', 'next'],
    ],
  ])('%j', (args, shown) => {
    expect(maskedArgs(args)).toEqual(shown);
  });

  it('leaves arguments that only look close', () => {
    const plain = ['-y', '@made-up/server', '--port=3000', 'LOG_LEVEL=info', 'host:5432'];
    expect(maskedArgs(plain)).toEqual(plain);
  });
});

describe('a secret-named flag holding its value in the same argument', () => {
  it.each([
    [['--token:CANARY'], ['--token:•••']],
    [['--token CANARY'], ['--token •••']],
    [
      ['--token:CANARY', 'next'],
      ['--token:•••', 'next'],
    ],
    [
      ['--token CANARY', 'next'],
      ['--token •••', 'next'],
    ],
    [
      ['--token=CANARY', 'next'],
      ['--token=•••', 'next'],
    ],
  ])('%j', (args, shown) => {
    expect(maskedArgs(args)).toEqual(shown);
    expect(argsLookSecret(args)).toBe(true);
  });
});

describe('a secret in JSON', () => {
  it.each([
    ['{"token":"CANARY"}', '{"token":•••'],
    ['{"apiKey": "CANARY"}', '{"apiKey": •••'],
    ["{'password':'CANARY'}", "{'password':•••"],
    ['--config={"token":"CANARY"}', '--config={"token":•••'],
  ])('%s', (arg, shown) => {
    expect(maskedArgs([arg])).toEqual([shown]);
    expect(argsLookSecret([arg])).toBe(true);
  });

  it('says nothing about JSON with no secret name', () => {
    expect(argsLookSecret(['{"region":"eu"}'])).toBe(false);
  });
});

describe('what a person types in Arguments, split as the form sends it', () => {
  it.each([
    ['{"apiKey": "CANARY"}', ['{apiKey:•••', '•••']],
    ['{"token": "CANARY"}', ['{token:•••', '•••']],
    ['--config {"token": "CANARY"}', ['--config', '{token:•••', '•••']],
    ['Authorization: CANARY', ['Authorization:•••', '•••']],
    ['Authorization: Bearer CANARY', ['Authorization:•••', '•••', '•••']],
    ['-H Authorization: Bearer CANARY', ['-H', 'Authorization:•••', '•••', '•••']],
    ['Authorization: Basic CANARY', ['Authorization:•••', '•••', '•••']],
    ['--token= Bearer CANARY', ['--token=•••', '•••', '•••']],
    ['--token Bearer CANARY', ['--token', '•••', '•••']],
    ['--token : CANARY', ['--token', '•••', '•••']],
    ['--token = CANARY', ['--token', '•••', '•••']],
    ['--token: CANARY', ['--token:•••', '•••']],
    ['--token= CANARY', ['--token=•••', '•••']],
    ['API_KEY= CANARY', ['API_KEY=•••', '•••']],
    ['token: CANARY', ['token:•••', '•••']],
    ['\'{"token": "CANARY"}\'', ['{"token": •••']],
    ['-c "npx server --api-key CANARY"', ['-c', 'npx server --api-key •••']],
    [
      '-c "npx server --port 3000 --api-key CANARY"',
      ['-c', 'npx server --port 3000 --api-key •••'],
    ],
  ])('%s', (typed, shown) => {
    const args = splitArgs(typed);
    expect(maskedArgs(args)).toEqual(shown);
    expect(JSON.stringify(maskedArgs(args))).not.toContain('CANARY');
    expect(argsLookSecret(args)).toBe(true);
  });

  it('leaves what only looks close, and the argument after it', () => {
    for (const typed of [
      '-y made-up@1.0.0 --port 3000',
      '{"region": "eu"}',
      '-c "npx server --port 3000"',
    ]) {
      const args = splitArgs(typed);
      expect(maskedArgs(args)).toEqual(args);
      expect(argsLookSecret(args)).toBe(false);
    }
  });
});

describe('a scheme that only ends in file', () => {
  it.each(['profile://user:CANARY@host.example.test', 'myfile://user:CANARY@host.example.test'])(
    '%s is masked and warned',
    (arg) => {
      expect(maskUrls(arg)).not.toContain('CANARY');
      expect(argsLookSecret([arg])).toBe(true);
    }
  );
});

describe('argsLookSecret', () => {
  it.each([
    [['--token=made-up']],
    [['--token', 'made-up']],
    [['API_KEY=made-up']],
    [['-H', 'X-Api-Key: made-up']],
    [['Bearer made-up']],
    [['Bearer', 'made-up']],
    [['postgres://user:CANARY@db.example.test/app']],
    [['postgres://user@db.example.test/app']],
    [['postgres://user:CAN/ARY@db.example.test/app']],
    [['--db=mysql://u:p@h:3306/x']],
    [['https://mcp.example.test/v1?key=CANARY']],
    [['http:user:CANARY@host.example.test']],
    [['--url=https:user:CANARY@host.example.test']],
    [['http:host.example.test?key=CANARY']],
    [['https:///CANARY@host.example.test']],
    [['https://host.example.test/p#CANARY']],
  ])('warns on %j', (args) => {
    expect(argsLookSecret(args)).toBe(true);
  });

  it.each([
    [[]],
    [['-y', '@made-up/server@1.0.0', '--port=3000', 'LOG_LEVEL=info', 'host:5432']],
    [['git@example.test:org/repo']],
    [['https://mcp.example.test']],
    [['https://mcp.example.test:8080/v1']],
    [['https://cdn.example.test:8080/pkg@1.0.0/index.js']],
    [['file:///opt/server.js?x=1']],
    [['--token']],
  ])('says nothing on %j', (args) => {
    expect(argsLookSecret(args)).toBe(false);
  });

  it('misses a key in a plain path, by ruling: the warning is not the protection', () => {
    expect(argsLookSecret(['https://hooks.example.test/made-up-key/mcp'])).toBe(false);
    expect(maskUrls('https://hooks.example.test/made-up-key/mcp')).toBe(
      'https://hooks.example.test/•••'
    );
  });
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
