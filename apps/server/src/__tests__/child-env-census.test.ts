/**
 * Census: every child process the server, the CLI and the packages they run
 * start gets its environment from `childEnvironment` (DOR-5481). A start
 * whose `env:` is not a `childEnvironment(...)` call (or a listed wrapper
 * built on one) must be a row in `child-env-census.json`, with a count and a
 * reason; a start with no `env:` inherits the whole `process.env` and fails
 * unless its row says why it is safe. No `env:` may spread `process.env`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanChildStarts } from './child-env-scan.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const census = JSON.parse(
  readFileSync(new URL('./child-env-census.json', import.meta.url), 'utf8')
) as {
  wrappers: Record<string, string>;
  sites: Record<string, { kind: string; reason: string; starts: string[] }>;
};

/** Where DorkOS's running code lives: the server, the CLI, and the packages they start children from. */
const ROOTS = [
  'apps/server/src',
  'packages/cli/src',
  'packages/shared/src',
  'packages/doe/src',
  'packages/browser/src',
  'packages/keep-awake/src',
];

const HELPERS = ['childEnvironment', ...Object.keys(census.wrappers)];

function sourceFiles(): string[] {
  // Untracked files count too: a new file is a new start before it is committed.
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (file) =>
        /\.(ts|tsx|mts)$/.test(file) && !/(__tests__|__fixtures__)\/|\.test\.|\.d\.ts$/.test(file)
    );
}

function read(file: string): string {
  return readFileSync(`${repoRoot}${file}`, 'utf8');
}

describe('the child environment census', () => {
  const sites = census.sites;

  it('finds every start that skips the helper, each exactly as its row names it', () => {
    const found: Record<string, string[]> = {};
    let helperBuilt = 0;
    for (const file of sourceFiles()) {
      const text = read(file);
      if (!/child_process|node-pty|StdioClientTransport/.test(text)) continue;
      const scan = scanChildStarts(file, text, HELPERS);
      helperBuilt += scan.helperBuilt;
      if (scan.unlisted.length > 0) found[file] = scan.unlisted.map((start) => start.site).sort();
    }
    // A start swapped to another env (process.env included) no longer matches its row.
    expect(found).toEqual(
      Object.fromEntries(Object.entries(sites).map(([file, row]) => [file, [...row.starts].sort()]))
    );
    // Starts that build their env at the call. A drop means one moved off the
    // helper; a rise is a new helper-built start: update the count.
    expect(helperBuilt).toBe(50);
  });

  it('lists no start that inherits the whole process.env', () => {
    for (const [file, row] of Object.entries(sites))
      for (const start of row.starts)
        expect(start, file).not.toMatch(/env: \(none\)$|process\.env/);
  });

  it('keeps GITHUB_TOKEN only for git on a repository DorkOS just made', () => {
    const fetchers = sourceFiles().filter((file) =>
      /childEnvironment\('git-fetch'/.test(read(file))
    );
    expect(fetchers.sort()).toEqual([
      // hardenedGitEnv: template clones and marketplace fetches into new folders.
      'apps/server/src/lib/git-safety.ts',
      // `gh auth token`, before a template download.
      'apps/server/src/services/core/agent-templates/template-downloader.ts',
      // The workspace clone into a new folder, its one unaudited git call.
      'apps/server/src/services/workspace/providers/git.ts',
    ]);
  });

  it('lets no env spread process.env, and no runtime pass it whole', () => {
    const leaks: string[] = [];
    for (const file of sourceFiles()) {
      const text = read(file);
      for (const site of scanChildStarts(file, text, HELPERS).processEnvLeaks) {
        const whole = /env:\s*process\.env\s*$/.test(site.slice(site.indexOf(':') + 1).trim());
        const runtime = /services\/runtimes\/|packages\/doe\//.test(file);
        if (!whole || runtime) leaks.push(`${file}:${site}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('builds runtime environments only through childEnvironment', () => {
    const callers = sourceFiles().filter((file) =>
      /\b(runtimeEnvironment|projectRuntimeEnvironment)\(/.test(read(file))
    );
    expect(callers.sort()).toEqual([
      'apps/server/src/services/runtimes/shared/runtime-environment-config.ts',
      'apps/server/src/services/runtimes/shared/runtime-environment.ts',
    ]);
  });

  it('accepts a wrapper only when it builds on childEnvironment', () => {
    for (const [name, file] of Object.entries(census.wrappers)) {
      const text = read(file);
      const start = text.search(new RegExp(`export function ${name}\\(`));
      expect(start, name).toBeGreaterThan(-1);
      const body = text.slice(start, text.indexOf('\n}\n', start));
      expect(body, name).toMatch(/childEnvironment\(/);
    }
  });

  it('gives every row a kind and a reason', () => {
    for (const [file, row] of Object.entries(sites)) {
      expect(['owned', 'forwarded'], file).toContain(row.kind);
      expect(row.reason.length, file).toBeGreaterThan(20);
      expect(row.starts.length, file).toBeGreaterThan(0);
    }
  });

  it('fails a start added without the helper', () => {
    const bare = "import { spawn } from 'node:child_process';\nspawn('x', []);\n";
    expect(scanChildStarts('fixture.ts', bare, HELPERS).unlisted).toEqual([
      { line: 2, site: 'spawn env: (none)' },
    ]);
    for (const source of [
      "import { execFile as run } from 'node:child_process';\nrun('x', [], { cwd: '/' });",
      "import * as cp from 'child_process';\ncp.execSync('x', { env: process.env });",
      "import { execFile } from 'node:child_process';\nconst go = promisify(execFile);\ngo('x', []);",
      "const { exec } = await import('node:child_process');\nexec('x');",
      "import { spawn } from 'node:child_process';\nconst s = spawn as unknown;",
      "import * as pty from 'node-pty';\npty.spawn('sh', [], { env: buildEnv() });",
    ])
      expect(scanChildStarts('fixture.ts', source, HELPERS).unlisted, source).toHaveLength(1);
    const built =
      "import { spawn } from 'node:child_process';\nspawn('x', [], { env: childEnvironment('os-helper') });";
    expect(scanChildStarts('fixture.ts', built, HELPERS)).toMatchObject({
      unlisted: [],
      helperBuilt: 1,
    });
    const spread =
      "import { spawn } from 'node:child_process';\nspawn('x', [], { env: { ...process.env } });";
    expect(scanChildStarts('fixture.ts', spread, HELPERS).processEnvLeaks).toHaveLength(1);
  });

  it('fails a listed start swapped to process.env', () => {
    const file = 'apps/server/src/services/runtimes/codex/app-server/protocol/snapshot.ts';
    const source = read(file);
    const listed = "{ encoding: 'utf8', env }";
    expect(source).toContain(listed);
    const swapped = scanChildStarts(
      file,
      source.replace(listed, "{ encoding: 'utf8', env: process.env }"),
      HELPERS
    ).unlisted.map((start) => start.site);
    expect(swapped.sort()).not.toEqual([...sites[file]!.starts].sort());
    expect(swapped).toContain('execFileSync env: process.env');
  });
});
