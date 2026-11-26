import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_HELPERS,
  CONSENT_MODULE,
  callsConsentHelper,
  findNetworkUses,
} from '../outbound-census/scan.js';

// A whole-tree parse, given the same budget as its sibling boundary scans (the
// `beforeAll` that runs it takes the same limit).
vi.setConfig({ testTimeout: 120_000 });

/**
 * Every place the shipped product's source can reach the network is on a
 * checked-in list (DOR-4990).
 *
 * The docs promise that `DO_NOT_TRACK=1` means DorkOS sends nothing it was not
 * asked to. That promise is only as good as our knowledge of every sender, so
 * this suite scans each file under {@link ROOTS} (the server, the browser app,
 * the desktop app and every shipped workspace package) with
 * `scripts/outbound-census/scan.ts`, and fails on any file that uses a network
 * primitive without an entry in `scripts/outbound-census/census.json`:
 *
 * - `consent`: the file, or every file named in `gatedBy`, calls a helper from
 *   `@dorkos/shared/telemetry-consent`, so the kill switches stop it.
 * - `feature`: not telemetry. It says why it talks to the network and how a
 *   person turns it off (`reason`, `offSwitch`).
 *
 * Third-party packages are held to `scripts/outbound-census/dependencies.json`:
 * every runtime dependency of a shipped package is reviewed into exactly one
 * of `network` (a value import of it counts as a sender), `runtime` (an agent
 * runtime; its child environment carries the telemetry-off names), `covered`
 * (a narrower rule in the scan counts its network use) or `offline` (makes no
 * requests). A new dependency fails here until someone decides which.
 *
 * It runs on every pull request and in the merge queue, in the required
 * `typecheck` job's repo-wide scripts step (`scripts/repo-wide-suites.ts`).
 *
 * This is a static guard, not a proof: a call through an injected `fetch` is
 * caught where the global is wired in (so `packages/decisions` shows up as
 * `triage-wiring.ts` and `space-server.ts`), and a spawned program's own
 * network use (git, the runtimes) is out of its reach. The marketing site
 * (`apps/site`), the e2e and design-system apps and the dev-only packages are
 * not scanned.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CENSUS_PATH = 'scripts/outbound-census/census.json';
const DEPENDENCIES_PATH = 'scripts/outbound-census/dependencies.json';

/** Workspace packages that never ship in the product: build, lint and test tooling. */
const DEV_ONLY_PACKAGES = new Set([
  'ci-steward',
  'eslint-config',
  'evals',
  'heavy-slot',
  'test-utils',
  'typescript-config',
]);

/** The shipped apps: the server, the browser app, the desktop app and the Community server. */
const SHIPPED_APPS = ['apps/server', 'apps/client', 'apps/desktop', 'apps/space'];

/** The shipped workspace packages, by directory. */
function shippedPackages(): string[] {
  return readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !DEV_ONLY_PACKAGES.has(entry.name))
    .map((entry) => `packages/${entry.name}`);
}

/**
 * The shipped product source this census covers: the apps' and packages'
 * `src/`. `apps/space` holds no source of its own (its code is in
 * `apps/server/src/services/spaces` and `apps/client/src/space`), so it adds
 * only dependencies.
 */
const ROOTS = [...SHIPPED_APPS.filter((app) => app !== 'apps/space'), ...shippedPackages()].map(
  (dir) => `${dir}/src/`
);

/** One census entry, as `census.json` holds it. */
interface CensusEntry {
  file: string;
  destination: string;
  class: 'consent' | 'feature';
  reason?: string;
  offSwitch?: string;
  gatedBy?: string[];
}

/** The reviewed dependency list, as `dependencies.json` holds it. */
interface DependencyReview {
  network: Record<string, string>;
  runtime: Record<string, string>;
  covered: Record<string, string>;
  offline: string[];
}

function isTestPath(file: string): boolean {
  return (
    file.includes('/__tests__/') ||
    file.includes('/__mocks__/') ||
    file.includes('/__fixtures__/') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    file.includes('/test-utils/')
  );
}

/** Shipped source under {@link ROOTS}, as git sees it (tracked and new). */
function shippedSources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .trim()
    .split('\n')
    .filter(
      (file) =>
        file.length > 0 &&
        ROOTS.some((root) => file.startsWith(root)) &&
        !file.includes('/node_modules/') &&
        !file.includes('/dist/') &&
        !isTestPath(file) &&
        existsSync(path.join(ROOT, file))
    );
}

