/**
 * Census: every variable DorkOS reads is classified for the project `.env`,
 * allowed or dropped. The names come from the two schemas themselves, so a
 * new variable fails here until someone decides (`lib/project-env.ts`).
 */
import { describe, expect, it } from 'vitest';
import { cliEnvSchema } from '../../env.js';
import { DORKOS_READS_UNPREFIXED, PROJECT_ENV_ALLOWED, projectEnvMaySet } from '../project-env.js';

/** The server's schema, read from its source as the server parses it. */
async function serverKeys(): Promise<string[]> {
  const url = new URL('../../../../../apps/server/src/env.ts', import.meta.url).href;
  const { serverEnvSchema } = (await import(url)) as { serverEnvSchema: { shape: object } };
  return Object.keys(serverEnvSchema.shape);
}

describe('the project .env census', () => {
  it('classifies every variable the server and the CLI read', async () => {
    const keys = [...(await serverKeys()), ...Object.keys(cliEnvSchema.shape)];
    expect(keys.length).toBeGreaterThan(50);
    const unclassified = keys.filter(
      (key) =>
        !PROJECT_ENV_ALLOWED.has(key) &&
        !/^DORK(OS)?_/.test(key) &&
        !DORKOS_READS_UNPREFIXED.has(key)
    );
    expect(unclassified).toEqual([]);
    const loadable = keys.filter(projectEnvMaySet);
    expect(new Set(loadable)).toEqual(PROJECT_ENV_ALLOWED);
  });
});
