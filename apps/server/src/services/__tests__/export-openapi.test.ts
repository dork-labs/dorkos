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
});
