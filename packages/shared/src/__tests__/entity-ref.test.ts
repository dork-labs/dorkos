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
    expect(parseClaimKey('DORK-LABS/DORKOS#42')).toEqual({
      ok: true,
      value: { kind: 'pr', id: 'dork-labs/dorkos#42' },
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
    ['bad-url', { url: 'javascript:alert(1)' }],
    ['bad-url', { url: 'data:text/html,x' }],
    ['bad-url', { url: '//evil.example/x' }],
    ['bad-url', { url: 'not a url' }],
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
    ['bad-number', 'PR #042'],
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
    ['bad-ticket', 'ticket', 'DOR-01'],
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
