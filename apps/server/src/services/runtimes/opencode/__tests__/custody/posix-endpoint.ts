/** Explicit POSIX server-test composition. Importing and constructing it start nothing. */
import { lstat, realpath } from 'node:fs/promises';
import {
  allocatePosixSocketDirectory,
  connectPosixScope,
  openPosixGuardian,
  validateDarwinObserver,
} from '@dorkos/test-utils/run-custody/posix';
import { createCustodySetup } from './global-setup.js';
import type { ConnectionDescriptor } from './metadata.js';
import type { GenerationEndpoint } from './run-main.js';

type ReviewedObserver = Readonly<{ directory: string; manifestSha256: string }>;
const unavailable = async (): Promise<never> => {
  throw new Error('POSIX custody endpoint is unavailable');
};

/** A configured Darwin descriptor is selected by the main only, after the first approved request. */
export function createPosixGeneration(selectDarwin: () => ReviewedObserver): GenerationEndpoint {
  let allocation: ReturnType<typeof allocatePosixSocketDirectory> | undefined;
  let selected: ReviewedObserver | undefined;

  return {
    async open(request, signal) {
      function requireCurrent() {
        if (signal.aborted || (request.deadline !== null && Date.now() >= request.deadline))
          throw new Error('POSIX custody acquisition expired');
      }

      if (process.platform !== 'darwin' && process.platform !== 'linux') return unavailable();
      requireCurrent();
      let observer: string | undefined;
      if (process.platform === 'darwin') {
        selected ??= Object.freeze({ ...selectDarwin() });
        observer = (await validateDarwinObserver(selected)).path;
        requireCurrent();
      }
      const { directory } = await (allocation ??= allocatePosixSocketDirectory());
      requireCurrent();
      const handle = await openPosixGuardian({ directory, observer, signal });
      return {
        ...handle,
        connection: { ...handle.connection, transport: 'posix', directory },
      };
    },
    async remove(deadline) {
      if (!allocation) return 'closed';
      const directory = await allocation;
      if (Date.now() >= deadline) return 'cleanup-uncertain';
      return directory.remove();
    },
  };
}

/** Compose lazy POSIX ownership for the server Vitest main and isolated proof setup. */
export function createPosixCustodySetup(selectDarwin: () => ReviewedObserver, parent?: string) {
  return createCustodySetup(unavailable, parent, () => createPosixGeneration(selectDarwin));
}

/** Connect only to the route selected by the authenticated reply. */
export async function connectPosixWorker(reply: ConnectionDescriptor, signal: AbortSignal) {
  if (
    reply.transport !== 'posix' ||
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    typeof process.getuid !== 'function'
  )
    throw new Error('POSIX custody route is unavailable');
  const canonical = await realpath(reply.directory);
  const stat = await lstat(reply.directory);
  if (
    canonical !== reply.directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700 ||
    signal.aborted
  )
    throw new Error('POSIX custody route could not be verified');
  return connectPosixScope({
    directory: reply.directory,
    connection: { endpointId: reply.endpointId, token: reply.token },
    signal,
    graceMs: 3_000,
  });
}
