/**
 * The stability census (DOR-4983, ADR `261123-170832`): every operation says
 * what it promises, the published document holds no `internal` one, and the
 * published document's version is the product's.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_STABILITIES } from '@dorkos/shared/capabilities';
import { generateOpenAPISpec } from '../../openapi-registry.js';
import { splitPublishedDocument } from '../published-document.js';
import { assignStability, PREVIEW_NOTE } from '../stability.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

type Paths = Record<string, Record<string, unknown>>;

/** Every `METHOD path` in a paths map, with its `x-stability`. */
function operations(paths: Paths | undefined): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const [path, item] of Object.entries(paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (op) found.set(`${method.toUpperCase()} ${path}`, op['x-stability']);
    }
  }
  return found;
}

const repoRoot = new URL('../../../../../../../', import.meta.url);
const readRepoFile = (rel: string) => readFileSync(fileURLToPath(new URL(rel, repoRoot)), 'utf8');

describe('stability census', () => {
  const full = generateOpenAPISpec();
  const all = operations(full.paths as Paths);

  it('gives every operation stable, preview or internal', () => {
    const missing = [...all].filter(([, value]) => !API_STABILITIES.includes(value as never));
    expect(missing.map(([key]) => key)).toEqual([]);
    for (const value of API_STABILITIES) expect([...all.values()]).toContain(value);
  });

  it('publishes every operation but the internal ones, and loses nothing in the split', () => {
    const { published, internal } = splitPublishedDocument(full);
    const shown = operations(published.paths as Paths);
    const hidden = operations(internal.paths);
    expect([...shown.values()]).not.toContain('internal');
    expect(new Set(hidden.values())).toEqual(new Set(['internal']));
    expect(new Set([...shown.keys(), ...hidden.keys()])).toEqual(new Set(all.keys()));
    expect(shown.size + hidden.size).toBe(all.size);

    const keys = (sections: object | undefined) =>
      Object.entries(sections ?? {}).flatMap(([section, entries]) =>
        Object.keys(entries as object).map((name) => `${section}/${name}`)
      );
    const split = [...keys(published.components), ...keys(internal.components)];
    expect(split.sort()).toEqual(keys(full.components).sort());
    // No published operation points at a component only the internal part holds.
    const publishedText = JSON.stringify(published.paths);
    for (const key of keys(internal.components)) {
      expect(publishedText).not.toContain(`"#/components/${key}"`);
    }
  });

  it('opens every preview description with the note', () => {
    for (const item of Object.values(full.paths as Paths)) {
      for (const method of METHODS) {
        const op = item[method] as { 'x-stability'?: string; description?: string } | undefined;
        if (op?.['x-stability'] === 'preview') expect(op.description).toMatch(/^\*\*Preview\.\*\*/);
      }
    }
  });

  it('matches the committed files, and the published version is the product version', () => {
    const published = JSON.parse(readRepoFile('docs/api/openapi.json')) as {
      info: { version: string };
      paths: Paths;
    };
    const internal = JSON.parse(readRepoFile('docs/api/openapi-internal.json')) as {
      info?: unknown;
      paths: Paths;
    };
    expect(published.info.version).toBe(readRepoFile('VERSION').trim());
    expect(internal.info).toBeUndefined();
    const shown = operations(published.paths);
    const hidden = operations(internal.paths);
    expect([...shown].filter(([, value]) => !API_STABILITIES.includes(value as never))).toEqual([]);
    expect([...shown.values()]).not.toContain('internal');
    expect(new Set(hidden.values())).toEqual(new Set(['internal']));
  });
});

describe('assignStability', () => {
  it('takes the group value, keeps a declared one, and notes a preview', () => {
    const doc = {
      paths: {
        '/api/health': { get: {} },
        '/api/rooms': { get: { description: 'Rooms.' } },
        '/api/sessions/{id}/opened': { post: { 'x-stability': 'internal' } },
      },
    };
    assignStability(doc);
    expect(doc.paths['/api/health'].get).toEqual({ 'x-stability': 'stable' });
    expect(doc.paths['/api/rooms'].get).toEqual({
      'x-stability': 'preview',
      description: `${PREVIEW_NOTE}\n\nRooms.`,
    });
    expect(doc.paths['/api/sessions/{id}/opened'].post).toEqual({ 'x-stability': 'internal' });
  });

  it('gives a capability route with none preview, or internal in an internal group', () => {
    const doc = {
      paths: {
        '/api/sessions/running': { get: {} },
        '/api/extensions/{id}/restart': { post: {} },
        '/api/sessions/{id}': { get: {} },
      },
    };
    const capabilityRoutes = new Set([
      'GET /api/sessions/running',
      'POST /api/extensions/{id}/restart',
    ]);
    assignStability(doc, capabilityRoutes);
    expect(doc.paths['/api/sessions/running'].get).toMatchObject({ 'x-stability': 'preview' });
    expect(doc.paths['/api/extensions/{id}/restart'].post).toEqual({ 'x-stability': 'internal' });
    expect(doc.paths['/api/sessions/{id}'].get).toEqual({ 'x-stability': 'stable' });
  });

  it('refuses a group with no stability and a value that is not one', () => {
    expect(() => assignStability({ paths: { '/api/made-up-group': { get: {} } } })).toThrow(
      /made-up-group.*has no stability/
    );
    expect(() =>
      assignStability({ paths: { '/api/health': { get: { 'x-stability': 'deprecated' } } } })
    ).toThrow(/declares x-stability "deprecated"/);
  });
});
