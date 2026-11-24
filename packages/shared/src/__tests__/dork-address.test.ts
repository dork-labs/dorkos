import { HandleSchema } from '@dork-labs/cloud-api';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_HANDLE_PATTERN,
  EMAIL_PAIR_MAX_LENGTH,
  RESERVED_ADDRESS_WORDS,
  fitsEmailLocalPart,
  formatDorkAddress,
  formatDorkDisplay,
  formatEmailLocalPart,
  parseDorkAddress,
  parseDorkChannelMention,
  parseDorkDisplay,
  parseDorkMention,
  parseEmailLocalPart,
  type DorkAddress,
} from '../dork-address.js';
import { DORK_KINDS } from '../dork-ref.js';
import { ROOM_SLUG_REGEX } from '../room-schemas.js';

const ADDRESSES: DorkAddress[] = [
  { space: 'acme', handle: 'owl' },
  { space: 'acme', handle: 'owl', name: 'launch' },
  { space: 'a1', handle: 'o_l-2', name: 'q' },
  { space: 'x'.repeat(32), handle: 'h'.repeat(32), name: 'n'.repeat(23) },
];

describe('addresses round-trip through every rendering', () => {
  it.each(ADDRESSES)('canonical: %j', (address) => {
    const uri = formatDorkAddress(address);
    expect(uri).toBe(
      `dork:${address.space}/${address.handle}${address.name ? `/${address.name}` : ''}`
    );
    expect(parseDorkAddress(uri)).toEqual({ ok: true, value: address });
  });

  it.each(ADDRESSES)('display, with and without the space: %j', (address) => {
    const { space, handle, name } = address;
    const full = formatDorkDisplay(address);
    expect(full).toBe(`${handle}${name ? `+${name}` : ''}@${space}`);
    expect(parseDorkDisplay(full)).toEqual({ ok: true, value: address });

    const local = formatDorkDisplay(address, space);
    expect(local).toBe(`${handle}${name ? `+${name}` : ''}`);
    const withoutSpace = name === undefined ? { handle } : { handle, name };
    expect(parseDorkDisplay(local)).toEqual({ ok: true, value: withoutSpace });
  });

  it('keeps the space in a display form seen from another space', () => {
    expect(formatDorkDisplay({ handle: 'owl', space: 'acme' }, 'other')).toBe('owl@acme');
  });

  it('mentions: @handle and @handle@space', () => {
    expect(parseDorkMention('@owl')).toEqual({ ok: true, value: { handle: 'owl' } });
    expect(parseDorkMention('@owl@acme')).toEqual({
      ok: true,
      value: { handle: 'owl', space: 'acme' },
    });
  });

  it('channel mentions: #slug and #slug@space', () => {
    expect(parseDorkChannelMention('#build')).toEqual({ ok: true, value: { channel: 'build' } });
    expect(parseDorkChannelMention('#build@acme')).toEqual({
      ok: true,
      value: { channel: 'build', space: 'acme' },
    });
  });

  it.each(ADDRESSES.slice(0, 3))('email local part: %j', (address) => {
    const local = formatEmailLocalPart(address);
    expect(local).toBe(
      `${address.handle}.${address.space}${address.name ? `+${address.name}` : ''}`
    );
    expect(parseEmailLocalPart(local)).toEqual({ ok: true, value: address });
  });
});

