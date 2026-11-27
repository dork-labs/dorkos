import { describe, expect, it } from 'vitest';
import { createApiDocsRoutes, type ApiDocumentBuilder } from '../api-docs.js';

const minimal = (() => ({
  openapi: '3.1.0',
  info: { title: 'DorkOS API', version: '0.0.0' },
  paths: {},
})) as unknown as ApiDocumentBuilder;

describe('createApiDocsRoutes', () => {
  it('serves the document and the reference page when the document builds', async () => {
    const routes = createApiDocsRoutes(minimal);
    const doc = await routes.request('/openapi.json');
    expect(doc.status).toBe(200);
    expect(((await doc.json()) as { openapi: string }).openapi).toBe('3.1.0');
    expect((await routes.request('/docs')).status).toBe(200);
  });

  it('serves the published document by default: no internal operation (DOR-4983)', async () => {
    const res = await createApiDocsRoutes().request('/openapi.json');
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    const stabilities = Object.values(doc.paths).flatMap((item) =>
      Object.values(item).map((op) => (op as { 'x-stability'?: string })['x-stability'])
    );
    expect(stabilities.length).toBeGreaterThan(0);
    expect(stabilities).toContain('stable');
    expect(stabilities).not.toContain('internal');
  });

  it('never throws when the document cannot be built, and answers 503 instead', async () => {
    const broken: ApiDocumentBuilder = () => {
      throw new Error('Two operations share the operationId "x.y"');
    };
    const routes = createApiDocsRoutes(broken);
    for (const path of ['/openapi.json', '/docs', '/docs/anything']) {
      const res = await routes.request(path);
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.code).toBe('temporarily_unavailable');
      expect(body.detail).not.toContain('operationId');
    }
  });
});
