import { createHash } from 'node:crypto';
import type { InstallationConfiguration } from './contracts.js';
import { resolveInstalledNativeJournal } from './packaged.js';
import { createDarwinEngineProcesses } from '../darwin-engine-processes.js';
import { createDarwinProcessObserver, darwinBirth } from '../darwin-process-observer.js';

/** Verify the actual installed native observer against this original server process.
 * This read-only support check does not create a Page or confer browser authority.
 * Original native calls retain their own process/pipe custody until natural settlement. */
export async function verifyInstalledNativeJournal(configuration: InstallationConfiguration) {
  const journal = await resolveInstalledNativeJournal(configuration);
  if (journal.continuous !== true) throw new Error('NATIVE_MODE_UNAVAILABLE');
  const observer = createDarwinProcessObserver(journal.artifact);
  const inspect = observer.inspect.bind(observer);
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const before = await inspect([process.pid]);
  const original = before.processes[0];
  if (original?.kind !== 'present' || original.zombie || original.identity.pid !== process.pid)
    throw new Error('NATIVE_MODE_UNAVAILABLE');
  const manager = darwinBirth(original.identity);
  const after = await inspect([process.pid]);
  const last = after.processes[0];
  if (
    last?.kind !== 'present' ||
    last.zombie ||
    last.identity.pid !== process.pid ||
    darwinBirth(last.identity).birth !== manager.birth ||
    after.bootSeconds !== before.bootSeconds ||
    after.bootMicroseconds !== before.bootMicroseconds ||
    digest(await resolveInstalledNativeJournal(configuration)) !== digest(journal)
  )
    throw new Error('NATIVE_MODE_UNAVAILABLE');
  return Object.freeze({
    journal,
    manager,
    processes: createDarwinEngineProcesses(journal.artifact).processes,
    bootScope: Object.freeze({
      kind: 'observed' as const,
      value: `darwin-boot:${before.bootSeconds}:${before.bootMicroseconds}`,
      sourceIdentityDigest: journal.artifact.sha256,
    }),
  });
}
