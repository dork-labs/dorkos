import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  InstallResult,
  RuntimeInstallation,
  RuntimeInstallationStatus,
} from '@dorkos/browser/runtime-installation';
const originals = vi.hoisted(() => ({
  install: vi.fn<RuntimeInstallation['install']>(),
  verify: vi.fn<RuntimeInstallation['verifyExisting']>(),
  inspect: vi.fn<RuntimeInstallation['inspectExisting']>(),
  configuration: vi.fn(),
  journal: vi.fn(),
  write: vi.fn(),
  runtime: vi.fn(),
  directories: vi.fn(),
  realpath: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  mkdtemp: originals.directories,
  realpath: originals.realpath,
  writeFile: originals.write,
}));
vi.mock('@dorkos/browser/runtime-installation', () => ({
  resolveInstalledRuntimeConfiguration: originals.configuration,
  resolveInstalledNativeJournal: originals.journal,
  createRuntimeInstallation: (): RuntimeInstallation => ({
    install: originals.install,
    verifyExisting: originals.verify,
    inspectExisting: originals.inspect,
  }),
}));
vi.mock('../../../server/src/services/browser/runtime/admission/runtime-class.js', () => ({
  readOriginalBrowserRuntimeClass: originals.runtime,
}));
import { emitOriginalDesktopQualificationSubject } from '../emit-browser-qualification-subject';
const hash = 'a'.repeat(64),
  artifactHash = 'b'.repeat(64),
  executableHash = 'c'.repeat(64);
