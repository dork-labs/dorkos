import { afterEach, describe, expect, it } from 'vitest';
import {
  FRONTMATTER_PARSERS,
  FRONTMATTER_LIMITS,
  NonMappingFrontmatterError,
  OversizedFrontmatterError,
  UnsupportedFrontmatterError,
  parseFrontmatter,
  stringifyFrontmatter,
} from '../frontmatter.js';

/**
 * A package's markdown is untrusted input. gray-matter, left to its defaults,
 * runs `eval` on any frontmatter block that opens with `---js` or
 * `---javascript` (DOR-2308). Every payload below writes to a global, so a
 * test can prove the code never ran rather than only that an error came back.
 */
const SENTINEL = '__dorkosFrontmatterPwned';

function sentinel(): unknown {
  return (globalThis as Record<string, unknown>)[SENTINEL];
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SENTINEL];
});

const payload = (lang: string) =>
  `---${lang}\n{ name: (globalThis.${SENTINEL} = 1, 'x') }\n---\nbody\n`;

describe('parseFrontmatter refuses every non-data language', () => {
  // Purpose: the RCE itself. Each spelling gray-matter maps to its eval engine,
  // plus case and whitespace variants its own language sniffing accepts.
  it.each(['js', 'javascript', 'JS', 'JavaScript', ' js ', 'js\t'])(
    'refuses `---%s` without evaluating it',
    (lang) => {
      expect(() => parseFrontmatter(payload(lang))).toThrow(UnsupportedFrontmatterError);
      expect(sentinel()).toBeUndefined();
    }
  );

  // Purpose: a language gray-matter does not register must not fall through to
  // a prototype lookup (`---constructor`, `---toString`) or any other engine.
  it.each(['coffee', 'coffeescript', 'cson', 'toml', 'constructor', 'toString', '__proto__'])(
    'refuses `---%s`',
    (lang) => {
      expect(() => parseFrontmatter(payload(lang))).toThrow(UnsupportedFrontmatterError);
      expect(sentinel()).toBeUndefined();
    }
  );

  // Purpose: gray-matter strips a byte-order mark before it sniffs the
  // language, so the refusal must see through one too.
  it('refuses `---js` behind a byte-order mark', () => {
    expect(() => parseFrontmatter(`\uFEFF${payload('js')}`)).toThrow(UnsupportedFrontmatterError);
    expect(sentinel()).toBeUndefined();
  });

  // Purpose: CRLF files sniff the language up to `\r\n`; `js\r` must still be js.
  it('refuses `---js` with CRLF line endings', () => {
    expect(() => parseFrontmatter(payload('js').replace(/\n/g, '\r\n'))).toThrow(
      UnsupportedFrontmatterError
    );
    expect(sentinel()).toBeUndefined();
  });

  // Purpose: YAML's own escape hatch. js-yaml v3's full schema constructs
  // functions from `!!js/function`; the pinned safe schema must refuse the tag.
  // (gray-matter's own v3 `safeLoad` refused it too, so this guards against a
  // regression to an unsafe loader rather than proving the fix.)
  it('refuses a `!!js/function` YAML tag without constructing it', () => {
    const content = `---\nname: !!js/function "function () { globalThis.${SENTINEL} = 1 }"\n---\n`;
    expect(() => parseFrontmatter(content)).toThrow();
    expect(sentinel()).toBeUndefined();
  });
});

