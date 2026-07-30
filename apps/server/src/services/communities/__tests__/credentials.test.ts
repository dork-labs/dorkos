/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import {
  communityCredentialEnvVar,
  communityDir,
  resolveCommunityCredential,
} from '../credentials.js';

const COMMUNITY = '01K1BXCQ4M7GKZ9V0S2R7XQ3AB' as CommunityRef;
const ENV_VAR = communityCredentialEnvVar(COMMUNITY);

describe('resolveCommunityCredential', () => {
  let dorkHome: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-community-'));
    savedEnv = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    fs.rmSync(dorkHome, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedEnv;
    vi.restoreAllMocks();
  });

  it('generates and persists a credential when none exists, owner-only', () => {
    const credential = resolveCommunityCredential(dorkHome, COMMUNITY);

    expect(credential, '32 random bytes, hex-encoded').toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(communityDir(dorkHome, COMMUNITY), 'credential');
    expect(fs.readFileSync(file, 'utf8')).toBe(credential);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(communityDir(dorkHome, COMMUNITY)).mode & 0o777).toBe(0o700);
    }
  });

  it('reuses a persisted credential rather than rotating it', () => {
    const first = resolveCommunityCredential(dorkHome, COMMUNITY);
    expect(resolveCommunityCredential(dorkHome, COMMUNITY)).toBe(first);
  });

  it('lets an explicit environment override win', () => {
    process.env[ENV_VAR] = '  operator-supplied  ';
    expect(resolveCommunityCredential(dorkHome, COMMUNITY)).toBe('operator-supplied');
    expect(
      fs.existsSync(communityDir(dorkHome, COMMUNITY)),
      'an override writes nothing to disk'
    ).toBe(false);
  });

  it('repairs a lax file mode and warns, rather than locking the owner out', () => {
    if (process.platform === 'win32') return;
    const credential = resolveCommunityCredential(dorkHome, COMMUNITY);
    const file = path.join(communityDir(dorkHome, COMMUNITY), 'credential');
    fs.chmodSync(file, 0o644);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(resolveCommunityCredential(dorkHome, COMMUNITY)).toBe(credential);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalled();
  });

  it('logs the path and never the value', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const credential = resolveCommunityCredential(dorkHome, COMMUNITY);

    expect(info).toHaveBeenCalled();
    const logged = JSON.stringify(info.mock.calls);
    expect(logged, 'the credential must never reach a log line').not.toContain(credential);
    expect(logged).toContain(communityDir(dorkHome, COMMUNITY));
  });

  it('names an environment override a shell can actually set', () => {
    expect(communityCredentialEnvVar(COMMUNITY)).toBe(
      'DORKOS_COMMUNITY_SECRET_01K1BXCQ4M7GKZ9V0S2R7XQ3AB'
    );
    expect(communityCredentialEnvVar('local' as CommunityRef)).toBe(
      'DORKOS_COMMUNITY_SECRET_LOCAL'
    );
    expect(communityCredentialEnvVar('dork-labs' as CommunityRef)).toBe(
      'DORKOS_COMMUNITY_SECRET_DORK_LABS'
    );
  });

  it('keeps each community’s credential in its own directory', () => {
    const other = 'local' as CommunityRef;
    const a = resolveCommunityCredential(dorkHome, COMMUNITY);
    const b = resolveCommunityCredential(dorkHome, other);

    expect(a).not.toBe(b);
    expect(communityDir(dorkHome, COMMUNITY)).not.toBe(communityDir(dorkHome, other));
  });
});
