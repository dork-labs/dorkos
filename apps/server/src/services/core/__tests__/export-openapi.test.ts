import { describe, it, expect } from 'vitest';
import { generateOpenAPISpec } from '../openapi-registry.js';

/** Validates the OpenAPI export pipeline produces a valid, complete spec. */
describe('export-openapi', () => {
  it('generates valid OpenAPI 3.1.0 spec', () => {
    const spec = generateOpenAPISpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('DorkOS API');
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('includes required endpoint groups', () => {
    const spec = generateOpenAPISpec();
    const paths = Object.keys(spec.paths ?? {});

    expect(paths.some((p) => p.includes('/sessions'))).toBe(true);
    expect(paths.some((p) => p.includes('/commands'))).toBe(true);
    expect(paths.some((p) => p.includes('/health'))).toBe(true);
  });

  it('produces valid JSON output', () => {
    const spec = generateOpenAPISpec();
    const json = JSON.stringify(spec, null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('projects registry capabilities with an http surface (task 2.5)', () => {
    const spec = generateOpenAPISpec();
    const paths = spec.paths ?? {};

    // `capabilities.list` → GET /api/capabilities/catalog, tagged by its domain.
    // Its filter/pagination input projects as query parameters (DOR-940)...
    const catalog = paths['/api/capabilities/catalog']?.get;
    expect(catalog?.tags).toEqual(['Capabilities']);
    const paramNames = ((catalog?.parameters ?? []) as Array<{ name: string }>).map((p) => p.name);
    expect(paramNames).toEqual(
      expect.arrayContaining(['domain', 'query', 'detail', 'limit', 'cursor'])
    );

    // ...and its response is the paginated result: a oneOf over the compact/full
    // detail branches, each carrying the page envelope.
    const schema = catalog?.responses?.['200']?.content?.['application/json']?.schema as
      | { oneOf?: Array<{ properties?: Record<string, unknown> }> }
      | undefined;
    expect(schema?.oneOf).toHaveLength(2);
    for (const branch of schema?.oneOf ?? []) {
      expect(branch.properties).toHaveProperty('catalogVersion');
      expect(branch.properties).toHaveProperty('detail');
      expect(branch.properties).toHaveProperty('capabilities');
    }

    // The operator domain now appears in /api/docs via `operator.activity_list`
    // → GET /api/activity, projecting its input as query parameters.
    const activity = paths['/api/activity']?.get;
    expect(activity?.tags).toEqual(['Operator']);
    expect((activity?.parameters ?? []).length).toBeGreaterThan(0);
  });
});
