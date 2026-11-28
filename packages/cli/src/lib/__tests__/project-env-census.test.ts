/**
 * Census: every variable DorkOS reads is classified exactly once, as a
 * setting the project `.env` may give, a name DorkOS owns (kept from every
 * child that runs project work), or a name that belongs to the computer. The
 * names come from the two schemas and from every direct `process.env` read in
 * the server's and the CLI's source, so a new one fails here until someone
 * decides (`@dorkos/shared/project-environment`).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_ENV_ALLOWED,
  SYSTEM_NAMES_DORKOS_READS,
  isDorkosOwnedEnvName,
} from '@dorkos/shared/project-environment';
import { cliEnvSchema } from '../../env.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The server's schema, read from its source as the server parses it. */
async function serverKeys(): Promise<string[]> {
  const url = new URL('../../../../../apps/server/src/env.ts', import.meta.url).href;
  const { serverEnvSchema } = (await import(url)) as { serverEnvSchema: { shape: object } };
  return Object.keys(serverEnvSchema.shape);
}

/** Every `process.env.NAME` and `process.env['NAME']` read in non-test source. */
function directReads(): string[] {
  const files = execFileSync('git', ['ls-files', 'apps/server/src', 'packages/cli/src'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => /\.tsx?$/.test(file) && !/__tests__|\.test\.|__fixtures__/.test(file));
  const names = new Set<string>();
  for (const file of files) {
    const text = readFileSync(`${repoRoot}${file}`, 'utf8');
    for (const match of text.matchAll(
      /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g
    ))
      names.add(match[1] ?? match[2]!);
  }
  return [...names];
}

describe('the project .env census', () => {
  it('classifies every variable the server and the CLI read, exactly once', async () => {
    const keys = new Set([
      ...(await serverKeys()),
      ...Object.keys(cliEnvSchema.shape),
      ...directReads(),
    ]);
    expect(keys.size).toBeGreaterThan(60);
    const allowed = new Set<string>(PROJECT_ENV_ALLOWED);
    const classes = (key: string): number =>
      [allowed.has(key), isDorkosOwnedEnvName(key), SYSTEM_NAMES_DORKOS_READS.has(key)].filter(
        Boolean
      ).length;
    expect([...keys].filter((key) => classes(key) !== 1)).toEqual([]);
  });

  it('keeps the server’s tokens and keys among DorkOS’s own names', () => {
    for (const name of [
      'MCP_API_KEY',
      'NANGO_ENCRYPTION_KEY',
      'NGROK_AUTHTOKEN',
      'GITHUB_TOKEN',
      'BETTER_AUTH_SECRET',
      'COMMUNITY_DATABASE_URL',
      'TUNNEL_AUTH',
      'DORKOS_HUB_INSTANCE_KEY',
    ])
      expect(isDorkosOwnedEnvName(name), name).toBe(true);
  });
});