describe('address refusals', () => {
  it.each([
    ['not-a-string', 7],
    ['no-scheme', 'acme/owl'],
    ['bad-shape', 'dork:acme'],
    ['bad-shape', 'dork:acme/owl/launch/extra'],
    ['mixed-case', 'dork:Acme/owl'],
    ['mixed-case', 'dork:acme/Owl'],
    ['bad-space', 'dork:a/owl'],
    ['bad-space', `dork:${'x'.repeat(33)}/owl`],
    ['bad-space', 'dork:ac_me/owl'],
    ['bad-handle', 'dork:acme/144x.co'],
    ['bad-handle', `dork:acme/${'h'.repeat(33)}`],
    ['bad-handle', 'dork:acme/o'],
    ['bad-handle', 'dork:acme/_owl'],
    ['bad-handle', 'dork:acme/owl-'],
    ['bad-name', `dork:acme/owl/${'n'.repeat(24)}`],
    ['bad-name', 'dork:acme/owl/new_launch'],
    ['bad-name', 'dork:acme/owl/'],
    ['reserved', 'dork:chat/owl'],
    ['reserved', 'dork:acme/admin'],
    ['reserved', 'dork:acme/everyone'],
    ['reserved', 'dork:acme/no_reply'],
    ['reserved', 'dork:acme/no-reply'],
    ['reserved', 'dork:acme/noreply'],
    ['reserved', 'dork:acme/mailer_daemon'],
    ['reserved', 'dork:acme/ch-at'],
    ['reserved', 'dork:mailer-daemon/owl'],
    ['reserved', 'dork:acme/dorkos'],
    ['reserved', 'dork:acme/here'],
  ])('%s: %j', (reason, input) => {
    expect(parseDorkAddress(input)).toEqual({ ok: false, reason });
  });

  it.each(DORK_KINDS)('reserves the kind word %s as a space and as a handle', (kind) => {
    expect(RESERVED_ADDRESS_WORDS).toContain(kind);
    expect(parseDorkAddress(`dork:${kind}/owl`)).toEqual({ ok: false, reason: 'reserved' });
    expect(parseDorkAddress(`dork:acme/${kind}`)).toEqual({ ok: false, reason: 'reserved' });
  });

  it('refuses to spell an address that would not parse back', () => {
    expect(() => formatDorkAddress({ space: 'chat', handle: 'owl' })).toThrow(TypeError);
    expect(() => formatDorkAddress({ space: 'acme', handle: 'Owl' })).toThrow(TypeError);
    expect(() => formatDorkDisplay({ handle: 'owl', name: 'a_b' })).toThrow(TypeError);
  });

  it.each([
    ['bad-shape', 'owl+a+b'],
    ['bad-shape', 'owl@acme@x'],
    ['bad-shape', ''],
    ['bad-handle', '144x.co'],
    ['bad-name', `owl+${'n'.repeat(24)}`],
    ['bad-space', 'owl@a'],
    ['reserved', 'support@acme'],
    ['reserved', 'no_reply@acme'],
    ['reserved', 'owl@chat'],
    ['reserved', 'owl@no-reply'],
  ])('display %s: %j', (reason, input) => {
    expect(parseDorkDisplay(input)).toEqual({ ok: false, reason });
  });

  it.each([
    ['bad-shape', 'owl'],
    ['bad-shape', '@owl+launch'],
    ['bad-shape', '@owl+launch@acme'],
    ['bad-handle', '@144x.co'],
    ['reserved', '@everyone'],
    ['reserved', '@every_one'],
    ['reserved', '@owl@chat'],
  ])('mention %s: %j', (reason, input) => {
    expect(parseDorkMention(input)).toEqual({ ok: false, reason });
  });

  it.each([
    ['bad-shape', 'build'],
    ['bad-shape', '#build@acme@x'],
    ['bad-channel', '#-build'],
    ['bad-channel', `#${'c'.repeat(81)}`],
    ['bad-space', '#build@a'],
    ['reserved', '#build@chat'],
  ])('channel %s: %j', (reason, input) => {
    expect(parseDorkChannelMention(input)).toEqual({ ok: false, reason });
  });

  it.each([
    ['bad-shape', 'owl'],
    ['bad-shape', 'owl.acme.co'],
    ['bad-shape', 'owl.acme+a+b'],
    ['bad-handle', '_owl.acme'],
    ['reserved', 'postmaster.acme'],
    ['reserved', 'mailer_daemon.acme'],
    ['reserved', 'owl.chat'],
  ])('email %s: %j', (reason, input) => {
    expect(parseEmailLocalPart(input)).toEqual({ ok: false, reason });
  });
});

describe('case: refused by default, folded only on request', () => {
  it.each([
    ['display', parseDorkDisplay, 'Owl@Acme', { handle: 'owl', space: 'acme' }],
    ['mention', parseDorkMention, '@Owl@Acme', { handle: 'owl', space: 'acme' }],
    ['channel', parseDorkChannelMention, '#Build@Acme', { channel: 'build', space: 'acme' }],
    [
      'email',
      parseEmailLocalPart,
      'Owl.Acme+Launch',
      { handle: 'owl', space: 'acme', name: 'launch' },
    ],
  ] as const)('%s', (_what, parse, input, folded) => {
    expect(parse(input)).toEqual({ ok: false, reason: 'mixed-case' });
    expect(parse(input, { foldCase: true })).toEqual({ ok: true, value: folded });
  });

  it('folds ASCII only, so a Kelvin sign never becomes a k', () => {
    const kelvin = String.fromCharCode(0x212a);
    expect(parseDorkMention(`@${kelvin}at`, { foldCase: true })).toEqual({
      ok: false,
      reason: 'bad-handle',
    });
    expect(parseDorkMention('@Kat', { foldCase: true })).toEqual({
      ok: true,
      value: { handle: 'kat' },
    });
  });
});

describe('the email pair rule', () => {
  const at40 = { handle: 'h'.repeat(20), space: 's'.repeat(19) };
  const at41 = { handle: 'h'.repeat(20), space: 's'.repeat(20) };

  it(`allows a handle.space pair of ${EMAIL_PAIR_MAX_LENGTH} and refuses ${EMAIL_PAIR_MAX_LENGTH + 1}`, () => {
    expect(fitsEmailLocalPart(at40.handle, at40.space)).toBe(true);
    expect(fitsEmailLocalPart(at41.handle, at41.space)).toBe(false);
    expect(formatEmailLocalPart({ ...at40, name: 'n'.repeat(23) }).length).toBe(64);
    expect(() => formatEmailLocalPart(at41)).toThrow(TypeError);
  });

  it('still reads a too-long pair when mail arrives: the rule bites at issue time', () => {
    expect(parseEmailLocalPart(`${at41.handle}.${at41.space}`)).toEqual({ ok: true, value: at41 });
  });
});

describe('drift: these grammars agree with their sources', () => {
  const handles = [
    'ab',
    'owl',
    'o_l-2',
    'h'.repeat(32),
    'a',
    'h'.repeat(33),
    '-owl',
    'owl_',
    'Owl',
    '144x.co',
    'ow l',
    'café',
  ];

  it.each(handles)('handle %j: ADDRESS_HANDLE_PATTERN agrees with Cloud HandleSchema', (handle) => {
    expect(ADDRESS_HANDLE_PATTERN.test(handle)).toBe(HandleSchema.safeParse(handle).success);
  });

  const slugs = ['build', '0', 'b-2', 'c'.repeat(80), 'c'.repeat(81), '-b', 'Build', 'b_2', 'b.c'];

  it.each(slugs)('channel %j: #slug agrees with ROOM_SLUG_REGEX', (slug) => {
    expect(parseDorkChannelMention(`#${slug}`).ok).toBe(ROOM_SLUG_REGEX.test(slug));
  });
});