const sourceVintage = {
  sourceManifestSHA256: hash,
  controllerSHA256: hash,
  verifierSHA256: hash,
};
const runtimeClass = {
  kind: 'electron',
  nodeVersion: '24.14.1',
  v8Version: '14.0',
  opensslVersion: '3.0',
  uvVersion: '1.51.0',
  modulesABI: '145',
  electronVersion: '41.10.7',
  platform: 'darwin',
  arch: 'arm64',
  featureContract: 'browser-owner-runtime-v1',
  surface: {
    abortSignalAny: true,
    abortSignalTimeout: true,
    workerThreads: true,
    callbackDnsCancel: true,
    bigint: true,
  },
};
const verifiedResult: Extract<InstallResult, { cause: null }> = {
  state: 'verified-reused',
  cause: null,
  installationId: 'original-installation',
  attemptId: 'original-attempt',
  generation: 1,
  observedVersion: '153.0.0.0',
  executableSHA256: executableHash,
  platform: 'darwin',
  arch: 'arm64',
  currentManifestDigest: hash,
  journalDigest: hash,
  readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
};
const inspectedResult: Extract<RuntimeInstallationStatus, { state: 'installed-files' }> = {
  schemaVersion: 1,
  pinnedPackageVersion: '1.63.0',
  chromiumRevision: '1243',
  platform: 'darwin',
  arch: 'arm64',
  observation: 'files-only',
  readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
  state: 'installed-files',
  cause: null,
  installationId: verifiedResult.installationId,
  executableSHA256: executableHash,
  currentManifestDigest: hash,
  lastFreshVerifiedVersion: verifiedResult.observedVersion,
  historicalAttemptId: 'original-history',
  historicalGeneration: 1,
  verificationDigest: hash,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubGlobal('__BROWSER_PRODUCTION_SUBJECT__', hash);
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
  vi.stubEnv('DORKOS_BROWSER_DESKTOP_NODE_EXECUTABLE', process.execPath);
  originals.runtime.mockReturnValue(runtimeClass);
  originals.directories.mockResolvedValue('/tmp/dorkos-signed-subject-owned');
  originals.realpath.mockImplementation(async (path: string) => path);
  originals.configuration.mockResolvedValue({
    nodeRuntime: 'electron-node',
    nodeExecutable: process.execPath,
    platform: 'darwin',
    arch: 'arm64',
    sourceVintage,
  });
  originals.install.mockResolvedValue({ ...verifiedResult, state: 'verified-installed' });
  originals.verify.mockResolvedValue(verifiedResult);
  originals.inspect.mockResolvedValue(inspectedResult);
  originals.journal.mockResolvedValue({ artifact: { sha256: artifactHash } });
  originals.write.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('derives every runtime/package field from entered originals and exclusively emits unaccepted data', async () => {
  const signal = new AbortController().signal;
  await emitOriginalDesktopQualificationSubject('native', '/tmp/subject.json', signal);
  expect(originals.install).toHaveBeenCalledExactlyOnceWith({ signal });
  expect(originals.verify).toHaveBeenCalledExactlyOnceWith({ signal });
  expect(originals.inspect).toHaveBeenCalledExactlyOnceWith({ signal });
  const report = JSON.parse(
    originals.write.mock.calls.find((row) => row[0] === '/tmp/subject.json')![1]
  );
  expect(report.readiness).toBe('unaccepted');
  expect(report.qualificationSubject).toEqual({
    runtimeClass,
    executableSHA256: executableHash,
    version: '153.0.0.0',
    revision: '1243',
    libraryVersion: '1.63.0',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'desktop',
    ...sourceVintage,
    nativeJournalSHA256: createHash('sha256')
      .update(JSON.stringify({ artifactSHA256: artifactHash, sourceVintage }))
      .digest('hex'),
    productionSubjectSHA256: hash,
    mode: 'native',
    identityPolicyRevision: 1,
    networkPolicyRevision: 1,
  });
  expect(originals.write.mock.calls.find((row) => row[0] === '/tmp/subject.json')![2]).toEqual({
    flag: 'wx',
    mode: 0o600,
    signal,
  });
});
it('refuses plain Node before acquiring a home or installation', async () => {
  originals.runtime.mockReturnValue({
    ...runtimeClass,
    kind: 'node',
    electronVersion: null,
  });
  await expect(
    emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    )
  ).rejects.toThrow('ORIGINAL_ELECTRON');
  expect(originals.directories).not.toHaveBeenCalled();
  expect(originals.install).not.toHaveBeenCalled();
});
it('refuses a changed current pointer and produces no descriptor', async () => {
  originals.inspect.mockResolvedValue({ ...inspectedResult, currentManifestDigest: artifactHash });
  await expect(
    emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    )
  ).rejects.toThrow('CURRENT_INSTALLATION_CHANGED');
  expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
});
it.each([false, undefined])(
  'preserves exact original verification failure %s without emitting',
  async (value) => {
    originals.verify.mockRejectedValue(value);
    const work = emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    );
    await expect(work).rejects.toBe(value);
    expect(originals.inspect).not.toHaveBeenCalled();
    expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
  }
);
it('cannot emit before a held original verifier has returned and refuses original cancellation', async () => {
  let release!: (value: InstallResult) => void;
  const held = new Promise<InstallResult>((resolve) => {
    release = resolve;
  });
  originals.verify.mockReturnValue(held);
  const lifetime = new AbortController();
  const work = emitOriginalDesktopQualificationSubject(
    'native',
    '/tmp/subject.json',
    lifetime.signal
  );
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(originals.verify).toHaveBeenCalledOnce());
    expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
    lifetime.abort(false);
  } finally {
    release(verifiedResult);
    await Promise.allSettled([work]);
  }
  await expect(work).rejects.toBe(false);
  expect(originals.inspect).not.toHaveBeenCalled();
  expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
});

