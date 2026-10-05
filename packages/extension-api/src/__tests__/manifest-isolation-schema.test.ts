/**
 * The manifest contract for an extension that runs separately (DOR-2686 task
 * 1.1): `serverCapabilities.runtime`, `allow` and `limits`, and the reasons
 * each bad declaration is refused with. Discovery and `dorkos marketplace
 * validate` both parse with this schema, so these reasons are what an author
 * reads in either place.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOW_NEEDS_SUBPROCESS,
  EXTERNAL_HOSTS_NEED_ALLOW_NET,
  ExtensionManifestSchema,
  WORKER_RUNTIME_REFUSAL,
} from '../manifest-schema.js';
import {
  NET_ENTRY_JUST_HOST,
  NET_ENTRY_LOCAL_NEEDS_PORT,
  formatNetEntry,
  isNetEntryCovered,
  isNetEntryError,
  matchesNetEntry,
  parseNetEntry,
} from '../net-allowlist.js';
import { RUN_ENTRY_ONE_PROGRAM, runEntryProblem } from '../run-allowlist.js';

/** A manifest with these server capabilities. */
function manifestWith(serverCapabilities: Record<string, unknown>, extra = {}) {
  return { id: 'mail-app', name: 'Mail', version: '1.0.0', serverCapabilities, ...extra };
}

