import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SearchResponseSchema, type SearchResponse } from '@dorkos/shared/search-schemas';
import { HttpTransport } from '../transport';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRANSPORT_SOURCE = path.resolve(
  HERE,
  '../../../../../../../packages/shared/src/transport.ts'
);
const BASE_URL = 'http://localhost:4242/api';

/**
 * Every member `Transport` promises, its inherited ones included.
 *
 * Walks the declaration and each `extends` clause, resolving a parent that lives
 * in another module through that module's own import statement — `RoomTransport`
 * does today, and a future third parent is followed the same way rather than
 * needing a line here.
 *
 * @param file - Absolute path of the module declaring the interface.
 * @param name - The interface to read.
 * @returns Member names, with the optional ones marked. Optionality matters:
 *   an implementation may legitimately leave a `?:` member out.
 */
function interfaceMembers(file: string, name: string): Array<{ name: string; optional: boolean }> {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name
  );
  if (!declaration) throw new Error(`No interface ${name} in ${file}`);

  const members = declaration.members
    .filter(
      (member): member is ts.MethodSignature | ts.PropertySignature =>
        (ts.isMethodSignature(member) || ts.isPropertySignature(member)) &&
        member.name !== undefined &&
        ts.isIdentifier(member.name)
    )
    .map((member) => ({
      name: (member.name as ts.Identifier).text,
      optional: member.questionToken !== undefined,
    }));

  const inherited = (declaration.heritageClauses ?? [])
    .flatMap((clause) => clause.types)
    .flatMap((type) => {
      if (!ts.isIdentifier(type.expression)) return [];
      const parent = type.expression.text;
      return interfaceMembers(resolveDeclaringModule(source, parent) ?? file, parent);
    });

  return [...inherited, ...members];
}

/**
 * Where a name imported into `source` actually comes from, as an absolute path.
 *
 * `.js` specifiers are rewritten to `.ts`: this repo's shared package is
 * NodeNext, so its source imports carry the extension the BUILD will emit, not
 * the one on disk.
 *
 * @param source - The parsed module doing the importing.
 * @param name - The imported identifier to locate.
 * @returns The absolute path, or `undefined` when the name is declared locally.
 */
function resolveDeclaringModule(source: ts.SourceFile, name: string): string | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (!bindings.elements.some((element) => element.name.text === name)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    return path.resolve(
      path.dirname(source.fileName),
      statement.moduleSpecifier.text.replace(/\.js$/, '.ts')
    );
  }
  return undefined;
}

describe('the Transport interface, as HttpTransport answers it', () => {
  const members = interfaceMembers(TRANSPORT_SOURCE, 'Transport');
  const required = members.filter((member) => !member.optional);

  it('reads a real interface rather than silently finding nothing', () => {
    // The guard on this whole file: a parser that stopped matching would make
    // every case below pass over an empty list. The floor sits below today's
    // count (245) with room for ordinary removals, and far enough above zero
    // that a walker which stopped following `extends` — worth ~40 members on its
    // own — cannot slip past it.
    expect(required.length).toBeGreaterThan(200);
    expect(required.map((member) => member.name)).toContain('search');
    // Followed across the `extends` clause into `transport-rooms.ts`, so a
    // method inherited from `RoomTransport` is covered too.
    expect(required.map((member) => member.name)).toContain('listRooms');
  });

  it.each([
    ['HttpTransport', () => new HttpTransport(BASE_URL) as unknown as Record<string, unknown>],
  ])('%s defines every member the interface promises', (_label, build) => {
    const transport = build();
    const missing = required
      .filter((member) => transport[member.name] === undefined)
      .map((member) => member.name);

    expect(missing).toEqual([]);
  });
});

/** The envelope both transports are handed, byte for byte. */
const ENVELOPE: SearchResponse = {
  results: [
    {
      source: 'rooms',
      container: 'room-1',
      containerPath: null,
      ordinal: 4,
      role: 'user',
      createdAt: '2026-08-25T09:00:00.000Z',
      excerpt: 'we agreed to rewrite the <mark>scheduler</mark>',
    },
    {
      source: 'claude-code',
      container: 'session-a',
      containerPath: '/Users/dork/code/dorkos',
      ordinal: 1,
      role: 'assistant',
      createdAt: '2026-08-25T09:01:00.000Z',
      excerpt: 'the <mark>scheduler</mark>, as discussed in a session',
    },
  ],
  warnings: [{ source: 'codex', message: 'Some of this could not be read.' }],
};

describe('HttpTransport search', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the response envelope and warnings', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(ENVELOPE), { status: 200 }));

    const overHttp = await new HttpTransport(BASE_URL).search({ q: 'scheduler' });

    // Parsed, not compared raw: a transport that added a field would still be
    // deep-equal to itself, and the contract is what the schema admits.
    const parsedHttp = SearchResponseSchema.parse(overHttp);

    expect(parsedHttp).toEqual(ENVELOPE);
    // Named separately because it is the field a transport is most likely to
    // quietly drop: it is empty on almost every real response, so a `?? []`
    // anywhere in the chain would look correct for months.
    expect(parsedHttp.warnings).toEqual(ENVELOPE.warnings);
  });

  it('preserves a refused query’s code, status and body', async () => {
    const refusal = {
      error: 'Search needs a word of at least 2 letters to look for.',
      code: 'INVALID_SEARCH_QUERY',
    };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(refusal), { status: 400 }));

    const overHttp = await new HttpTransport(BASE_URL)
      .search({ q: 'a' })
      .catch((err: unknown) => err);

    for (const thrown of [overHttp]) {
      expect(thrown).toBeInstanceOf(Error);
    }
    const shapeOf = (err: unknown) => {
      const e = err as Error & { code?: string; status?: number; body?: unknown };
      return { message: e.message, code: e.code, status: e.status, body: e.body };
    };
    // The box above these renders `error.message` and never asks which
    // transport it is on, so the whole carried shape has to match — not just
    // the fact that something threw.
    expect(shapeOf(overHttp)).toEqual({
      message: refusal.error,
      code: 'INVALID_SEARCH_QUERY',
      status: 400,
      body: refusal,
    });
  });
});
