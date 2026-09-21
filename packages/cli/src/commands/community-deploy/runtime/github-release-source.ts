/**
 * Exact GitHub release and attestation source for Community manifests.
 *
 * @module commands/community-deploy/runtime/github-release-source
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProviderCommand } from '../provider-process.js';
import type {
  CommunityReleaseSource,
  TrustedReleaseIdentity,
  VerifiedAttestationIdentity,
} from '../release-resolver.js';

/** GitHub CLI boundary used to read and verify one exact release. */
export interface GitHubReleaseSourceOptions {
  /** GitHub CLI executable. */
  executable: string;
  /** Minimal environment needed by the authenticated or anonymous CLI. */
  env: Readonly<Record<string, string>>;
  /** Deadline for each asset or attestation operation. */
  timeoutMs: number;
  /** Expected repository identity. */
  repository: string;
}

/** Build an exact-version source that selects no mutable release alias. */
export function createGitHubCommunityReleaseSource(
  options: GitHubReleaseSourceOptions
): CommunityReleaseSource {
  const verify = async (
    subject: string,
    trusted: TrustedReleaseIdentity
  ): Promise<VerifiedAttestationIdentity> => {
    await runProviderCommand({
      executable: options.executable,
      env: options.env,
      timeoutMs: options.timeoutMs,
      args: [
        'attestation',
        'verify',
        subject,
        '--repo',
        trusted.repository,
        '--signer-workflow',
        `${trusted.repository}/${trusted.workflowRef}`,
        '--source-ref',
        trusted.sourceRef,
      ],
      parse: () => undefined,
    });
    return trusted;
  };

  return {
    readExactManifest: async (version) => {
      const asset = `community-release-v${version}.json`;
      const result = await runProviderCommand({
        executable: options.executable,
        env: options.env,
        timeoutMs: options.timeoutMs,
        maxBytes: 256 * 1024,
        args: [
          'release',
          'download',
          `v${version}`,
          '--repo',
          options.repository,
          '--pattern',
          asset,
          '--output',
          '-',
        ],
        parse: (stdout) => new Uint8Array(Buffer.from(stdout, 'utf8')),
      });
      return result.value;
    },
    verifyManifest: async (bytes, trusted) => {
      const directory = await mkdtemp(join(tmpdir(), 'dorkos-community-manifest-'));
      const path = join(directory, 'manifest.json');
      try {
        await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        return await verify(path, trusted);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    verifyImage: (repository, digest, trusted) => verify(`oci://${repository}@${digest}`, trusted),
  };
}
