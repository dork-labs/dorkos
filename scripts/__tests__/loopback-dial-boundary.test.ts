import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// A whole-tree parse like its sibling session-link-boundary.test.ts, given the
// same budget for the same reason: in typecheck's queue step it shares the
// runner with the other repo-wide suites.
vi.setConfig({ testTimeout: 120_000 });

/**
 * No hard-coded loopback dial in the server or the desktop shell (DOR-4294).
 *
 * The server binds `DORKOS_HOST`, `localhost` by default, and Node resolves that
 * to ONE address family. On macOS it is routinely `::1` alone, so a caller that
 * dials `127.0.0.1` is refused forever. The desktop shell did exactly that for
 * its event stream and its notification answers, and the tray count and desktop
 * notifications stopped with no notice. DOR-723 caught the same bug in the
 * server's composition root; this is that guard for the whole of both apps.
 *
 * A dial of DorkOS's own server goes through `localDialHost` from
 * `@dorkos/shared/local-dial-host`: in the server as
 * `localDialHost(env.DORKOS_HOST)`, in the shell as `serverOrigin(port)` from
 * `apps/desktop/src/shared/server-address.ts`.
 *
 * What the scan flags, read from the syntax tree so comments never count:
 *
 * - a string or template piece holding an `http`, `https`, `ws` or `wss` URL
 *   whose host is `127.0.0.1`, `localhost` or `[::1]`;
 * - `host:` or `hostname:` set to one of those literals.
 *
 * What it leaves alone on purpose: a bare loopback literal anywhere else. Those
 * are allowlists ("is this caller local?"), checks of a listener's own address,
 * and `listen()` binds. They receive a host or choose where to listen; none of
 * them picks where to dial.
 *
 * Every remaining hit is a deliberate exception, listed below with how many it
 * holds and why, so a new hard-coded dial in one of those files fails too.
 */

/** Files allowed to hold loopback dials: exactly this many, for this reason. */
const ALLOWED: Readonly<Record<string, { count: number; reason: string }>> = {
  // The desktop shell's local browser bridge listens on 127.0.0.1 in this same
  // file and hands that exact address out; it never dials the DorkOS server.
  'apps/desktop/src/main/local-browser/index.ts': {
    count: 2,
    reason: 'its own listener, bound to the same literal',
  },
  // An extension bundle reaches nothing but `@dorkos/extension-api`, so it
  // cannot import the helper; the shell pins the server to `localhost`, the
  // same host the window it runs in was loaded from.
  'apps/server/src/core-extensions/linear-issues/index.ts': {
    count: 1,
    reason: 'extension bundle, cannot import the helper',
  },
  'apps/server/src/env.ts': { count: 1, reason: "Ollama's default address, another program" },
  'apps/server/src/services/runtimes/doe/presets.ts': {
    count: 2,
    reason: "Ollama's default address, another program",
  },
  // Origins a browser may send. These receive a host; they never dial one.
  'apps/server/src/lib/trusted-origins.ts': { count: 5, reason: 'origin allowlist' },
  // Written into docs/api/openapi.json, which must not change with the machine
  // that generated it.
  'apps/server/src/services/core/openapi-registry.ts': {
    count: 1,
    reason: 'documentation example address',
  },
  // A base for parsing a request path. Nothing is dialled.
  'apps/server/src/services/core/streams/upgrade-router.ts': {
    count: 1,
    reason: 'URL parse base',
  },
  'apps/server/src/services/extensions/http/extension-proxy.ts': {
    count: 1,
    reason: 'URL parse base',
  },
  'apps/server/src/services/workbench-serve/bridge-ledger.ts': {
    count: 1,
    reason: 'URL parse base',
  },
  'apps/server/src/services/workbench-serve/preview-listener.ts': {
    count: 1,
    reason: 'URL parse base',
  },
  // Each of these listens on 127.0.0.1 itself and mints the URL of that same
  // listener, so the bind and the dial cannot disagree.
  'apps/server/src/services/browser/egress/broker/broker.ts': {
    count: 1,
    reason: 'its own listener, bound to the same literal',
  },
  'apps/server/src/services/connectors/providers/test-composio/fixture.ts': {
    count: 1,
    reason: 'its own listener, bound to the same literal',
  },
  'apps/server/src/services/core/cloud/credits-relay.ts': {
    count: 1,
    reason: 'its own listener, bound to the same literal',
  },
  'apps/server/src/services/core/remote/managed-ingress.ts': {
    count: 1,
    reason: 'its own listener, bound to the same literal',
  },
  'apps/server/src/services/core/remote/own-tunnel-ingress.ts': {
    count: 2,
    reason: 'its own listener, bound to the same literal',
  },
  'apps/server/src/services/runtimes/connector-mcp/listener.ts': {
    count: 1,
    reason: 'its own listener, bound to the same literal',
  },
  // `listen({ host })`: a bind, not a dial.
  'apps/server/src/services/browser/egress/broker/node-transport.ts': {
    count: 1,
    reason: 'a listen() bind',
  },
  // Lima's port forwards, which Lima itself binds on the host's 127.0.0.1.
  'apps/server/src/services/computers/backend/lima-backend.ts': {
    count: 2,
    reason: "Lima's host-side port forwards",
  },
  // A shell script run inside the guest computer, about the guest's own loopback.
  'apps/server/src/services/computers/guest/guest-recipe.ts': {
    count: 1,
    reason: "script for the guest's own loopback",
  },
};