/** Every message the schema refused a manifest with. */
function messagesOf(input: unknown): string[] {
  const result = ExtensionManifestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('serverCapabilities.runtime, allow and limits', () => {
  // Purpose: the spec's example manifest is accepted, and omitted allow and
  // limit fields are filled with their documented defaults.
  it('accepts the mail-app example and fills defaults', () => {
    const result = ExtensionManifestSchema.parse(
      manifestWith({
        serverEntry: './server.ts',
        runtime: 'subprocess',
        allow: { net: ['imap.fastmail.com:993', 'smtp.fastmail.com:465', '*.googleapis.com'] },
        limits: {},
      })
    );
    expect(result.serverCapabilities?.runtime).toBe('subprocess');
    expect(result.serverCapabilities?.allow).toEqual({
      net: ['imap.fastmail.com:993', 'smtp.fastmail.com:465', '*.googleapis.com'],
      run: [],
      agents: false,
    });
    expect(result.serverCapabilities?.limits).toEqual({ memoryMb: 256 });
  });

  // Purpose: Decision for Dorian 1 — "worker" is reserved and refused with
  // exactly this reason, never accepted as an alias.
  it('refuses runtime "worker" with the exact reason', () => {
    expect(messagesOf(manifestWith({ runtime: 'worker' }))).toEqual([WORKER_RUNTIME_REFUSAL]);
    expect(WORKER_RUNTIME_REFUSAL).toBe(
      'Use "subprocess": a worker can\'t be given its own limits.'
    );
  });

  // Purpose: an unknown runtime is still refused (the custom message must
  // not swallow the enum check for other values).
  it('refuses an unknown runtime', () => {
    expect(messagesOf(manifestWith({ runtime: 'sandbox' }))).toHaveLength(1);
  });

  // Purpose: a list on an in-process extension would be a promise nothing
  // keeps, so allow and limits are refused there — explicit or by default.
  it('refuses allow and limits on an in-process extension', () => {
    expect(messagesOf(manifestWith({ allow: { net: ['api.example.com'] } }))).toEqual([
      ALLOW_NEEDS_SUBPROCESS,
    ]);
    expect(messagesOf(manifestWith({ runtime: 'in-process', limits: { memoryMb: 128 } }))).toEqual([
      ALLOW_NEEDS_SUBPROCESS,
    ]);
  });

  // Purpose: an isolated extension states its hosts in one place only.
  it('refuses externalHosts beside runtime subprocess', () => {
    expect(
      messagesOf(manifestWith({ runtime: 'subprocess', externalHosts: ['https://x.example.com'] }))
    ).toEqual([EXTERNAL_HOSTS_NEED_ALLOW_NET]);
  });

  // Purpose: the memory limit is capped both ways and must be whole.
  it('caps memoryMb to 64..1024', () => {
    for (const memoryMb of [63, 1025, 256.5]) {
      expect(
        messagesOf(manifestWith({ runtime: 'subprocess', limits: { memoryMb } }))
      ).toHaveLength(1);
    }
    expect(
      ExtensionManifestSchema.parse(
        manifestWith({ runtime: 'subprocess', limits: { memoryMb: 64 } })
      ).serverCapabilities?.limits?.memoryMb
    ).toBe(64);
  });

  // Purpose: unknown keys inside allow or limits fail instead of being
  // silently dropped (a typo like "nets" must not read as "no hosts").
  it('refuses unknown keys in allow and limits', () => {
    expect(messagesOf(manifestWith({ runtime: 'subprocess', allow: { nets: [] } }))).toHaveLength(
      1
    );
    expect(messagesOf(manifestWith({ runtime: 'subprocess', limits: { cpu: 1 } }))).toHaveLength(1);
  });

  // Purpose: the list caps hold.
  it('caps allow.net at 64 and allow.run at 16 entries', () => {
    const net = Array.from({ length: 65 }, (_, i) => `h${i}.example.com`);
    const run = Array.from({ length: 17 }, (_, i) => `p${i}`);
    expect(messagesOf(manifestWith({ runtime: 'subprocess', allow: { net } }))).toHaveLength(1);
    expect(messagesOf(manifestWith({ runtime: 'subprocess', allow: { run } }))).toHaveLength(1);
  });

  // Purpose: bad entries are refused at their index with the entry's reason,
  // and duplicates (after canonicalization) are refused.
  it('refuses bad and duplicate entries', () => {
    expect(
      messagesOf(manifestWith({ runtime: 'subprocess', allow: { net: ['https://x.example.com'] } }))
    ).toEqual([NET_ENTRY_JUST_HOST]);
    expect(
      messagesOf(
        manifestWith({ runtime: 'subprocess', allow: { net: ['[::1]:80', '[0:0::1]:80'] } })
      )
    ).toEqual(['"[0:0::1]:80" is listed more than once']);
    expect(
      messagesOf(manifestWith({ runtime: 'subprocess', allow: { run: ['git status'] } }))
    ).toEqual([RUN_ENTRY_ONE_PROGRAM]);
    expect(
      messagesOf(manifestWith({ runtime: 'subprocess', allow: { run: ['git', 'git'] } }))
    ).toEqual(['"git" is listed more than once']);
  });

  // Purpose: an existing in-process manifest parses exactly as before — no
  // runtime, allow or limits key is added to it.
  it('leaves an existing in-process manifest byte-identical', () => {
    // Keys in schema order, so the comparison is about content, not key order.
    const existing = {
      id: 'linear-issues',
      name: 'Linear',
      version: '1.0.0',
      description: 'x',
      serverCapabilities: {
        serverEntry: './server.ts',
        externalHosts: ['https://api.linear.app'],
        secrets: [],
      },
    };
    const parsed = ExtensionManifestSchema.parse(existing);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(existing));
  });
});

