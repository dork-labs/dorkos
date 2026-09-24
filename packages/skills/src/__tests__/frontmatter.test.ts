import { afterEach, describe, expect, it } from 'vitest';
import {
  FRONTMATTER_ENGINES,
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
  // Purpose: layer 2 in isolation. Reaching the engines directly skips the
  // language check, so this fails if the `eval` engine is ever un-replaced.
  it.each(['javascript', 'js'] as const)('the `%s` engine refuses without running', (name) => {
    const engine = FRONTMATTER_ENGINES[name];
    expect(() => engine.parse(`{ a: (globalThis.${SENTINEL} = 1, 2) }`)).toThrow(
      UnsupportedFrontmatterError
    );
    expect(sentinel()).toBeUndefined();
  });

  // Purpose: layer 3. js-yaml v3's full-schema `load` builds these types; the
  // pinned v4 DEFAULT_SCHEMA has no JavaScript types and must refuse them.
  it.each(['!!js/undefined ~', '!!js/regexp /x/', '!!js/function "function () {}"'])(
    'the YAML engine refuses `%s`',
    (tagged) => {
      expect(() => FRONTMATTER_ENGINES.yaml.parse(`a: ${tagged}`)).toThrow();
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

  // Purpose: the raw block has a byte cap, whatever it contains.
  it.each([
    ['YAML', (n: string) => `---\nnote: "${n}"\n---\n`],
    ['JSON', (n: string) => `---json\n{"note": "${n}"}\n---\n`],
  ])('refuses a %s block over the byte cap', (_label, make) => {
    const content = make('z'.repeat(FRONTMATTER_LIMITS.maxBytes));
    expect(() => parseFrontmatter(content)).toThrow(OversizedFrontmatterError);
  });

  // Purpose: the budget sits at the engine, so it holds even with the
  // language check and gray-matter out of the way.
  it('bounds the YAML engine itself', () => {
    expect(() => FRONTMATTER_ENGINES.yaml.parse(aliasBomb().split('---')[1])).toThrow(
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
