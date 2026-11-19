/** Production shutdown must reach message cleanup before host runtimes/authority are released. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

describe('production messaging shutdown wiring', () => {
  it('stops messaging inside normal shutdown before runtimes and the final instance lock release', () => {
    const start = source.indexOf('async function shutdownServices(');
    const end = source.indexOf('// Graceful shutdown', start);
    const body = source.slice(start, end);
    const stop = body.indexOf('stopAgentMessageServices();');
    expect(stop).toBeGreaterThan(0);
    expect(body.indexOf('await shutdownRuntimes(')).toBeGreaterThan(stop);
    expect(body.indexOf('refs.releaseInstanceLock?.();')).toBeGreaterThan(stop);
  });
  it('reads no accessor that throws before startup set it up (DOR-4689)', () => {
    // A signal can arrive mid-boot; a service that never started is nothing to stop.
    const start = source.indexOf('async function shutdownServices(');
    const body = source.slice(start, source.indexOf('// Graceful shutdown', start));
    expect(body).toContain('stopCloudLinkManager();');
    expect(body).not.toMatch(/\bget\w+Manager\(\)/);
  });
  it('also stops messaging after a startup failure closes admission', () => {
    const body = source.slice(source.indexOf('start().catch(async'));
    expect(body.indexOf('stopAgentMessageServices();')).toBeGreaterThan(
      body.indexOf('mainRequestAdmission.close();')
    );
  });
});