describe('parseFrontmatter reads ordinary frontmatter unchanged', () => {
  // Purpose: the default (no language) path is the one every real file takes.
  it('parses YAML frontmatter and keeps the body verbatim', () => {
    const parsed = parseFrontmatter('---\nname: a\ncount: 2\nlist: [x, y]\n---\n\n# Body\n');
    expect(parsed.data).toEqual({ name: 'a', count: 2, list: ['x', 'y'] });
    expect(parsed.content).toBe('\n# Body\n');
  });

  // Purpose: `---yaml`, `---yml` and `---json` are data languages and stay allowed.
  it.each([
    ['yaml', 'name: a'],
    ['yml', 'name: a'],
    ['YAML', 'name: a'],
    ['json', '{ "name": "a" }'],
    // gray-matter aliases yaml/yml in any case but looks json up exactly as
    // written, so these used to fail as an unregistered engine (DOR-2317).
    ['JSON', '{ "name": "a" }'],
    ['Json', '{ "name": "a" }'],
    [' JSON ', '{ "name": "a" }'],
  ])('parses an explicit `---%s` block', (lang, block) => {
    expect(parseFrontmatter(`---${lang}\n${block}\n---\nbody`).data).toEqual({ name: 'a' });
  });

  // Purpose: content with no frontmatter at all must not be mistaken for a
  // language line (its first line is prose, not a `---` fence).
  it('returns empty data for content without frontmatter', () => {
    expect(parseFrontmatter('javascript is fun\n')).toEqual({
      data: {},
      content: 'javascript is fun\n',
    });
  });

  // Purpose: YAML 1.2 core booleans — `yes`/`no` stay strings, which
  // `readYamlBoolean` and the skill schema depend on.
  it('keeps YAML 1.1 boolean words as strings', () => {
    expect(parseFrontmatter('---\na: yes\nb: true\n---\n').data).toEqual({ a: 'yes', b: true });
  });

  // Purpose: malformed YAML still throws, so callers keep their error paths.
  it('throws on malformed YAML', () => {
    expect(() => parseFrontmatter('---\nname: [unclosed\n---\n')).toThrow();
  });

  // Purpose: no shared cache — mutating one result must not leak into the next.
  it('returns a fresh object per call', () => {
    const content = '---\nname: a\n---\n';
    parseFrontmatter(content).data.name = 'mutated';
    expect(parseFrontmatter(content).data.name).toBe('a');
  });
});

describe('stringifyFrontmatter', () => {
  // Purpose: the round trip every writer depends on.
  it('writes YAML frontmatter that parses back to the same data', () => {
    const text = stringifyFrontmatter('Do the thing.', { name: 'a', tags: ['x'] });
    expect(text).toBe('---\nname: a\ntags:\n  - x\n---\nDo the thing.\n');
    expect(parseFrontmatter(text).data).toEqual({ name: 'a', tags: ['x'] });
  });

  // Purpose: gray-matter's own `stringify(string, data)` PARSES the body
  // first, so a body opening with `---js` was evaluated on the way out. The
  // body is data here and must be written as-is, never read as frontmatter.
  it('never parses the body, even one that opens with `---js`', () => {
    const body = payload('js');
    const text = stringifyFrontmatter(body, { name: 'a' });
    expect(sentinel()).toBeUndefined();
    expect(text).toBe(`---\nname: a\n---\n${body}`);
  });

  // Purpose: a skill with no frontmatter fields is written as body alone.
  it('writes the body alone when there is no data', () => {
    expect(stringifyFrontmatter('body', {})).toBe('body\n');
  });
});

describe('each layer holds on its own', () => {
  // Purpose: layer 2. There is no code engine to reach: the only parsers are
  // the two data languages, so a spelling that slipped past the language
  // check would still have nothing to run it.
  it('has a parser for YAML and JSON and nothing else', () => {
    expect(Object.keys(FRONTMATTER_PARSERS).sort()).toEqual(['json', 'yaml']);
  });

  // Purpose: layer 3. js-yaml v3's full-schema `load` builds these types; the
  // pinned v4 DEFAULT_SCHEMA has no JavaScript types and must refuse them.
  it.each(['!!js/undefined ~', '!!js/regexp /x/', '!!js/function "function () {}"'])(
    'the YAML engine refuses `%s`',
    (tagged) => {
      expect(() => FRONTMATTER_PARSERS.yaml(`a: ${tagged}`)).toThrow();
    }
  );

  // Purpose: proves the pinned js-yaml v4 parser is the one in use, not
  // gray-matter's bundled v3: v3 reads `0123` as octal (83), v4 as 123.
  it('parses with js-yaml v4 (a leading zero is not octal)', () => {
    expect(parseFrontmatter('---\na: 0123\n---\n').data).toEqual({ a: 123 });
  });
});

