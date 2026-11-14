/**
 * DOR-3370: every server file that answers with HTML is on a reviewed list,
 * with how it keeps agent-controlled markup from running on this origin.
 *
 * HTML that DorkOS serves on its own origin runs with the app's powers when
 * opened or framed. So a new file that writes `text/html` (or calls `c.html`)
 * fails here until someone says, below, why it is safe: the bytes are fixed
 * server text, or the answer carries a CSP `sandbox` (an opaque origin), or it
 * is served from another origin, or it only exists under the test runtime.
 * Computed response content types need review too: a stored type can say HTML
 * without that literal appearing at its route. The list also fails when a file
 * stops serving either kind of content, so it never goes stale.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** What makes a file's HTML answer safe on this origin. */
type Why =
  | 'fixed-server-text'
  | 'csp-sandbox'
  | 'other-origin'
  | 'test-runtime-only'
  | 'not-served'
  | 'restricted-media';

const REVIEWED: Record<string, { why: Why; note: string }> = {
  'routes/profile.ts': {
    why: 'restricted-media',
    note: 'AvatarStore accepts only sniffed raster images; the route sends nosniff and inline.',
  },
  'routes/session-attachments-handler.ts': {
    why: 'restricted-media',
    note: 'The store maps only raster suffixes; the route sends nosniff and inline.',
  },
  'routes/room-attachments.ts': {
    why: 'restricted-media',
    note: 'Only verified raster previews are inline; other uploads are octet-stream attachments, with nosniff.',
  },
  'routes/room-files.ts': {
    why: 'restricted-media',
    note: 'The image store limits served types; nosniff and CSP sandbox accompany the inline response.',
  },
  'routes/remote-communities.ts': {
    why: 'restricted-media',
    note: 'Remote downloads always send attachment disposition and nosniff, regardless of the stored type.',
  },
  'routes/connector-resources.ts': {
    why: 'csp-sandbox',
    note: 'Catalog logos, including SVG, carry nosniff and CSP sandbox without allow-same-origin.',
  },
  'routes/room-canvas.ts': {
    why: 'restricted-media',
    note: 'Media allowlist and nosniff; only inline-safe types are inline, with CSP sandbox for SVG.',
  },
  'routes/files.ts': {
    why: 'restricted-media',
    note: 'Media allowlist and nosniff; only inline-safe types are inline, with CSP sandbox for SVG.',
  },
  'routes/diff.ts': {
    why: 'restricted-media',
    note: 'The media type comes from a fixed media suffix allowlist; inline-safe types only, nosniff and SVG sandbox apply.',
  },
  'routes/rooms.ts': {
    why: 'fixed-server-text',
    note: 'The computed type is the fixed room-export type, not stored or uploaded markup.',
  },
  'services/communities/remote/pinned-origin.ts': {
    why: 'not-served',
    note: 'An outbound HTTP request content type, not a response on this server.',
  },
  'services/spaces/storage/blob-store.ts': {
    why: 'other-origin',
    note: 'Community download headers: a fixed MIME allowlist and attachment disposition, not the computer app origin.',
  },
  'services/spaces/routes/community/administration.ts': {
    why: 'other-origin',
    note: 'The Community server serves its validated icon, not the computer app origin.',
  },
  'http/unclaimed.ts': {
    why: 'fixed-server-text',
    note: "The 404 page: the path is HTML-escaped, and it carries default-src 'none'.",
  },
  'http/sign-in-landing-response.ts': {
    why: 'fixed-server-text',
    note: "The no-client-build sign-in page: escaped, default-src 'none', no script.",
  },
  'routes/extension-frame.ts': {
    why: 'csp-sandbox',
    note: 'The empty frame for app screens (DOR-3293): CSP sandbox allow-scripts, no allow-same-origin, nonce-only script, no app text.',
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

/** Include stored or computed content types, which need the same review as literal HTML. */
function needsContentReview(source: string): boolean {
  if (SERVES_HTML.test(source)) return true;
  if (!/content-type/i.test(source)) return false;
  const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const isTypeHeader = (node: ts.Node | undefined): boolean =>
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    node.text.toLowerCase() === 'content-type';
  const dynamic = (node: ts.Node | undefined): boolean =>
    node !== undefined && !ts.isStringLiteralLike(node);
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['header', 'setHeader', 'appendHeader', 'set', 'append'].includes(
        node.expression.name.text
      ) &&
      isTypeHeader(node.arguments[0]) &&
      dynamic(node.arguments[1])
    )
      found = true;
    if (ts.isPropertyAssignment(node) && isTypeHeader(node.name) && dynamic(node.initializer))
      found = true;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      isTypeHeader(node.left.argumentExpression) &&
      dynamic(node.right)
    )
      found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

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
    .filter((path) => needsContentReview(readFileSync(path, 'utf8')))
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

describe('computed response content types (DOR-4133)', () => {
  it.each([
    "c.header('Content-Type', stored.contentType);",
    "res.setHeader('content-type', image.contentType);",
    "res.writeHead(200, { 'Content-Type': attachment.contentType });",
    "const headers = { 'Content-Type': media.contentType };",
    "headers['content-type'] = decision.contentType;",
  ])('requires a review for %s', (source) => {
    expect(needsContentReview(source)).toBe(true);
  });

  it.each([
    "c.header('Content-Type', 'application/json');",
    "const headers = { 'content-type': 'image/png' };",
    "res.setHeader('X-Content-Type-Options', 'nosniff');",
    'const contentType = stored.contentType;',
  ])('does not treat %s as a dynamic response type', (source) => {
    expect(needsContentReview(source)).toBe(false);
  });
});
