import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMUNITY_LIVE_GATE_ENV,
  CommunityLiveGateNotArmedError,
  communityLiveGateRecoveryCommand,
  parseCommunityLiveGateConfig,
} from '../../scripts/community-deploy-live-config.js';

const armed = {
  DORKOS_COMMUNITY_LIVE_GATE: '1',
  DORKOS_COMMUNITY_LIVE_FLY_WRITES: '1',
  DORKOS_COMMUNITY_LIVE_NEON_WRITES: '1',
  DORKOS_COMMUNITY_LIVE_TIGRIS_WRITES: '1',
  DORKOS_COMMUNITY_LIVE_CLEANUP: '1',
  DORKOS_COMMUNITY_LIVE_CHARGE_ACKNOWLEDGEMENT: 'I ACCEPT THROWAWAY PROVIDER CHARGES',
  DORKOS_COMMUNITY_LIVE_BUDGET_USD: '5',
  DORKOS_COMMUNITY_LIVE_VERSION: '0.76.0',
  DORKOS_COMMUNITY_LIVE_FLY_ORG: 'dorkos-live-test',
  DORKOS_COMMUNITY_LIVE_FLY_REGION: 'iad',
  DORKOS_COMMUNITY_LIVE_NEON_ORG: 'org-live-test',
  DORKOS_COMMUNITY_LIVE_NEON_REGION: 'aws-us-east-1',
} as const;

describe('Community credentialed live gate arms', () => {
  it('executes the printed recovery command after the disposable CLI has been removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'community-recovery-command-'));
    try {
      const bin = join(root, 'bin');
      const install = join(root, 'disposable-install');
      const home = join(root, "durable home with 'quote'");
      const journals = join(home, 'launches', 'community');
      await mkdir(bin);
      await mkdir(install);
      await mkdir(journals, { recursive: true });
      await writeFile(join(install, 'dorkos'), 'disposable placeholder');
      await writeFile(join(journals, 'run-1.json'), JSON.stringify({ runId: 'run-1' }));
      // An executable package-manager stand-in observes argv and reads the real
      // retained journal. No npm download or provider boundary is reachable.
      await writeFile(
        join(bin, 'npx'),
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const runId = args[args.indexOf('--resume') + 1];
const journal = JSON.parse(fs.readFileSync(path.join(process.env.DORK_HOME, 'launches', 'community', runId + '.json'), 'utf8'));
process.stdout.write(JSON.stringify({ args, journal }));
`,
        { mode: 0o700 }
      );
      await rm(install, { recursive: true });
      const command = communityLiveGateRecoveryCommand(
        '1.2.3',
        ['--app-name', 'dorkos-gate-012345abcdef'],
        'run-1',
        home
      );
      const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], {
        env: { PATH: bin, DORK_HOME: join(root, 'wrong-default-home') },
        timeout: 5000,
      });
      expect(JSON.parse(stdout)).toEqual({
        args: [
          '--yes',
          'dorkos@1.2.3',
          'community',
          'deploy',
          '--app-name',
          'dorkos-gate-012345abcdef',
          '--resume',
          'run-1',
        ],
        journal: { runId: 'run-1' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('prints a durable published recovery command instead of a disposable install path', () => {
    expect(
      communityLiveGateRecoveryCommand(
        '1.2.3',
        ['--app-name', 'dorkos-gate-012345abcdef'],
        'run-1',
        '/retained/home'
      )
    ).toBe(
      "DORK_HOME='/retained/home' npx --yes 'dorkos@1.2.3' community deploy '--app-name' 'dorkos-gate-012345abcdef' --resume 'run-1'"
    );
  });
  it('arms the fixture with exactly the names the parser requires', () => {
    // The per-name refusals below iterate the parser's own list; this pins the fixture to it, so a
    // name added to the parser without a fixture value fails here rather than passing vacuously.
    expect(Object.keys(armed).sort()).toEqual([...COMMUNITY_LIVE_GATE_ENV].sort());
  });

  it.each(COMMUNITY_LIVE_GATE_ENV)('refuses before a boundary when %s is absent', (name) => {
    const boundary = vi.fn();
    const environment = { ...armed, [name]: undefined };
    let refusal: unknown;
    try {
      boundary(parseCommunityLiveGateConfig(environment));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CommunityLiveGateNotArmedError);
    // Names exactly the one missing variable, so the list and the parser check the same names.
    expect((refusal as CommunityLiveGateNotArmedError).fields).toEqual([name]);
    expect(boundary).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'NaN', '26'])('refuses invalid provider budget %s', (budget) => {
    expect(() =>
      parseCommunityLiveGateConfig({ ...armed, DORKOS_COMMUNITY_LIVE_BUDGET_USD: budget })
    ).toThrow(CommunityLiveGateNotArmedError);
  });

  it('returns only non-secret, exact release and account choices when fully armed', () => {
    expect(parseCommunityLiveGateConfig(armed)).toEqual({
      version: '0.76.0',
      flyOrganization: 'dorkos-live-test',
      flyRegion: 'iad',
      neonOrganization: 'org-live-test',
      neonRegion: 'aws-us-east-1',
      budgetUsd: 5,
    });
  });
});