describe('parseNetEntry', () => {
  /** The canonical spelling, or the error. */
  const parse = (entry: string) => {
    const parsed = parseNetEntry(entry);
    return isNetEntryError(parsed) ? { error: parsed.error } : formatNetEntry(parsed);
  };

  // Purpose: what an author may write is accepted, in one canonical spelling.
  it.each([
    ['api.example.com', 'api.example.com'],
    ['api.example.com:443', 'api.example.com:443'],
    ['*.example.com', '*.example.com'],
    ['localhost:8080', 'localhost:8080'],
    ['127.0.0.1:5432', '127.0.0.1:5432'],
    ['[::1]:3000', '[::1]:3000'],
    ['[2001:DB8::1]', { error: 'Write the host in lowercase, like api.example.com' }],
    ['[2001:0db8:0000:0000:0000:0000:0000:0001]', '[2001:db8::1]'],
    ['8.8.8.8', '8.8.8.8'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
  ])('%s → %s', (entry, expected) => {
    expect(parse(entry)).toEqual(expected);
  });

  // Purpose: each way to smuggle more than a host is refused with a reason.
  it.each([
    ['https://x', NET_ENTRY_JUST_HOST],
    ['user@api.example.com', NET_ENTRY_JUST_HOST],
    ['api.example.com/path', NET_ENTRY_JUST_HOST],
    ['api.example.com?x', NET_ENTRY_JUST_HOST],
    ['api.example.com 443', NET_ENTRY_JUST_HOST],
    ['*', 'Name a host: "*" alone would allow every host'],
    ['*.', 'Name a host: "*" alone would allow every host'],
    ['*.com', 'A wildcard needs a domain under it, like *.example.com'],
    ['a*.example.com', 'Use "*." only at the start, like *.example.com'],
    ['api.*.example.com', 'Use "*." only at the start, like *.example.com'],
    ['*.*.example.com', 'Use "*." only at the start, like *.example.com'],
    ['*.10.0.0.1', 'Write an IPv4 address as four numbers, like 192.168.1.10'],
    ['localhost', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['foo.localhost', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['printer.local', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['intranet', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['127.0.0.1', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['10.1.2.3', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['172.16.0.1', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['192.168.1.1', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['169.254.169.254', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['0.0.0.0', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['100.64.0.1', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['[::1]', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['[::]', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['[fd00::1]', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['[fe80::1]', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['[::ffff:127.0.0.1]', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['[::ffff:7f00:1]', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['[64:ff9b::a00:1]', NET_ENTRY_LOCAL_NEEDS_PORT],
    ['2130706433', 'Write an IPv4 address as four numbers, like 192.168.1.10'],
    ['0x7f000001', 'Write an IPv4 address as four numbers, like 192.168.1.10'],
    ['127.1', 'Write an IPv4 address as four numbers, like 192.168.1.10'],
    ['010.0.0.1', 'Write an IPv4 address as four numbers, like 192.168.1.10'],
    ['::1', 'Put an IPv6 address in brackets, like [2001:db8::1]:443'],
    ['[fe80::1%en0]:80', 'Leave the zone off an IPv6 address'],
    ['API.example.com', 'Write the host in lowercase, like api.example.com'],
    ['bücher.example', 'Write an international name in its xn-- form, like xn--bcher-kva.example'],
    ['api.example.com.', 'Leave off the trailing dot, like api.example.com'],
    ['api.example.com:0', 'Use a port from 1 to 65535, like api.example.com:443'],
    ['api.example.com:65536', 'Use a port from 1 to 65535, like api.example.com:443'],
    ['api.example.com:0443', 'Use a port from 1 to 65535, like api.example.com:443'],
    ['api.example.com:', 'Use a port from 1 to 65535, like api.example.com:443'],
    ['-api.example.com', 'Use letters, digits, hyphens and dots only, like api.example.com'],
    ['api_x.example.com', 'Use letters, digits, hyphens and dots only, like api.example.com'],
    ['', 'Write a host, like api.example.com'],
  ])('%s is refused', (entry, error) => {
    expect(parse(entry)).toEqual({ error });
  });
});

describe('matchesNetEntry', () => {
  // Purpose: a wildcard matches names below its domain, never the apex.
  it('matches *.example.com below the domain only', () => {
    expect(matchesNetEntry(['*.example.com'], 'a.example.com', 443)).toBe(true);
    expect(matchesNetEntry(['*.example.com'], 'a.b.example.com', 443)).toBe(true);
    expect(matchesNetEntry(['*.example.com'], 'example.com', 443)).toBe(false);
    expect(matchesNetEntry(['*.example.com'], 'badexample.com', 443)).toBe(false);
  });

  // Purpose: case, trailing dot, brackets and IPv6 spelling do not matter;
  // the port does when the entry names one.
  it('normalizes the host and honours the port', () => {
    expect(matchesNetEntry(['api.example.com:443'], 'API.Example.com.', 443)).toBe(true);
    expect(matchesNetEntry(['api.example.com:443'], 'api.example.com', 80)).toBe(false);
    expect(matchesNetEntry(['api.example.com'], 'api.example.com', 80)).toBe(true);
    expect(matchesNetEntry(['[::1]:3000'], '0:0:0:0:0:0:0:1', 3000)).toBe(true);
    expect(matchesNetEntry(['[::1]:3000'], '[::1]', 3000)).toBe(true);
  });

  // Purpose: a non-ASCII name never matches its xn-- entry by accident or
  // otherwise; punycode compares as written.
  it('compares punycode as given', () => {
    expect(matchesNetEntry(['xn--bcher-kva.example'], 'bücher.example', 443)).toBe(false);
    expect(matchesNetEntry(['xn--bcher-kva.example'], 'xn--bcher-kva.example', 443)).toBe(true);
  });

  // Purpose: a name never matches an address entry or the other way round,
  // and an entry that does not parse allows nothing.
  it('keeps kinds apart and ignores bad entries', () => {
    expect(matchesNetEntry(['8.8.8.8'], 'dns.google', 53)).toBe(false);
    expect(matchesNetEntry(['*'], 'anything.example.com', 443)).toBe(false);
    expect(matchesNetEntry(['localhost'], 'localhost', 80)).toBe(false);
  });
});

describe('isNetEntryCovered', () => {
  // Purpose: the coverage relation consent relies on — narrower is covered,
  // anything wider is not.
  it.each([
    [['api.example.com'], 'api.example.com:443', true],
    [['api.example.com:443'], 'api.example.com:443', true],
    [['api.example.com:443'], 'api.example.com', false],
    [['api.example.com:443'], 'api.example.com:80', false],
    [['*.example.com'], 'a.example.com:443', true],
    [['*.example.com'], '*.a.example.com', true],
    [['*.example.com'], '*.example.com', true],
    [['*.example.com'], 'example.com', false],
    [['*.a.example.com'], '*.example.com', false],
    [['a.example.com'], '*.a.example.com', false],
    [['*.example.com:443'], '*.example.com', false],
    [['[::1]:3000'], '[0::1]:3000', true],
    [['api.example.com'], 'other.example.com', false],
    [[], 'api.example.com', false],
    [['*'], 'api.example.com', false],
    [['api.example.com'], 'https://api.example.com', false],
  ])('%j covers %s: %s', (approved, declared, expected) => {
    expect(isNetEntryCovered(approved, declared)).toBe(expected);
  });
});

describe('runEntryProblem', () => {
  // Purpose: one program by name or absolute path is accepted.
  it.each(['git', 'rg', 'python3.12', 'git-lfs', 'node_x', '/usr/bin/git', 'C:\\Tools\\rg.exe'])(
    'accepts %s',
    (entry) => {
      expect(runEntryProblem(entry)).toBeNull();
    }
  );

  // Purpose: arguments, relative paths, dot segments, globs and shell
  // syntax are refused, so the name on the card is the only program it means.
  it.each([
    'git status',
    'git\tstatus',
    './git',
    'bin/git',
    '../git',
    '.',
    '..',
    '-rf',
    '/usr/bin/../bin/git',
    '/usr/bin/./git',
    '/usr//bin/git',
    '/usr/bin/',
    'C:\\Tools\\..\\rg.exe',
    'C:/Tools/rg.exe',
    'git*',
    'git;rm',
    '$(git)',
    '~/bin/git',
    '',
  ])('refuses %j', (entry) => {
    expect(runEntryProblem(entry)).not.toBeNull();
  });
});