/** Source roots that ship and dial the DorkOS server. */
const ROOTS = ['apps/server/src/', 'apps/desktop/src/'];

function isTestPath(path: string): boolean {
  return (
    path.includes('/__tests__/') ||
    path.includes('/__mocks__/') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    path.includes('/test-utils/')
  );
}

/** A dial URL naming a loopback host. The lookahead stops `localhost.example` matching. */
const LOOPBACK_URL = /\b(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?![\w.-])/i;

/** A bare loopback host, as a `host:` option would carry it. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|::1|\[::1\])$/i;

/** Whether a literal is the value of a `host:` or `hostname:` property. */
function isHostOption(node: ts.Node, file: ts.SourceFile): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    /^['"]?(?:host|hostname)['"]?$/.test(parent.name.getText(file))
  );
}

/**
 * Every hard-coded loopback dial in one file, as `path:line: snippet`.
 *
 * @param path - Used for the parser's file kind and in the report.
 * @param source - The file's text.
 */
function findLoopbackDials(path: string, source: string): string[] {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      (LOOPBACK_URL.test(node.text) || (LOOPBACK_HOST.test(node.text) && isHostOption(node, file)))
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push(`${path}:${line + 1}: ${node.getText(file).split('\n')[0].slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Shipped source under {@link ROOTS}, as git sees it (tracked and new). */
function shippedSources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts'],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(
      (path) =>
        path.length > 0 &&
        ROOTS.some((root) => path.startsWith(root)) &&
        !path.includes('/node_modules/') &&
        !path.includes('/dist/') &&
        !isTestPath(path) &&
        existsSync(path)
    );
}

describe('loopback dial boundary (DOR-4294)', () => {
  it('finds no hard-coded loopback dial outside the listed exceptions', () => {
    const files = shippedSources();
    expect(files.length).toBeGreaterThan(500);

    const violations: string[] = [];
    const counts: Record<string, number> = {};
    for (const path of files) {
      const dials = findLoopbackDials(path, readFileSync(path, 'utf8'));
      if (dials.length === 0) continue;
      if (path in ALLOWED) counts[path] = dials.length;
      else violations.push(...dials);
    }

    expect(
      violations,
      'these dial a fixed loopback address the server may not be listening on. ' +
        'Dial through `localDialHost` from @dorkos/shared/local-dial-host ' +
        '(`serverOrigin(port)` in the desktop shell), or list a real exception above.'
    ).toEqual([]);
    // Exact counts, both ways: a new dial in a listed file fails, and so does a
    // listed exception that no longer exists, so the list cannot go stale.
    expect(counts).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([path, { count }]) => [path, count]))
    );
  });

  it('recognises each dial spelling, and nothing else', () => {
    // Purpose: prove the matcher can fail, so an empty violation list means
    // something. The hosts are joined so this file cannot trip its own scan.
    const v4 = ['127', '0', '0', '1'].join('.');
    const name = ['local', 'host'].join('');
    const hits = (source: string) => findLoopbackDials('x.ts', source).length > 0;

    expect(hits('fetch(`http://' + v4 + ':${port}/api`);')).toBe(true);
    expect(hits('fetch(`http://' + name + ':${port}/api`);')).toBe(true);
    expect(hits("const u = 'http://[::1]:4242/api';")).toBe(true);
    expect(hits('new WebSocket(`ws://' + v4 + ':${port}`);')).toBe(true);
    expect(hits('const u = `https://' + name + '`;')).toBe(true);
    expect(hits(`http.get({ host: '${v4}', port });`)).toBe(true);
    expect(hits(`http.request({ hostname: '${name}', port });`)).toBe(true);
    expect(hits(`http.get({ 'host': '::1', port });`)).toBe(true);

    // Comments, allowlists, binds, other hosts and the helper are not dials.
    expect(hits(`// we used to dial http://${v4}:4242`)).toBe(false);
    expect(hits(`const local = new Set(['${v4}', '${name}', '::1']);`)).toBe(false);
    expect(hits(`server.listen(0, '${v4}');`)).toBe(false);
    expect(hits(`if (url.hostname === '${name}') ok();`)).toBe(false);
    expect(hits(`const u = 'http://${name}.example.com/x';`)).toBe(false);
    expect(hits(`const u = 'http://${v4}0:80';`)).toBe(false);
    expect(hits('fetch(`${serverOrigin(port)}/api`);')).toBe(false);
    expect(hits('fetch(`http://${localDialHost(env.DORKOS_HOST)}:${port}`);')).toBe(false);
  });
});
