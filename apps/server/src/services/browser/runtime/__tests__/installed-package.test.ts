import { expect, it, onTestFinished, vi } from 'vitest';
import { resolveServerBrowserRuntimePackage } from '../installed-package.js';
const originals = vi.hoisted(() => ({
  resolve: vi.fn(),
  create: vi.fn(),
  home: vi.fn(),
}));
vi.mock('@dorkos/browser/runtime-installation', () => ({
  resolveInstalledRuntimeConfiguration: originals.resolve,
  createRuntimeInstallation: originals.create,
}));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: originals.home,
}));
function fixture() {
  const argv = process.argv;
  onTestFinished(() => {
    process.argv = argv;
    vi.clearAllMocks();
  });
  process.argv = [argv[0]!, '/owned/packaged/bin/cli.js'];
  const configuration = Object.freeze({
    cacheRoot: '/owned/runtime',
    libraryRoot: '/owned/library',
  });
  const installation = Object.freeze({
    verifyExisting: vi.fn(),
    inspectExisting: vi.fn(),
  });
  originals.home.mockReturnValue('/owned/dork-home');
  originals.resolve.mockResolvedValue(configuration);
  originals.create.mockReturnValue(installation);
  return { configuration, installation };
}
it('resolves only actual process entry and Dork home and retains the original installation facade', async () => {
  const f = fixture();
  const actual = await resolveServerBrowserRuntimePackage();
  expect(originals.resolve).toHaveBeenCalledExactlyOnceWith(
    new URL('file:///owned/packaged/bin/cli.js'),
    '/owned/dork-home'
  );
  expect(originals.create).toHaveBeenCalledExactlyOnceWith(f.configuration);
  expect(actual.configuration).toBe(f.configuration);
  expect(actual.installation).toBe(f.installation);
  expect(Object.isFrozen(actual)).toBe(true);
  expect(f.installation.verifyExisting).not.toHaveBeenCalled();
  expect(f.installation.inspectExisting).not.toHaveBeenCalled();
});
it('refuses a missing actual entry before installation and preserves an unknown original resolver rejection', async () => {
  fixture();
  process.argv = [process.argv[0]!];
  await expect(resolveServerBrowserRuntimePackage()).rejects.toThrow();
  expect(originals.resolve).not.toHaveBeenCalled();
  expect(originals.create).not.toHaveBeenCalled();
  process.argv = [process.argv[0]!, '/owned/packaged/bin/cli.js'];
  originals.resolve.mockRejectedValue(undefined);
  await expect(resolveServerBrowserRuntimePackage()).rejects.toBeUndefined();
  expect(originals.create).not.toHaveBeenCalled();
});