describe('frontmatter must be a mapping', () => {
  // Purpose: `data` is typed as a record, and callers read keys off it. A
  // top-level scalar or list is refused with a parse error rather than handed
  // back as a string or array. (A null block reaches callers as `{}`: gray-matter
  // itself normalises it, covered below.)
  it.each([
    ['a scalar', '---\nhello\n---\n'],
    ['a list', '---\n- a\n- b\n---\n'],
    ['a JSON array', '---json\n[1, 2]\n---\n'],
  ])('refuses %s', (_label, content) => {
    expect(() => parseFrontmatter(content)).toThrow(NonMappingFrontmatterError);
  });

  // Purpose: an empty, comment-only or null block is still "no fields", not an error.
  it.each(['---\n---\nbody', '---\n# only a comment\n---\nbody', '---\n~\n---\nbody'])(
    'reads an empty block as no fields',
    (content) => {
      expect(parseFrontmatter(content).data).toEqual({});
    }
  );
});

describe('stringifyFrontmatter refuses values YAML cannot hold', () => {
  // Purpose: js-yaml v4 silently DROPS an `undefined` key where v3 threw. A
  // dropped `schedule` key would quietly un-schedule a skill, so the wrapper
  // restores the throw, at any depth.
  it.each([
    ['top level', { name: 'a', schedule: undefined }],
    ['nested', { name: 'a', schedule: { cron: undefined } }],
    ['in a list', { name: 'a', tags: ['x', undefined] }],
  ])('throws on `undefined` at the %s', (_label, data) => {
    expect(() => stringifyFrontmatter('body', data)).toThrow(/undefined/);
  });
});

/**
 * A YAML alias bomb: nine levels, each a list of nine aliases to the level
 * below, so a few hundred bytes describe 9^9 leaves once expanded (DOR-2311).
 */
function aliasBomb(levels = 9, width = 9): string {
  const names = 'abcdefghijklmnop';
  const lines = [`a: &a [${Array(width).fill('"x"').join(', ')}]`];
  for (let i = 1; i < levels; i++) {
    lines.push(
      `${names[i]}: &${names[i]} [${Array(width)
        .fill(`*${names[i - 1]}`)
        .join(', ')}]`
    );
  }
  return `---\n${lines.join('\n')}\n---\nbody\n`;
}

