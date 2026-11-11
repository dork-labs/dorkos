/**
 * DOR-3370: every server file that answers with HTML is on a reviewed list,
 * with how it keeps agent-controlled markup from running on this origin.
 *
 * HTML that DorkOS serves on its own origin runs with the app's powers when
 * opened or framed. So a new file that writes `text/html` (or calls `c.html`)
 * fails here until someone says, below, why it is safe: the bytes are fixed
 * server text, or the answer carries a CSP `sandbox` (an opaque origin), or it
 * is served from another origin, or it only exists under the test runtime.
 * A file that stops serving HTML fails too, so the list never goes stale.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** What makes a file's HTML answer safe on this origin. */
type Why =
  'fixed-server-text' | 'csp-sandbox' | 'other-origin' | 'test-runtime-only' | 'not-served';

const REVIEWED: Record<string, { why: Why; note: string }> = {
  'http/unclaimed.ts': {
    why: 'fixed-server-text',
    note: "The 404 page: the path is HTML-escaped, and it carries default-src 'none'.",
  },
  'http/sign-in-landing-response.ts': {
    why: 'fixed-server-text',
    note: "The no-client-build sign-in page: escaped, default-src 'none', no script.",
  },
  'routes/workbench-serve.ts': {
    why: 'csp-sandbox',
    note: 'Agent and project files: every answer carries CSP sandbox without allow-same-origin.',
  },
  'services/workbench-serve/frame-inject.ts': {
    why: 'csp-sandbox',
    note: 'Instruments a page for the workbench route (sandboxed) and the preview listener (own port).',
  },
  'services/workbench-serve/devtools-inject.ts': {
    why: 'not-served',
    note: 'Builds an instrumented page as a value; no route on this origin answers with it.',
  },
  'services/workbench-serve/preview-listener.ts': {
    why: 'other-origin',
    note: 'The preview listener: a separate port, so a separate origin.',
  },
  'services/extensions/http/extension-proxy.ts': {
    why: 'csp-sandbox',
    note: 'An extension upstream reply: OUTBOUND_FORCED sets CSP sandbox on every answer.',
  },
  'routes/relay-passkey-page.ts': {
    why: 'fixed-server-text',
    note: "The passkey page: a constant, with its own CSP and frame-ancestors 'none'.",
  },
  'routes/mini-app-access-page.ts': {
    why: 'fixed-server-text',
    note: "The mini app decide page: a server template that shows values a mini app controls (its name, author, source, operations), so its escaping is load-bearing; script-src 'self' and frame-ancestors 'none'.",
  },
  'routes/mcp-oauth.ts': {
    why: 'fixed-server-text',
    note: 'A constant refusal sentence; no request or agent text in it.',
  },
  'routes/runtimes.ts': {
    why: 'fixed-server-text',
    note: 'A constant refusal sentence; the sign-in landing itself is sign-in-landing-response.',
  },
  'routes/api-docs.ts': {
    why: 'fixed-server-text',
    note: "The API reference page, rendered once at boot from the server's own spec.",
  },
  'services/mcp-apps/mcp-app-resource-service.ts': {
    why: 'not-served',
    note: 'Returns an MCP app as JSON; the client renders it in a srcdoc sandbox.',
  },
  'services/core/openapi-registry.ts': {
    why: 'not-served',
    note: 'Names text/html in a route description only.',
  },
  'routes/test-control.ts': {
    why: 'test-runtime-only',
    note: 'Mounted only with DORKOS_TEST_RUNTIME.',
  },
  'routes/mock-mcp-oauth-server.ts': {
    why: 'test-runtime-only',
    note: 'Mounted only with DORKOS_TEST_RUNTIME.',
  },
  'services/runtimes/test-mode/fake-cloud-link.ts': {
    why: 'test-runtime-only',
    note: 'The test runtime’s fake DorkOS Cloud.',
  },
  'services/connectors/providers/test-composio/fixture.ts': {
    why: 'test-runtime-only',
    note: 'The test runtime’s fake connection provider.',
  },
};

const SERVES_HTML = /text\/html|\.html\(/;

/** Every non-test TypeScript file under the server's `src`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('inline HTML on this origin (DOR-3370)', () => {
  const found = sourceFiles(SRC)
    .filter((path) => SERVES_HTML.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path).split('\\').join('/'))
    .sort();

  it('every file that serves HTML has been reviewed for agent-controlled markup', () => {
    const unreviewed = found.filter((path) => !(path in REVIEWED));
    expect(unreviewed, 'Add each to REVIEWED with why its HTML cannot run as the app').toEqual([]);
  });

  it('the reviewed list names no file that no longer serves HTML', () => {
    const stale = Object.keys(REVIEWED).filter((path) => !found.includes(path));
    expect(stale).toEqual([]);
  });
});
