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

    // `capabilities.list` → GET /api/capabilities/catalog, tagged by its domain,
    // with the precise catalog response schema.
    const catalog = paths['/api/capabilities/catalog']?.get;
    expect(catalog?.tags).toEqual(['Capabilities']);
    expect(catalog?.responses?.['200']?.content?.['application/json']?.schema).toMatchObject({
      properties: { catalogVersion: {}, generatedAt: {}, capabilities: {} },
    });

    // The operator domain now appears in /api/docs via `operator.activity_list`
    // → GET /api/activity, projecting its input as query parameters.
    const activity = paths['/api/activity']?.get;
    expect(activity?.tags).toEqual(['Operator']);
    expect((activity?.parameters ?? []).length).toBeGreaterThan(0);
  });
});