it.each([false, undefined])(
  'announces the actual acquired home before install failure %s and retains it in a failure receipt',
  async (value) => {
    originals.install.mockImplementation(async () => {
      expect(originals.write.mock.calls[0]![0]).toBe('/tmp/subject.json.enter.json');
      expect(JSON.parse(originals.write.mock.calls[0]![1]).home).toBe(
        '/tmp/dorkos-signed-subject-owned'
      );
      throw value;
    });
    await expect(
      emitOriginalDesktopQualificationSubject(
        'native',
        '/tmp/subject.json',
        new AbortController().signal
      )
    ).rejects.toBe(value);
    const failure = JSON.parse(
      originals.write.mock.calls.find((row) => row[0] === '/tmp/subject.json.failure.json')![1]
    );
    expect(failure).toEqual({
      schemaVersion: 1,
      readiness: 'unaccepted',
      stage: 'installation',
      failureKind: value === false ? 'false' : 'undefined',
      home: '/tmp/dorkos-signed-subject-owned',
    });
    expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
  }
);
it('retains the acquired directory when canonicalization fails before package resolution', async () => {
  originals.realpath.mockRejectedValue(false);
  await expect(
    emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    )
  ).rejects.toBe(false);
  expect(JSON.parse(originals.write.mock.calls[0]![1]).home).toBe(
    '/tmp/dorkos-signed-subject-owned'
  );
  const failure = JSON.parse(originals.write.mock.calls[1]![1]);
  expect(failure.stage).toBe('home-canonicalization');
  expect(failure.failureKind).toBe('false');
  expect(failure.home).toBe('/tmp/dorkos-signed-subject-owned');
  expect(originals.configuration).not.toHaveBeenCalled();
});
it('diagnostic file failure cannot replace an exact original undefined rejection', async () => {
  originals.install.mockRejectedValue(undefined);
  originals.write.mockImplementation(async (path: string) => {
    if (path.endsWith('.failure.json')) throw false;
  });
  await expect(
    emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    )
  ).rejects.toBe(undefined);
});

it('a failure diagnostic serialization fault cannot replace the original falsy rejection', async () => {
  const stringify = JSON.stringify;
  originals.install.mockImplementation(async () => {
    vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw undefined;
    });
    throw false;
  });
  try {
    await expect(
      emitOriginalDesktopQualificationSubject(
        'native',
        '/tmp/subject.json',
        new AbortController().signal
      )
    ).rejects.toBe(false);
  } finally {
    vi.mocked(JSON.stringify).mockRestore();
  }
  expect(JSON.stringify).toBe(stringify);
  expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
});

it('refuses entry receipt failure before installation and still identifies the acquired home', async () => {
  originals.write.mockImplementation(async (path: string) => {
    if (path.endsWith('.enter.json')) throw false;
  });
  await expect(
    emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    )
  ).rejects.toBe(false);
  expect(originals.install).not.toHaveBeenCalled();
  expect(originals.configuration).not.toHaveBeenCalled();
  const failure = JSON.parse(
    originals.write.mock.calls.find((row) => row[0] === '/tmp/subject.json.failure.json')![1]
  );
  expect(failure.home).toBe('/tmp/dorkos-signed-subject-owned');
  expect(failure.stage).toBe('home-announcement');
});
it('records no acquired home when original directory creation rejects', async () => {
  originals.directories.mockRejectedValue(undefined);
  await expect(
    emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    )
  ).rejects.toBe(undefined);
  const failure = JSON.parse(originals.write.mock.calls[0]![1]);
  expect(failure.home).toBeNull();
  expect(failure.failureKind).toBe('undefined');
  expect(failure.stage).toBe('home-acquisition');
  expect(originals.configuration).not.toHaveBeenCalled();
});

