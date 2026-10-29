import { describe, it, expect } from 'vitest';

import { cliDistribution, stampCliLaunch } from '../distribution.js';

describe('stampCliLaunch', () => {
  it('hands the server the entry, the version and the distribution', () => {
    const env: NodeJS.ProcessEnv = { DORKOS_DISTRIBUTION: 'desktop' };
    stampCliLaunch(env, '/usr/local/lib/node_modules/dorkos/dist/bin/cli.js', '0.126.3');
    expect(env).toEqual({
      DORKOS_CLI_ENTRYPOINT: '/usr/local/lib/node_modules/dorkos/dist/bin/cli.js',
      DORKOS_CLI_VERSION: '0.126.3',
      DORKOS_DISTRIBUTION: 'npm',
    });
  });
});

describe('cliDistribution', () => {
  it('is npm for a global npm install', () => {
    expect(
      cliDistribution('/opt/homebrew/lib/node_modules/dorkos/dist/bin/cli.js', undefined)
    ).toBe('npm');
  });

  it('is npm for a Windows global install', () => {
    expect(
      cliDistribution(
        'C:\\Users\\kai\\AppData\\Roaming\\npm\\node_modules\\dorkos\\dist\\bin\\cli.js',
        undefined
      )
    ).toBe('npm');
  });

  it('is homebrew for a Cellar install', () => {
    expect(
      cliDistribution(
        '/opt/homebrew/Cellar/dorkos/0.126.3/libexec/lib/node_modules/dorkos/dist/bin/cli.js',
        undefined
      )
    ).toBe('homebrew');
  });

  it('is dev for a repo checkout (pnpm cli:dev)', () => {
    expect(cliDistribution('/Users/kai/dorkos/packages/cli/dist/bin/cli.js', undefined)).toBe(
      'dev'
    );
  });

  it('is unknown anywhere else', () => {
    expect(cliDistribution('/srv/dorkos/cli.js', undefined)).toBe('unknown');
  });

  it('keeps docker from the image', () => {
    expect(cliDistribution('/usr/local/lib/node_modules/dorkos/dist/bin/cli.js', 'docker')).toBe(
      'docker'
    );
  });

  it('drops any other inherited value, so a CLI in an agent shell names its own install', () => {
    expect(cliDistribution('/Users/kai/dorkos/packages/cli/dist/bin/cli.js', 'desktop')).toBe(
      'dev'
    );
  });
});
