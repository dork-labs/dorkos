import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  parseValidateMarketplaceArgs,
  runValidateMarketplace,
} from '../package-validate-marketplace.js';

const validMarketplace = {
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  plugins: [
    {
      name: 'code-reviewer',
      source: { source: 'github', repo: 'dork-labs/code-reviewer' },
      description: 'Reviews PRs',
    },
    {
      name: 'docs-keeper',
      source: { source: 'github', repo: 'dork-labs/docs-keeper' },
      description: 'Keeps docs in sync',
    },
  ],
};

/**
 * Build a temp directory with a `marketplace.json` containing `payload`
 * and return the absolute path to that file.
 */
function writeMarketplaceFixture(tmpRoot: string, payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'marketplace-'));
  const filePath = path.join(dir, 'marketplace.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

/**
 * Build a `.claude-plugin/marketplace.json` layout (and optional sidecar)
 * inside `tmpRoot` so the validator takes its sidecar-lookup path.
 */
function writeClaudePluginFixture(
  tmpRoot: string,
  marketplacePayload: unknown,
  sidecarPayload?: unknown
): string {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'mp-'));
  const claudeDir = path.join(root, '.claude-plugin');
  fs.mkdirSync(claudeDir, { recursive: true });
  const marketplacePath = path.join(claudeDir, 'marketplace.json');
  fs.writeFileSync(marketplacePath, JSON.stringify(marketplacePayload, null, 2));
  if (sidecarPayload !== undefined) {
    fs.writeFileSync(path.join(claudeDir, 'dorkos.json'), JSON.stringify(sidecarPayload, null, 2));
  }
  return marketplacePath;
}

/**
 * Collapse all `process.stdout.write` / `process.stderr.write` invocations
 * captured by a Vitest spy into a single string.
 */
function collectWrites(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy.mock.calls as unknown[][]).map((call) => String(call[0])).join('');
}

describe('parseValidateMarketplaceArgs', () => {
  it('returns the first positional argument as path', () => {
    expect(parseValidateMarketplaceArgs(['./marketplace.json'])).toEqual({
      path: './marketplace.json',
    });
  });

  it('ignores flag-style arguments when extracting positionals', () => {
    expect(parseValidateMarketplaceArgs(['--quiet', './marketplace.json'])).toEqual({
      path: './marketplace.json',
    });
  });

  it('throws when no positional argument is supplied', () => {
    expect(() => parseValidateMarketplaceArgs([])).toThrow(/Missing required <path>/);
  });

  it('throws when only flags are supplied', () => {
    expect(() => parseValidateMarketplaceArgs(['--quiet'])).toThrow(/Missing required <path>/);
  });
});

describe('runValidateMarketplace', () => {
  let tmpRoot: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dorkos-vm-${randomUUID()}-`));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns 0 and prints the full passing summary on a valid fixture', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, validMarketplace);

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(0);
    const stdoutCalls = collectWrites(stdoutSpy);
    expect(stdoutCalls).toContain('[OK]   DorkOS schema');
    expect(stdoutCalls).toContain('[OK]   Claude Code compatibility');
    expect(stdoutCalls).toContain('[OK]   Marketplace name not reserved');
    expect(stdoutCalls).toContain('All checks passed');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns 1 and writes to stderr when the file is missing', async () => {
    const missingPath = path.join(tmpRoot, 'does-not-exist.json');

    const exitCode = await runValidateMarketplace({ path: missingPath });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain(`Failed to read ${missingPath}`);
  });

  it('returns 1 when the marketplace.json is missing required fields', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, {
      name: 'dorkos',
      plugins: [],
      // Missing required `owner`
    });

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] DorkOS schema');
    expect(stderrCalls.toLowerCase()).toContain('owner');
  });

  it('returns 1 when the file contains invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'marketplace-'));
    const filePath = path.join(dir, 'marketplace.json');
    fs.writeFileSync(filePath, '{ this is not valid json');

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] DorkOS schema');
    expect(stderrCalls).toContain('Invalid JSON');
  });

  it('returns 2 when inline x-dorkos makes the document fail CC strict validation', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, {
      name: 'dorkos',
      owner: { name: 'Dork Labs' },
      plugins: [
        {
          name: 'leaky',
          source: { source: 'github', repo: 'dork-labs/leaky' },
          'x-dorkos': { type: 'agent' },
        },
      ],
    });

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(2);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] Claude Code compatibility');
    expect(stderrCalls.toLowerCase()).toContain('unrecognized');
  });

  it('returns 1 on reserved marketplace names', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, {
      ...validMarketplace,
      name: 'claude-plugins-official',
    });

    const exitCode = await runValidateMarketplace({ path: filePath });

    // The DorkOS schema already rejects reserved names via `.refine()`,
    // so this case surfaces as a schema failure rather than the later
    // reserved-name guard.
    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls.toLowerCase()).toContain('reserved');
  });

  it('detects and parses the optional .claude-plugin/dorkos.json sidecar', async () => {
    const filePath = writeClaudePluginFixture(tmpRoot, validMarketplace, {
      schemaVersion: 1,
      plugins: {
        'code-reviewer': { type: 'agent' },
        'docs-keeper': { type: 'agent' },
      },
    });

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(0);
    const stdoutCalls = collectWrites(stdoutSpy);
    expect(stdoutCalls).toContain('[OK]   Sidecar present and valid (2 plugins)');
  });

  it('treats missing sidecar as optional under .claude-plugin/', async () => {
    const filePath = writeClaudePluginFixture(tmpRoot, validMarketplace);

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(0);
    const stdoutCalls = collectWrites(stdoutSpy);
    expect(stdoutCalls).toContain('[OK]   Sidecar absent');
  });

  it('returns 1 when the sidecar is present but invalid', async () => {
    const filePath = writeClaudePluginFixture(tmpRoot, validMarketplace, {
      schemaVersion: 99, // not literal 1
      plugins: {},
    });

    const exitCode = await runValidateMarketplace({ path: filePath });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] Sidecar dorkos.json');
  });

  it('resolves relative paths against process.cwd()', async () => {
    const filePath = writeMarketplaceFixture(tmpRoot, validMarketplace);

    const originalCwd = process.cwd();
    try {
      process.chdir(path.dirname(filePath));
      const exitCode = await runValidateMarketplace({ path: './marketplace.json' });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
