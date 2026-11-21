/** Server-project custody metadata is owned by the actual Vitest main. */
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import type {} from 'vitest';
import type { TestProject } from 'vitest/node';
import {
  openCustodyGeneration,
  type GenerationEndpoint,
  type OpenCustodyEndpoint,
  type ProvidedCustody,
} from './run-main.js';

declare module 'vitest' {
  export interface ProvidedContext {
    openCodeCustody: ProvidedCustody;
  }
}

type Project = Pick<TestProject, 'provide' | 'onTestsRerun'>;

/** Bind a test-private endpoint factory without starting one during global setup. */
export function createCustodySetup(
  open: OpenCustodyEndpoint,
  parent = tmpdir(),
  createEndpoint?: () => GenerationEndpoint
) {
  return async (project: Project): Promise<() => Promise<void>> => {
    if (process.platform === 'win32') {
      project.provide('openCodeCustody', { kind: 'unavailable', reason: 'windows-acl-unverified' });
      return async () => {};
    }

    const runId = randomBytes(16).toString('hex');
    let generation = await openCustodyGeneration(parent, runId, createEndpoint?.() ?? open);
    let stopped = false;
    let rotation = Promise.resolve();
    try {
      project.provide('openCodeCustody', generation.provided);

      project.onTestsRerun((tests) => {
        if (stopped || !tests.some((test) => test.project === project)) return;
        // Revoke immediately, before any new worker can receive metadata.
        void generation.stop();
        rotation = rotation.then(async () => {
          if ((await generation.stop()) !== 'closed')
            throw new Error('OpenCode custody generation cleanup could not be confirmed');
          if (stopped) return;
          generation = await openCustodyGeneration(parent, runId, createEndpoint?.() ?? open);
          if (!stopped) project.provide('openCodeCustody', generation.provided);
        });
        return rotation;
      });
    } catch (primary) {
      stopped = true;
      if ((await generation.stop()) !== 'closed')
        throw new AggregateError(
          [primary, new Error('OpenCode custody generation cleanup could not be confirmed')],
          'OpenCode custody setup failed and cleanup is uncertain',
          { cause: primary }
        );
      throw primary;
    }

    return async () => {
      stopped = true;
      const retired = generation.stop();
      const [rotationResult, oldResult] = await Promise.allSettled([rotation, retired]);
      const current = await generation.stop();
      if (
        rotationResult.status !== 'fulfilled' ||
        oldResult.status !== 'fulfilled' ||
        oldResult.value !== 'closed' ||
        current !== 'closed'
      )
        throw new Error('OpenCode custody generation cleanup could not be confirmed');
    };
  };
}

/** Register the backend in the actual server project. Endpoint work stays lazy. */
export default async function setup(project: Project) {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const { createPosixCustodySetup } = await import('./posix-endpoint.js');
    return createPosixCustodySetup(() => {
      const directory = process.env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_DIR;
      const manifestSha256 = process.env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_MANIFEST_SHA256;
      if (!directory || !manifestSha256)
        throw new Error('The reviewed Darwin custody observer descriptor is required');
      return { directory, manifestSha256 };
    })(project);
  }
  return createCustodySetup(async () => {
    throw new Error('No OpenCode custody endpoint is composed for this platform');
  })(project);
}
