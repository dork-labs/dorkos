import { inject, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validRunDescriptor } from './metadata.js';
import { acquireWorkerCustody } from './worker.js';
import type {} from './global-setup.js';

it('provides only cloneable custody metadata to the actual server project worker', async () => {
  const provided = inject('openCodeCustody');
  expect(provided).toEqual(structuredClone(provided));
  if (process.platform === 'win32') {
    expect(provided).toEqual({ kind: 'unavailable', reason: 'windows-acl-unverified' });
  } else {
    expect(provided.kind).toBe('available');
    if (provided.kind !== 'available') throw new Error('Expected server-project custody metadata');
    expect(Object.keys(provided).sort()).toEqual(['inbox', 'kind', 'run']);
    expect(Object.keys(provided.run).sort()).toEqual([
      'capability',
      'generation',
      'runId',
      'version',
    ]);
    expect(validRunDescriptor(provided.run)).toBe(true);
    expect(isAbsolute(provided.inbox)).toBe(true);
    expect((await stat(provided.inbox)).mode & 0o077).toBe(0);
  }
  const connect = vi.fn();
  await expect(
    acquireWorkerCustody({
      admitted: false,
      provided,
      connect,
      deadline: null,
      signal: new AbortController().signal,
    })
  ).rejects.toThrow(/gate/);
  expect(connect).not.toHaveBeenCalled();
});