const inspectionCommon = {
  schemaVersion: inspectedResult.schemaVersion,
  pinnedPackageVersion: inspectedResult.pinnedPackageVersion,
  chromiumRevision: inspectedResult.chromiumRevision,
  platform: inspectedResult.platform,
  arch: inspectedResult.arch,
  observation: inspectedResult.observation,
  readiness: inspectedResult.readiness,
};
const unavailableStatuses: RuntimeInstallationStatus[] = [
  { ...inspectionCommon, state: 'missing', cause: null },
  { ...inspectionCommon, state: 'invalid', cause: 'INSTALLATION_INVALID' },
  { ...inspectionCommon, state: 'unsupported', cause: 'PLATFORM_UNSUPPORTED' },
  { ...inspectionCommon, state: 'unverified', cause: 'VERIFICATION_UNAVAILABLE' },
];
it.each(unavailableStatuses)(
  'refuses genuine public inspection state $state before native metadata or output',
  async (status) => {
    originals.inspect.mockResolvedValue(status);
    await expect(
      emitOriginalDesktopQualificationSubject(
        'native',
        '/tmp/subject.json',
        new AbortController().signal
      )
    ).rejects.toThrow('CURRENT_INSTALLATION_CHANGED');
    expect(originals.journal).not.toHaveBeenCalled();
    expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
    const failure = JSON.parse(
      originals.write.mock.calls.find((row) => row[0] === '/tmp/subject.json.failure.json')![1]
    );
    expect(failure.stage).toBe('inspection');
    expect(failure.home).toBe('/tmp/dorkos-signed-subject-owned');
  }
);
const mismatchedStatuses: RuntimeInstallationStatus[] = [
  { ...inspectedResult, installationId: 'other-installation' },
  { ...inspectedResult, executableSHA256: artifactHash },
  { ...inspectedResult, lastFreshVerifiedVersion: '153.0.0.1' },
  { ...inspectedResult, platform: 'linux' },
  { ...inspectedResult, arch: 'x64' },
];
it.each(mismatchedStatuses)(
  'refuses a public current status outside the exact verified installation',
  async (status) => {
    originals.inspect.mockResolvedValue(status);
    await expect(
      emitOriginalDesktopQualificationSubject(
        'native',
        '/tmp/subject.json',
        new AbortController().signal
      )
    ).rejects.toThrow('CURRENT_INSTALLATION_CHANGED');
    expect(originals.journal).not.toHaveBeenCalled();
    expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
  }
);
it.each(['refused', 'uncertain'])(
  'refuses original verification state %s before current inspection',
  async (state) => {
    originals.verify.mockResolvedValue({
      state: state === 'refused' ? 'refused' : 'uncertain',
      cause: 'VERIFIER_FAILED',
      publicationMayHaveChanged: false,
      readiness: verifiedResult.readiness,
    });
    await expect(
      emitOriginalDesktopQualificationSubject(
        'native',
        '/tmp/subject.json',
        new AbortController().signal
      )
    ).rejects.toThrow('VERIFICATION_REFUSED');
    expect(originals.inspect).not.toHaveBeenCalled();
    expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
  }
);
it.each([false, undefined])(
  'preserves exact public inspection rejection %s after entry',
  async (value) => {
    originals.inspect.mockRejectedValue(value);
    await expect(
      emitOriginalDesktopQualificationSubject(
        'native',
        '/tmp/subject.json',
        new AbortController().signal
      )
    ).rejects.toBe(value);
    expect(originals.journal).not.toHaveBeenCalled();
    const failure = JSON.parse(
      originals.write.mock.calls.find((row) => row[0] === '/tmp/subject.json.failure.json')![1]
    );
    expect(failure.stage).toBe('inspection');
    expect(failure.failureKind).toBe(value === false ? 'false' : 'undefined');
  }
);

const refusedInstallations: InstallResult[] = [
  {
    state: 'refused',
    cause: 'INSTALLER_FAILED',
    publicationMayHaveChanged: false,
    readiness: verifiedResult.readiness,
  },
  {
    state: 'uncertain',
    cause: 'CUSTODY_UNCERTAIN',
    publicationMayHaveChanged: true,
    readiness: verifiedResult.readiness,
  },
  verifiedResult,
];
it.each(refusedInstallations)(
  'requires original new installation state, not $state',
  async (result) => {
    originals.install.mockResolvedValue(result);
    await expect(
      emitOriginalDesktopQualificationSubject(
        'native',
        '/tmp/subject.json',
        new AbortController().signal
      )
    ).rejects.toThrow('INSTALLATION_REFUSED');
    expect(originals.verify).not.toHaveBeenCalled();
    expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
  }
);
it('refuses a verified/current pair from a platform different from the signed package', async () => {
  originals.verify.mockResolvedValue({ ...verifiedResult, platform: 'linux' });
  originals.inspect.mockResolvedValue({ ...inspectedResult, platform: 'linux' });
  await expect(
    emitOriginalDesktopQualificationSubject(
      'native',
      '/tmp/subject.json',
      new AbortController().signal
    )
  ).rejects.toThrow('CURRENT_INSTALLATION_CHANGED');
  expect(originals.journal).not.toHaveBeenCalled();
  expect(originals.write.mock.calls.some((row) => row[0] === '/tmp/subject.json')).toBe(false);
});
