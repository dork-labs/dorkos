import { describe, expect, it } from 'vitest';
import { DORK_KINDS, dorkLinkPath, type DorkKind } from '../dork-ref.js';
import {
  ENTITY_KINDS,
  OUTSIDE_KINDS,
  entityRef,
  formatEntityRef,
  parseClaimKey,
  parseEntityRef,
  type EntityRef,
  type TextEntityKind,
} from '../entity-ref.js';
import { sessionPath } from '../session-link.js';

const ULID = '01JD3G7P1Q4R8S9T0U2V3W4X5Y';
const CHAT = '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';

/** Build a ref the test knows is valid, failing loudly if it is not. */
function must<K extends Parameters<typeof entityRef>[0]>(kind: K, id: string): EntityRef<K> {
  const built = entityRef(kind, id);
  if (!built.ok) throw new Error(`fixture ${kind}:${id} refused: ${built.reason}`);
  return built.value;
}

describe('kinds', () => {
  it('holds every DorkOS kind and the four outside kinds, and nothing else', () => {
    expect([...ENTITY_KINDS].sort()).toEqual([...DORK_KINDS, ...OUTSIDE_KINDS].sort());
    expect(OUTSIDE_KINDS).toEqual(['pr', 'ticket', 'branch', 'worktree']);
  });
});

describe('every text kind round-trips through its canonical spelling', () => {
  const cases: Array<[TextEntityKind, string, string]> = [
    ...DORK_KINDS.map((kind): [DorkKind, string, string] => [
      kind,
      kind === 'chat' ? CHAT : ULID,
      `dork:${kind}:${kind === 'chat' ? CHAT : ULID}`,
    ]),
    ['pr', 'dork-labs/dorkos#42', 'dork-labs/dorkos#42'],
    ['pr', '#42', 'PR #42'],
    ['ticket', 'DOR-1234', 'DOR-1234'],
  ];

  it.each(cases)('%s %s spells %s and reads back', (kind, id, text) => {
    const ref = must(kind, id);
    expect(formatEntityRef(ref)).toBe(text);
    expect(parseEntityRef(text)).toEqual({ ok: true, value: { kind, id } });
  });

  it('reads an encoded web link and an encoded desktop link the same way', () => {
    const chat = { ok: true, value: { kind: 'chat', id: CHAT } };
    const encoded = `dork%3Achat%3A${CHAT}`;
    expect(parseEntityRef(`/r/${encoded}`)).toEqual(chat);
    expect(parseEntityRef(`https://dorkos.example/r/${encoded}`)).toEqual(chat);
    expect(parseEntityRef(`dorkos://r/${encoded}`)).toEqual(chat);
    for (const link of [`/r/dork%253Achat%253A${CHAT}`, `dorkos://r/dork%253Achat%253A${CHAT}`]) {
      expect(parseEntityRef(link)).toEqual({ ok: false, reason: 'bad-link' });
    }
  });

  it.each(DORK_KINDS)('%s reads back from every link form', (kind) => {
    const ref = must(kind, ULID);
    const uri = `dork:${kind}:${ULID}`;
    const expected = { ok: true, value: { kind, id: ULID } };
    expect(parseEntityRef(dorkLinkPath(ref))).toEqual(expected);
    expect(parseEntityRef(`https://dorkos.example/r/${uri}?from=push`)).toEqual(expected);
    expect(parseEntityRef(`/r/${encodeURIComponent(uri)}`)).toEqual(expected);
    expect(parseEntityRef(`dorkos://r/${uri}`)).toEqual(expected);
  });
});