/**
 * Every third-party runtime dependency of a shipped app or package
 * (`dependencies` and `optionalDependencies`; workspace packages excluded).
 */
function shippedDependencies(): Set<string> {
  const names = new Set<string>();
  for (const dir of [...SHIPPED_APPS, ...shippedPackages()]) {
    const manifest = path.join(ROOT, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
      if (!/^@dorkos\/|^@dork-labs\/|^dorkos$/.test(name)) names.add(name);
  }
  return names;
}

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

const census = JSON.parse(read(CENSUS_PATH)) as CensusEntry[];
const byFile = new Map(census.map((entry) => [entry.file, entry]));
const review = JSON.parse(read(DEPENDENCIES_PATH)) as DependencyReview;
const NETWORK_MODULES: ReadonlySet<string> = new Set(Object.keys(review.network));

describe('outbound destination census (DOR-4990)', () => {
  /** Each file that uses a network primitive, and what it uses. Filled once, before the tests. */
  const senders = new Map<string, string[]>();
  beforeAll(() => {
    for (const file of shippedSources()) {
      const uses = findNetworkUses(file, read(file), NETWORK_MODULES);
      if (uses.length > 0) senders.set(file, uses);
    }
  }, 120_000);

  it('finds the senders it is meant to find', () => {
    // A scan that matched nothing would pass every other check here.
    expect(senders.has('apps/server/src/services/core/update-checker.ts')).toBe(true);
    expect(senders.has('apps/desktop/src/main/auto-updater.ts')).toBe(true);
  });

  it('lists every file that reaches the network', () => {
    const missing = [...senders.keys()].filter((file) => !byFile.has(file));
    expect(
      missing.map((file) => `${file}\n    ${senders.get(file)!.join('\n    ')}`),
      `These files reach the network but are not in ${CENSUS_PATH}. Add one entry per file ` +
        `with "file", "destination" and "class": "consent" when the send is gated on ` +
        `${CONSENT_MODULE} (the file, or each file in "gatedBy", must call one of ` +
        `${[...CONSENT_HELPERS].join(', ')}), or "feature" with a one-line "reason" and ` +
        `its "offSwitch" when it is not telemetry.`
    ).toEqual([]);
  });

  it('lists no file that no longer reaches the network', () => {
    const stale = census.map((entry) => entry.file).filter((file) => !senders.has(file));
    expect(stale, `Remove these entries from ${CENSUS_PATH}.`).toEqual([]);
  });

  it('lists each file once, in order', () => {
    const files = census.map((entry) => entry.file);
    expect(files).toEqual([...new Set(files)].sort());
  });

  it.each(census.filter((entry) => entry.class === 'consent'))(
    '$file is gated on the shared consent helper',
    (entry) => {
      for (const gate of entry.gatedBy ?? [entry.file])
        expect(callsConsentHelper(read(gate), gate), `${gate} must call a consent helper`).toBe(
          true
        );
    }
  );

  it.each(census.filter((entry) => entry.class === 'feature'))(
    '$file says why it is not telemetry and how to turn it off',
    (entry) => {
      expect(entry.reason?.trim()).toBeTruthy();
      expect(entry.offSwitch?.trim()).toBeTruthy();
      expect(entry.gatedBy).toBeUndefined();
    }
  );

  it('accepts only the two classes, each with a destination', () => {
    for (const entry of census) {
      expect(['consent', 'feature']).toContain(entry.class);
      expect(entry.destination.trim()).toBeTruthy();
    }
  });
});

describe('the reviewed dependency list', () => {
  const groups = [
    Object.keys(review.network),
    Object.keys(review.runtime),
    Object.keys(review.covered),
    review.offline,
  ];
  const reviewed = groups.flat();

  it('reviews every runtime dependency of a shipped package', () => {
    const unreviewed = [...shippedDependencies()].filter((name) => !reviewed.includes(name));
    expect(
      unreviewed.sort(),
      `Add each of these to ${DEPENDENCIES_PATH}: "network" (with what it requests) when ` +
        `importing it reaches the network, "runtime" for an agent runtime, "covered" (with the ` +
        `scan rule) when a narrower rule counts it, or "offline" when it makes no requests.`
    ).toEqual([]);
  });

  it('reviews each dependency once and only shipped ones', () => {
    expect(reviewed.length).toBe(new Set(reviewed).size);
    const shipped = shippedDependencies();
    expect(reviewed.filter((name) => !shipped.has(name)).sort()).toEqual([]);
  });

  it('says why for every network, runtime and covered dependency', () => {
    for (const reasons of [review.network, review.runtime, review.covered])
      for (const reason of Object.values(reasons)) expect(reason.trim()).toBeTruthy();
  });
});

describe('the network-use scan', () => {
  const scan = (source: string, file = 'apps/server/src/a.ts') =>
    findNetworkUses(file, source, new Set(['grammy', 'web-push']));

  it('follows renamed imports and other spellings of the global', () => {
    const source = [
      "import web from 'node:https';",
      "import * as plain from 'http';",
      "import Socket, { WebSocket as Ws } from 'ws';",
      "import { net as electronNet } from 'electron';",
      "import type { Bot } from 'grammy';",
      "const raw = require('node:net');",
      'web.request(url);',
      'plain.get(url);',
      'new Socket(url);',
      'new Ws(url);',
      'electronNet.fetch(url);',
      'raw.connect(port);',
      "globalThis['fetch'](url);",
      'window.fetch(url);',
    ].join('\n');
    // The type-only `grammy` import on line 5 is not network use.
    expect(scan(source)).toEqual([
      '7: web.request',
      '8: plain.get',
      '9: new Socket',
      '10: new Ws',
      '11: electronNet.fetch (electron)',
      '12: raw.connect',
      "13: globalThis['fetch']",
      '14: window.fetch',
    ]);
  });

  it('finds the global taken apart, Electron through a default import and a nested navigator', () => {
    const source = [
      "import electron from 'electron';",
      'const { fetch } = globalThis;',
      'electron.net.fetch(url);',
      'window.navigator.sendBeacon(url, body);',
      'new XMLHttpRequest();',
    ].join('\n');
    expect(scan(source)).toEqual([
      '2: fetch from globalThis',
      '3: electron.net.fetch (electron)',
      '4: window.navigator.sendBeacon',
      '5: new XMLHttpRequest',
    ]);
  });

  it('counts a value import of a listed network package and a social sign-in setup', () => {
    const source = [
      "import webpush from 'web-push';",
      "import { Bot } from 'grammy';",
      "import { Composer } from 'grammy/web';",
      'betterAuth({ socialProviders: { github } });',
    ].join('\n');
    expect(scan(source)).toEqual([
      '1: import web-push',
      '2: import grammy',
      '3: import grammy/web',
      '4: socialProviders (outside sign-in)',
    ]);
  });

  it('treats a same-origin path as the app talking to its own server', () => {
    const source = [
      "fetch('/api/sessions');",
      'fetch(`/api/sessions/${id}`);',
      "new EventSource('/api/events');",
      "fetch('//cdn.example/x');",
      'fetch(`${base}/api/x`);',
      'fetch(`/${host}/x`);',
      "fetch(extensionApiUrl('/extensions'));",
      'fetch(`${resolveApiBaseUrl()}/api/x`);',
    ].join('\n');
    // A template that starts with "/" alone can become "//host", so line 6 counts.
    expect(scan(source, 'apps/client/src/a.ts')).toEqual(['4: fetch', '5: fetch', '6: fetch']);
  });

  it('trusts the browser app’s server-URL helpers only in the browser app', () => {
    const source = "fetch(extensionApiUrl('/extensions'));";
    expect(scan(source, 'apps/client/src/a.ts')).toEqual([]);
    expect(scan(source, 'apps/server/src/a.ts')).toEqual(['1: fetch']);
  });

  it('ignores comments, names, types and browser scripts in strings', () => {
    const source = [
      '// await fetch(url)',
      'type F = typeof fetch;',
      'const o = { fetch: 1 };',
      'class C { async fetch(x: string) { return this.fetch(x); } }',
      "const page = `<script>fetch('/api/x')</script>`;",
      'function f(fetch: F) { return fetch(url); }',
      'function g() { const { fetch } = deps; return fetch(url); }',
    ].join('\n');
    expect(scan(source)).toEqual([]);
  });

  it('finds a call, a default value and a socket', () => {
    const source = [
      'await fetch(url);',
      'const f = deps.fetch ?? fetch;',
      'new WebSocket(url);',
      "import { request } from 'node:https';",
    ].join('\n');
    expect(scan(source)).toEqual([
      '1: fetch',
      '2: fetch',
      '3: new WebSocket',
      '4: request from node:https',
    ]);
  });
});
