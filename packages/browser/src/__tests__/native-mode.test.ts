import { afterEach, expect, it, vi } from 'vitest';
import { verifyInstalledNativeJournal } from '../runtime/installation/native-mode.js';
import type { InstallationConfiguration } from '../runtime/installation/contracts.js';
const controls = vi.hoisted(() => ({ resolve: vi.fn(), observer: vi.fn() }));
vi.mock('../runtime/installation/packaged.js', () => ({
  resolveInstalledNativeJournal: controls.resolve,
}));
vi.mock('../runtime/darwin-process-observer.js', async (original) => ({
  ...(await original<typeof import('../runtime/darwin-process-observer.js')>()),
  createDarwinProcessObserver: controls.observer,
}));
afterEach(() => vi.clearAllMocks());
// Explicit source-double contract controls; they do not run or qualify native Darwin bytes.
const configuration = {} as InstallationConfiguration;
const journal = {
  artifact: { path: '/source-double/observer', sha256: 'a'.repeat(64) },
  workerPath: '/source-double/journal',
  browserWorkerPath: '/source-double/browser',
  duration: 30000,
  maxGap: 5000,
  continuous: true,
};
const batch = () => ({
  version: 1,
  bootSeconds: '10',
  bootMicroseconds: '0',
  processes: [
    {
      kind: 'present',
      identity: { pid: process.pid, seconds: '20', microseconds: '0' },
      zombie: false,
      parentPid: 1,
    },
  ],
});
it.each([
  'matched',
  'changed-birth',
  'changed-boot',
  'changed-assets',
  'finite',
  'false-rejection',
] as const)(
  'requires the actual original observer and matching live/native package facts (%s)',
  async (mode) => {
    controls.resolve
      .mockReset()
      .mockResolvedValue(mode === 'finite' ? { ...journal, continuous: false } : journal);
    const first = batch(),
      second = batch();
    if (mode === 'changed-birth') second.processes[0].identity.seconds = '21';
    if (mode === 'changed-boot') second.bootSeconds = '11';
    if (mode === 'changed-assets')
      controls.resolve.mockResolvedValueOnce(journal).mockResolvedValue({
        ...journal,
        artifact: { ...journal.artifact, sha256: 'b'.repeat(64) },
      });
    const inspect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const original = { inspect };
    if (mode === 'false-rejection') inspect.mockReset().mockRejectedValue(false);
    controls.observer.mockReset().mockReturnValue(original);
    if (mode === 'matched')
      inspect.mockImplementationOnce(async function (this: unknown) {
        expect(this).toBe(original);
        original.inspect = vi.fn(() => {
          throw new Error('replacement must not run');
        });
        return first;
      });
    const operation = verifyInstalledNativeJournal(configuration);
    if (mode === 'matched') {
      const result = await operation;
      expect(result.manager).toEqual({ pid: process.pid, birth: 'darwin-bsd-start:20:0' });
      expect(result.bootScope).toEqual({
        kind: 'observed',
        value: 'darwin-boot:10:0',
        sourceIdentityDigest: journal.artifact.sha256,
      });
      expect(inspect).toHaveBeenCalledTimes(2);
    } else if (mode === 'false-rejection') await expect(operation).rejects.toBe(false);
    else await expect(operation).rejects.toThrow('NATIVE_MODE_UNAVAILABLE');
    if (mode === 'finite') expect(inspect).not.toHaveBeenCalled();
  }
);
