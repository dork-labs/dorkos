/** Real wire checks: late writeHead headers and raw streams must keep the framing boundary. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { protectResponseFraming } from '../frame-ancestors.js';

const server = createServer((request, response) => {
  protectResponseFraming(response, () => ['https://app.fixture.test']);
  switch (request.url) {
    case '/raw':
      response.setHeader('Content-Security-Policy', "default-src 'none'");
      response.writeHead(200, 'Fixture', [
        'Content-Type',
        'text/event-stream',
        'CoNtEnT-SeCuRiTy-PoLiCy',
        "sandbox; style-src 'none'",
        'Set-Cookie',
        'first=one',
        'Set-Cookie',
        'second=two',
      ]);
      response.flushHeaders();
      response.end('data: unchanged\n\n');
      return;
    case '/workbench':
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy':
          "sandbox allow-scripts; frame-ancestors 'self' https://app.fixture.test",
      });
      break;
    case '/pdf':
      response.setHeader('Content-Type', 'application/pdf');
      break;
    case '/pdf-error':
      response.statusCode = 400;
      response.setHeader('Content-Type', 'application/pdf');
      break;
    case '/pdf-redirect':
      response.statusCode = 303;
      response.setHeader('Content-Type', 'application/pdf');
      break;
    case '/explicit':
      response.setHeader('Content-Security-Policy', [
        "default-src 'none'",
        "FRAME-ANCESTORS 'self'",
      ]);
      break;
    case '/existing':
      response.setHeader('Content-Security-Policy', [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
      ]);
      break;
    case '/report-only':
      response.setHeader('Content-Security-Policy-Report-Only', 'frame-ancestors *');
      break;
    default:
      response.statusCode = Number(request.url?.slice(1)) || 200;
      response.setHeader('Content-Type', 'application/json');
  }
  response.end('{}');
});
let base: string;

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('HTTP frame ancestors (DOR-3615)', () => {
  it.each([200, 204, 303, 400, 401, 403, 404, 500, 503])(
    'denies framing a response with status %s',
    async (status) => {
      const response = await fetch(`${base}/${status}`, { redirect: 'manual' });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      await response.arrayBuffer();
    }
  );

  it('protects raw streams with mixed-case writeHead headers without changing cookies or bytes', async () => {
    const response = await fetch(`${base}/raw`);
    expect(response.headers.get('content-security-policy')).toBe(
      "sandbox; style-src 'none', frame-ancestors 'none'"
    );
    expect(response.headers.getSetCookie()).toEqual(['first=one', 'second=two']);
    expect(await response.text()).toBe('data: unchanged\n\n');
  });

  it('preserves an explicit workbench framing allowance', async () => {
    const response = await fetch(`${base}/workbench`);
    expect(response.headers.get('content-security-policy')).toBe(
      "sandbox allow-scripts; frame-ancestors 'self' https://app.fixture.test"
    );
    await response.arrayBuffer();
  });

  it('lets the native PDF viewer embed a preview only from trusted app origins', async () => {
    const response = await fetch(`${base}/pdf`);
    expect(response.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' https://app.fixture.test"
    );
    await response.arrayBuffer();
  });

  it('keeps every existing enforced policy while adding framing protection', async () => {
    const response = await fetch(`${base}/existing`);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none', style-src 'unsafe-inline', frame-ancestors 'none'"
    );
    await response.arrayBuffer();
  });

  it('keeps an explicit ancestor directive in a later policy without adding a conflicting default', async () => {
    const response = await fetch(`${base}/explicit`);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none', FRAME-ANCESTORS 'self'"
    );
    await response.arrayBuffer();
  });

  it('does not allow framing an error even if its content type says PDF', async () => {
    const response = await fetch(`${base}/pdf-error`);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    await response.arrayBuffer();
  });

  it('does not allow framing a redirect even if its content type says PDF', async () => {
    const response = await fetch(`${base}/pdf-redirect`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    await response.arrayBuffer();
  });

  it('does not mistake report-only framing for an enforced policy', async () => {
    const response = await fetch(`${base}/report-only`);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('content-security-policy-report-only')).toBe('frame-ancestors *');
    await response.arrayBuffer();
  });
});