describe('frontmatter has a size budget (DOR-2311)', () => {
  // Purpose: the reviewer's repro. A ~540-byte block that expands
  // exponentially is refused while parsing, before any caller walks or
  // serialises it, and quickly.
  it('refuses a YAML alias bomb, fast', () => {
    const content = aliasBomb();
    expect(content.length).toBeLessThan(700);
    const started = Date.now();
    expect(() => parseFrontmatter(content)).toThrow(OversizedFrontmatterError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  // Purpose: aliases to one long string amplify by characters, not nodes. The
  // budget counts expanded characters too.
  it('refuses a long string repeated through aliases', () => {
    const long = 'y'.repeat(20_000);
    const refs = Array(200).fill('*s').join(', ');
    const content = `---\ns: &s "${long}"\nt: [${refs}]\n---\n`;
    expect(() => parseFrontmatter(content)).toThrow(OversizedFrontmatterError);
  });

  // Purpose: nesting depth is bounded, so a recursive walker downstream cannot
  // overflow its stack. (js-yaml stops at 100 on its own; 80 sits between
  // that and this limit, so it is this check that refuses it.)
  it.each([
    ['YAML', `---\na: ${'['.repeat(80)}${']'.repeat(80)}\n---\n`],
    ['JSON', `---json\n{"a": ${'['.repeat(200)}${']'.repeat(200)}}\n---\n`],
  ])('refuses %s nested deeper than the limit', (_label, content) => {
    expect(() => parseFrontmatter(content)).toThrow(OversizedFrontmatterError);
  });

  // Purpose: the walk after parsing alone. js-yaml limits nesting in the
  // text, but an alias placed deep inside another deep list stacks the two
  // depths once expanded; the walk counts the expanded depth.
  it('refuses nesting that aliases stack past the limit', () => {
    const deep = (inner: string) => `${'['.repeat(40)}${inner}${']'.repeat(40)}`;
    const content = `---\na: &a ${deep('1')}\nb: ${deep('*a')}\n---\n`;
    expect(() => parseFrontmatter(content)).toThrow(/nested more than 64 levels/);
  });

  // Purpose: the raw block has a byte cap, whatever it contains.
  it.each([
    ['YAML', (n: string) => `---\nnote: "${n}"\n---\n`],
    ['JSON', (n: string) => `---json\n{"note": "${n}"}\n---\n`],
  ])('refuses a %s block over the byte cap', (_label, make) => {
    const content = make('z'.repeat(FRONTMATTER_LIMITS.maxBlockBytes));
    expect(() => parseFrontmatter(content)).toThrow(OversizedFrontmatterError);
  });

  // Purpose: the budget sits at the engine, so it holds even with the
  // language check and gray-matter out of the way.
  it('bounds the YAML engine itself', () => {
    expect(() => FRONTMATTER_PARSERS.yaml(aliasBomb().split('---')[1])).toThrow(
      OversizedFrontmatterError
    );
  });

  // Purpose: ordinary anchors and aliases, and a long body, are unaffected.
  it('still reads small anchors and aliases, and ignores body length', () => {
    const content = `---\nbase: &b { model: fast, tags: [a, b] }\nother: *b\n---\n${'long body '.repeat(20_000)}`;
    expect(parseFrontmatter(content).data).toEqual({
      base: { model: 'fast', tags: ['a', 'b'] },
      other: { model: 'fast', tags: ['a', 'b'] },
    });
  });

  // Purpose: the refusal reads as plain words a package author can act on.
  it('says what is wrong in plain words', () => {
    expect(() => parseFrontmatter(aliasBomb())).toThrow(/too large/i);
  });
});

describe('nothing costs much before a limit refuses it (DOR-2311 review)', () => {
  /** A generous bound for a slow CI runner; each case takes milliseconds. */
  const FAST_MS = 2_000;

  /** Time one call that must throw an OversizedFrontmatterError. */
  function refusedWithin(content: string): number {
    const started = Date.now();
    expect(() => parseFrontmatter(content)).toThrow(OversizedFrontmatterError);
    return Date.now() - started;
  }

  // Purpose: gray-matter stripped comments with a quadratic regular expression
  // before any engine ran, so a blank or comment-only block over the cap cost
  // seconds to minutes and never reached a size check. The cap now comes first.
  it.each([
    ['blank lines', '---\n' + ' \n'.repeat(500_000) + '---\n'],
    ['comment lines', '---\n' + '# note\n'.repeat(150_000) + '---\n'],
    ['blank lines, no closing fence', '---\n' + ' \n'.repeat(500_000)],
  ])('refuses a %s block over the cap quickly', (_label, content) => {
    expect(refusedWithin(content)).toBeLessThan(FAST_MS);
  });

  // Purpose: the cap counts UTF-8 bytes, not UTF-16 code units: 12,000 CJK
  // characters are 36 KB.
  it('measures the cap in UTF-8 bytes', () => {
    refusedWithin(`---\na: "${'漢'.repeat(12_000)}"\n---\n`);
  });

  // Purpose: a flow list used as a key is turned into a string by js-yaml
  // while it parses, joining every aliased value in it. The alias charge stops
  // the parse before that join, inside the byte cap.
  it('refuses an aliased list used as a mapping key, quickly', () => {
    const content = `---\ns: &s "${'x'.repeat(20_000)}"\nl: &l [${Array(90).fill('*s').join(',')}]\nm: {[*l]: 1}\n---\n`;
    expect(Buffer.byteLength(content)).toBeLessThan(FRONTMATTER_LIMITS.maxBlockBytes);
    expect(refusedWithin(content)).toBeLessThan(FAST_MS);
  });

  // Purpose: the per-collection size check alone. An alias used as a mapping
  // key is joined into one string while js-yaml parses, before any walk after
  // the parse could refuse it; sizing each list as it finishes stops the chain
  // at the first level that grows too large.
  it('refuses an alias chain used as a mapping key, quickly', () => {
    const content = aliasBomb().replace('\n---\nbody', '\nz: {*i : 1}\n---\nbody');
    expect(refusedWithin(content)).toBeLessThan(FAST_MS);
  }, 10_000);

  // Purpose: merge keys copy every key of the aliased mapping.
  it('refuses repeated merges of a large mapping', () => {
    const keys = Array.from({ length: 1_500 }, (_, i) => `k${i}: 0`).join(', ');
    const content = `---\na: &a {${keys}}\nb: [${Array(99).fill('{<<: *a}').join(',')}]\n---\n`;
    expect(Buffer.byteLength(content)).toBeLessThan(FRONTMATTER_LIMITS.maxBlockBytes);
    expect(refusedWithin(content)).toBeLessThan(FAST_MS);
  });

  // Purpose: explicit `? ` keys are refused outright; no real file uses them.
  it.each(['? a\n: 1', 'm: {? a : 1}', '- ? a\n  : 1'])(
    'refuses the explicit key in %j',
    (block) => {
      expect(() => parseFrontmatter(`---\n${block}\n---\n`)).toThrow(/explicit "\? " key/);
    }
  );

  // Purpose: a question mark in prose is not a key.
  it('reads a question mark inside a value', () => {
    expect(parseFrontmatter('---\ndescription: What is it? A test.\n---\n').data).toEqual({
      description: 'What is it? A test.',
    });
  });

  // Purpose: the alias count is capped on its own, even for tiny values.
  it('refuses more than the allowed number of aliases', () => {
    const refs = Array(FRONTMATTER_LIMITS.maxAliases + 1)
      .fill('*a')
      .join(',');
    expect(() => parseFrontmatter(`---\na: &a 1\nb: [${refs}]\n---\n`)).toThrow(
      /more than 100 YAML aliases/
    );
    const ok = Array(FRONTMATTER_LIMITS.maxAliases).fill('*a').join(',');
    expect(parseFrontmatter(`---\na: &a 1\nb: [${ok}]\n---\n`).data.b).toHaveLength(100);
  });

  // Purpose: a `*` inside a comment is not an alias.
  it('does not count a star in a comment as an alias', () => {
    expect(parseFrontmatter('---\n# see *important*\na: 1\n---\n').data).toEqual({ a: 1 });
  });

  // Purpose: an alias to a collection that contains it would expand forever.
  it('refuses a recursive alias', () => {
    expect(() => parseFrontmatter('---\na: &a [1, *a]\n---\n')).toThrow(
      /refers to a value that contains it/
    );
  });
});

describe('fences split the way gray-matter split them', () => {
  // Purpose: parity with the rules every existing file was written against.
  it.each([
    ['no frontmatter', 'hello\n', {}, 'hello\n'],
    ['empty content', '', {}, ''],
    ['byte-order mark', '﻿---\na: 1\n---\nbody', { a: 1 }, 'body'],
    ['CRLF', '---\r\na: 1\r\n---\r\nbody\r\n', { a: 1 }, 'body\r\n'],
    ['four dashes is not a fence', '----\na: 1\n', {}, '----\na: 1\n'],
    ['no closing fence', '---\na: 1\n', { a: 1 }, ''],
    ['empty block', '---\n---\nbody', {}, 'body'],
    ['dashes later in the body', '---\na: 1\n---\nx\n---\ny', { a: 1 }, 'x\n---\ny'],
    ['closing line with text after it', '---\na: 1\n---more\nbody', { a: 1 }, 'more\nbody'],
    ['language tag', '---yaml\na: 1\n---\nbody', { a: 1 }, 'body'],
  ])('%s', (_label, content, data, body) => {
    expect(parseFrontmatter(content)).toEqual({ data, content: body });
  });
});
