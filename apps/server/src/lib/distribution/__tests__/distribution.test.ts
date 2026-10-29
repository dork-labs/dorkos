import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { resolveDistribution, type DistributionFacts } from '../index.js';

/** A bundled server with nothing set, on an Apple Silicon Mac, at 0.126.3. */
function facts(overrides: Partial<DistributionFacts> = {}): DistributionFacts {
  return {
    launcher: undefined,
    desktopVersion: undefined,
    bundled: true,
    platform: 'darwin',
    arch: 'arm64',
    version: '0.126.3',
    ...overrides,
  };
}

describe('resolveDistribution', () => {
  it('names the Mac app from the desktop launcher on macOS', () => {
    const d = resolveDistribution(facts({ launcher: 'desktop', desktopVersion: '0.126.3' }));
    expect(d.kind).toBe('desktop-mac');
    expect(d.label).toBe('DorkOS Mac app 0.126.3 (Apple Silicon)');
    expect(d.appVersion).toBeUndefined();
  });

  it('says Intel for an x64 Mac', () => {
    const d = resolveDistribution(facts({ launcher: 'desktop', arch: 'x64' }));
    expect(d.label).toBe('DorkOS Mac app 0.126.3 (Intel)');
  });

  it('names the Windows app from the desktop launcher on Windows', () => {
    const d = resolveDistribution(facts({ launcher: 'desktop', platform: 'win32', arch: 'x64' }));
    expect(d.kind).toBe('desktop-windows');
    expect(d.label).toBe('DorkOS Windows app 0.126.3 (x64)');
  });

  it('calls a desktop launcher on a platform with no desktop build unknown', () => {
    expect(resolveDistribution(facts({ launcher: 'desktop', platform: 'linux' })).kind).toBe(
      'unknown'
    );
  });

  it('reports the desktop app version only when it differs from the server', () => {
    const d = resolveDistribution(facts({ launcher: 'desktop', desktopVersion: '0.126.4' }));
    expect(d.appVersion).toBe('0.126.4');
    expect(d.label).toBe('DorkOS Mac app 0.126.3 (Apple Silicon), app 0.126.4');
  });

  it.each([
    ['npm', 'npm', 'DorkOS npm package 0.126.3 (arm64)'],
    ['homebrew', 'homebrew', 'DorkOS Homebrew package 0.126.3 (arm64)'],
    ['docker', 'docker', 'DorkOS Docker image 0.126.3 (arm64)'],
    ['dev', 'dev', 'DorkOS dev checkout 0.126.3 (arm64)'],
  ] as const)('takes the %s launcher at its word', (launcher, kind, label) => {
    const d = resolveDistribution(facts({ launcher }));
    expect(d.kind).toBe(kind);
    expect(d.label).toBe(label);
  });

  it('ignores a desktop version outside the desktop app', () => {
    const d = resolveDistribution(facts({ launcher: 'npm', desktopVersion: '9.9.9' }));
    expect(d.appVersion).toBeUndefined();
  });

  it('is unknown, never a guess, when a bundle has no launcher value', () => {
    const d = resolveDistribution(facts());
    expect(d.kind).toBe('unknown');
    expect(d.label).toBe('DorkOS (install type unknown) 0.126.3 (arm64)');
  });

  it('is unknown for a launcher value this build does not know', () => {
    expect(resolveDistribution(facts({ launcher: 'snap' })).kind).toBe('unknown');
  });

  it('calls a server running from source a checkout, whatever it inherited', () => {
    // An agent's shell inherits its server's environment, so `pnpm dev` started
    // inside the Mac app sees DORKOS_DISTRIBUTION=desktop. It is still a checkout.
    const d = resolveDistribution(facts({ bundled: false, launcher: 'desktop', version: '0.0.0' }));
    expect(d.kind).toBe('dev');
    expect(d.label).toBe('DorkOS dev checkout 0.0.0 (arm64)');
  });
});

describe('currentDistribution', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../../env.js');
    vi.doUnmock('../../version.js');
  });

  async function loadWith(version: string, launcher: string | undefined) {
    vi.doMock('../../../env.js', () => ({
      env: { DORKOS_DISTRIBUTION: launcher, DORKOS_DESKTOP_VERSION: undefined },
    }));
    vi.doMock('../../version.js', () => ({ SERVER_VERSION: version, IS_DEV_BUILD: false }));
    return import('../index.js');
  }

  it('reads the running version, not one from an earlier process', async () => {
    // A restart onto a new version is a new module graph. What the old process
    // reported must not survive into the new one (the 0.126.2-after-0.126.3 report).
    const before = await loadWith('0.126.2', 'npm');
    expect(before.currentDistribution().version).toBe('0.126.2');

    vi.resetModules();
    const after = await loadWith('0.126.3', 'npm');
    expect(after.currentDistribution().version).toBe('0.126.3');
    expect(after.currentDistribution().label).toContain('0.126.3');
  });

  it('runs from source in tests, so it reports a checkout', async () => {
    const mod = await loadWith('0.0.0', 'desktop');
    expect(mod.currentDistribution().kind).toBe('dev');
  });
});