describe('the spellings in use today', () => {
  it('reads a session link, path or URL, ignoring the other route params', () => {
    const chat = { ok: true, value: { kind: 'chat', id: CHAT } };
    expect(parseEntityRef(`/session?session=${CHAT}`)).toEqual(chat);
    expect(parseEntityRef(`https://tunnel.example/session?dir=x&session=${CHAT}`)).toEqual(chat);
  });

  it('undoes the JSON quotes the router puts around an id that looks like JSON', () => {
    const link = sessionPath({ session: '123' });
    expect(link).toBe('/session?session=%22123%22');
    expect(parseEntityRef(link)).toEqual({ ok: true, value: { kind: 'chat', id: '123' } });
  });

  it('reads /channels as the room, or with thread= as the entry; entry= is only a scroll hint', () => {
    expect(parseEntityRef(`/channels?id=${ULID}&entry=7`)).toEqual({
      ok: true,
      value: { kind: 'room', id: ULID },
    });
    expect(parseEntityRef(`/channels?id=${ULID}&thread=E1&entry=7`)).toEqual({
      ok: true,
      value: { kind: 'entry', id: 'E1' },
    });
    expect(parseEntityRef('/channels?id=%22123%22')).toEqual({
      ok: true,
      value: { kind: 'room', id: '123' },
    });
  });

  it('reads claim keys: a ticket, a repo-less PR and an upper-cased repo PR', () => {
    expect(parseClaimKey('DOR-1234')).toEqual({
      ok: true,
      value: { kind: 'ticket', id: 'DOR-1234' },
    });
    expect(parseClaimKey('PR #42')).toEqual({ ok: true, value: { kind: 'pr', id: '#42' } });
    expect(parseClaimKey('DOR-0123')).toEqual({ ok: false, reason: 'leading-zero' });
    expect(parseClaimKey('PR #042')).toEqual({ ok: false, reason: 'leading-zero' });
  });

  it('never reads a repo-shaped claim key as a PR: a free key like FIX/BUG#12 has that shape', () => {
    expect(parseClaimKey('FIX/BUG#12')).toEqual({ ok: false, reason: 'unrecognised' });
    expect(parseClaimKey('DORK-LABS/DORKOS#42')).toEqual({ ok: false, reason: 'unrecognised' });
  });

  it('reads owner/repo#42 in text as a PR, a branch with a # in it included', () => {
    expect(parseEntityRef('dork-labs/dorkos#42')).toEqual({
      ok: true,
      value: { kind: 'pr', id: 'dork-labs/dorkos#42' },
    });
    expect(parseEntityRef('fix/bug#12')).toEqual({
      ok: true,
      value: { kind: 'pr', id: 'fix/bug#12' },
    });
  });

  it('leaves a free claim key, or one that was a dork: reference, as a plain key', () => {
    expect(parseClaimKey('FEAT/NEW-THING')).toEqual({ ok: false, reason: 'unrecognised' });
    expect(parseClaimKey('DORK:CHAT:ABC')).toEqual({ ok: false, reason: 'unrecognised' });
    expect(parseClaimKey('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseClaimKey(3)).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it.each([
    'https://github.com/Dork-Labs/DorkOS/pull/42',
    'https://github.com/dork-labs/dorkos/pull/42/files',
    'http://www.github.com/dork-labs/dorkos/pull/42?tab=checks#discussion',
  ])('reads a GitHub PR URL %s, one id however it is spelled', (url) => {
    expect(parseEntityRef(url)).toEqual({
      ok: true,
      value: {
        kind: 'pr',
        id: 'dork-labs/dorkos#42',
        url: 'https://github.com/dork-labs/dorkos/pull/42',
      },
    });
  });

  it('reads a Linear issue URL, dropping the title slug', () => {
    expect(parseEntityRef('https://linear.app/dorkos/issue/DOR-4967/one-entity-reference')).toEqual(
      {
        ok: true,
        value: { kind: 'ticket', id: 'DOR-4967', url: 'https://linear.app/dorkos/issue/DOR-4967' },
      }
    );
  });
});

describe('branch and worktree: built only from a value the caller holds', () => {
  it('builds them, and refuses to spell or parse them as text', () => {
    const branch = must('branch', 'feat/dor-4967-dork-references');
    const worktree = must('worktree', 'dor-4967-dork-refs');
    expect(() => formatEntityRef(branch as unknown as EntityRef<TextEntityKind>)).toThrow(
      TypeError
    );
    expect(() => formatEntityRef(worktree as unknown as EntityRef<TextEntityKind>)).toThrow(
      TypeError
    );
    expect(parseEntityRef('main')).toEqual({ ok: false, reason: 'unrecognised' });
  });

  it.each(['main', 'feat/x', 'release/v1.2', 'a-b_c.d', 'café'])('accepts branch %j', (name) => {
    expect(entityRef('branch', name).ok).toBe(true);
  });

  it.each([
    'HEAD',
    '@',
    '-x',
    '/x',
    'x/',
    'x.',
    'a..b',
    'a//b',
    'a b',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    'a@{1}',
    '.hidden',
    'x/.hidden',
    'x.lock',
    'x.lock/y',
    'a\u0007b',
    'b'.repeat(256),
  ])('refuses branch %j', (name) => {
    expect(entityRef('branch', name)).toEqual({ ok: false, reason: 'bad-branch' });
  });

  it.each(['dor-4967', 'main.wt', 'A_b-1'])('accepts worktree name %j', (name) => {
    expect(entityRef('worktree', name).ok).toBe(true);
  });

  it.each(['/Users/someone/wt', 'worktrees/x', 'a\\b', '..', 'x..y', '~', '~x', 'C:wt'])(
    'refuses worktree path %j as a path',
    (name) => {
      expect(entityRef('worktree', name)).toEqual({ ok: false, reason: 'is-path' });
    }
  );

  it.each(['.', 'a b', 'a$b', 'w'.repeat(256)])('refuses worktree %j as a bad name', (name) => {
    expect(entityRef('worktree', name)).toEqual({ ok: false, reason: 'bad-worktree' });
  });
});

describe('display hints', () => {
  it.each([
    ['a label with accents and emoji', { label: 'Caf\u00e9 launch \u{1F680}' }],
    ['a ZWJ emoji', { label: 'Add \u{1F469}\u200d\u{1F4BB} dev mode' }],
    ['a ZWJ emoji with a skin tone', { label: '\u{1F469}\u{1F3FD}\u200d\u{1F4BB}' }],
    ['the rainbow flag', { label: '\u{1F3F3}\ufe0f\u200d\u{1F308}' }],
    [
      'a flag tag sequence',
      { label: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}' },
    ],
    ['an app path with a query and a fragment', { url: '/session?session=abc#top' }],
    ['an app path', { url: '/session?session=abc' }],
    ['an escaped backslash, which stays in the path', { url: '/%5Cevil.example' }],
    ['an escaped tab, which stays in the path', { url: '/%09/evil.example' }],
    ['an https URL', { url: 'https://github.com/dork-labs/dorkos/pull/42' }],
  ])('accepts %s', (_what, extras) => {
    expect(entityRef('chat', CHAT, extras).ok).toBe(true);
  });

  it('keeps a label and a safe url, outside the identity', () => {
    expect(entityRef('chat', CHAT, { label: 'Launch plan', url: `/r/dork:chat:${CHAT}` })).toEqual({
      ok: true,
      value: { kind: 'chat', id: CHAT, label: 'Launch plan', url: `/r/dork:chat:${CHAT}` },
    });
  });

  it.each([
    ['bad-label', { label: '' }],
    ['bad-label', { label: '   ' }],
    ['bad-label', { label: 'two\nlines' }],
    ['bad-label', { label: 'l'.repeat(201) }],
    ['bad-label', { label: '\u200b' }],
    ['bad-label', { label: '\u200b\u200c\u2060' }],
    ['bad-label', { label: 'paypal\u202egnp.exe' }],
    ['bad-label', { label: 'zero\u200bwidth' }],
    ['bad-label', { label: 'line\u2028break' }],
    ['bad-label', { label: 'para\u2029break' }],
    ['bad-label', { label: 'next\u0085line' }],
    ['bad-label', { label: 'tab\there' }],
    ['bad-label', { label: 'bom\ufeff' }],
    ['bad-label', { label: '\u200d' }],
    ['bad-label', { label: 'a\u200db' }],
    ['bad-label', { label: '\u200d\u{1F4BB}' }],
    ['bad-label', { label: 'tag\u{E0067}' }],
    ['bad-label', { label: '\u{1F469}\u200b\u{1F4BB}' }],
    ['bad-label', { label: '\u202eabc' }],
    ['bad-url', { url: 'javascript:alert(1)' }],
    ['bad-url', { url: 'data:text/html,x' }],
    ['bad-url', { url: '//evil.example/x' }],
    ['bad-url', { url: 'not a url' }],
    ['bad-url', { url: '/\\evil.example' }],
    ['bad-url', { url: '/\\evil.example/path' }],
    ['bad-url', { url: '/\t/evil.example' }],
    ['bad-url', { url: '/\n/evil.example' }],
    ['bad-url', { url: '/\r/evil.example' }],
    ['bad-url', { url: '/ /evil.example' }],
    ['bad-url', { url: '/\u0085/evil.example' }],
    ['bad-url', { url: '/\u200b/evil.example' }],
    ['bad-url', { url: 'https://ok.example\\@evil.example' }],
    ['bad-url', { url: 'java\tscript:alert(1)' }],
    ['bad-url', { url: '/..//evil.example' }],
    ['bad-url', { url: '/r/../..//evil.example' }],
    ['bad-url', { url: '/%2e%2e//evil.example' }],
    ['bad-url', { url: '/.%2E/x' }],
    ['bad-url', { url: '/a/./b' }],
    ['bad-url', { url: `https://x.example/${'u'.repeat(2048)}` }],
  ])('%s: %j', (reason, extras) => {
    expect(entityRef('chat', CHAT, extras)).toEqual({ ok: false, reason });
  });
});

describe('refusals', () => {
  it.each([
    ['not-a-string', undefined],
    ['empty', ''],
    ['unrecognised', 'hello'],
    ['unrecognised', '#42'],
    ['unrecognised', 'PR 42'],
    ['unrecognised', '/settings'],
    ['unrecognised', 'https://github.com/dork-labs/dorkos/issues/42'],
    ['unrecognised', 'https://linear.app/dorkos/project/x'],
    ['is-address', 'dork:acme/owl'],
    ['is-address', '/r/dork:acme/owl/launch'],
    ['is-address', 'dorkos://r/dork:acme/owl'],
    ['bad-link', '/r/chat:abc'],
    ['bad-link', 'dorkos://r/chat:abc'],
    ['bad-link', '/r/%E0%A4%A'],
    ['no-id', '/session'],
    ['no-id', '/session?session='],
    ['no-id', '/channels?thread=E1'],
    ['bad-id', '/session?session=a.b'],
    ['bad-id', `/channels?id=${ULID}&thread=a/b`],
    ['bad-kind', 'dork:Chat:abc'],
    ['bad-id', 'dork:chat:'],
    ['unknown-kind', 'dork:widget:abc'],
    ['no-kind', 'dork:chat'],
    ['bad-number', 'PR #0'],
    ['leading-zero', 'PR #042'],
    ['leading-zero', 'dork-labs/dorkos#07'],
    ['leading-zero', 'https://github.com/dork-labs/dorkos/pull/042'],
    ['leading-zero', 'DOR-0123'],
    ['leading-zero', 'https://linear.app/dorkos/issue/DOR-012'],
    ['bad-repo', 'dork--labs/dorkos#1'],
    ['bad-repo', 'dork-labs-/dorkos#1'],
    ['bad-number', 'PR #'],
    ['bad-number', 'dork-labs/dorkos#'],
    ['bad-number', 'https://github.com/dork-labs/dorkos/pull/abc'],
    ['bad-repo', '-x/dorkos#1'],
    ['bad-repo', 'dork-labs/..#1'],
    ['bad-repo', `${'o'.repeat(40)}/dorkos#1`],
    ['bad-ticket', 'https://linear.app/dorkos/issue/dor-1'],
  ])('%s: %j', (reason, input) => {
    expect(parseEntityRef(input)).toEqual({ ok: false, reason });
  });

  it.each([
    ['unknown-kind', 'widget', 'x'],
    ['empty', 'chat', ''],
    ['bad-id', 'chat', 'a/b'],
    ['bad-id', 'agent', 'a'.repeat(65)],
    ['bad-ticket', 'ticket', 'dor-1234'],
    ['bad-ticket', 'ticket', 'D-1'],
    ['leading-zero', 'ticket', 'DOR-01'],
    ['bad-ticket', 'ticket', 'DOR-0'],
    ['leading-zero', 'pr', '#07'],
    ['bad-repo', 'pr', 'a--b/x#1'],
    ['bad-repo', 'pr', 'a/b/c#1'],
    ['bad-number', 'pr', '42'],
  ] as const)('entityRef %s: %s %j', (reason, kind, id) => {
    expect(entityRef(kind as never, id)).toEqual({ ok: false, reason });
  });

  it('folds a PR repo to lower case when built, and refuses to spell a non-canonical one', () => {
    expect(entityRef('pr', 'Dork-Labs/DorkOS#7')).toEqual({
      ok: true,
      value: { kind: 'pr', id: 'dork-labs/dorkos#7' },
    });
    expect(() => formatEntityRef({ kind: 'pr', id: 'Dork-Labs/DorkOS#7' })).toThrow(TypeError);
    expect(() => formatEntityRef({ kind: 'chat', id: 'a/b' })).toThrow(TypeError);
  });
});
