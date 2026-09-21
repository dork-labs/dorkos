import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const workflow = readFileSync(join(root, '.github/workflows/publish-community.yml'), 'utf8');
const dockerfile = readFileSync(join(root, 'apps/community/Dockerfile'), 'utf8');
const dockerignore = readFileSync(join(root, 'apps/community/Dockerfile.dockerignore'), 'utf8');
const generator = readFileSync(
  join(root, 'scripts/generate-community-release-manifest.ts'),
  'utf8'
);
const publisher = join(root, 'scripts/publish-community-release-assets.sh');

describe('Community release workflow', () => {
  it('rejects dot-separated version suffixes before building the image', () => {
    const metadataStep = workflow.match(
      / {6}- name: Extract release metadata[\s\S]*? {8}run: \|\n([\s\S]*?)(?=\n {6}- name:)/
    )?.[1];
    expect(metadataStep).toBeTruthy();
    const script = metadataStep!
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n');
    const accepts = (version: string) =>
      spawnSync('bash', ['-c', script], {
        env: { GITHUB_REF_NAME: `v${version}`, GITHUB_OUTPUT: '/dev/null' },
      }).status === 0;

    expect(accepts('1.2.3')).toBe(true);
    expect(accepts('1.2.3-rc.1')).toBe(true);
    expect(accepts('1.2.3.4')).toBe(false);
  });

  it('publishes a dedicated two-platform image and selects its immutable index digest', () => {
    expect(workflow).toContain('IMAGE_NAME: dork-labs/dorkos-community');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('${{ steps.image.outputs.digest }}');
    expect(workflow).toContain('actions/attest-build-provenance@v4');
  });

  it('binds both artifact checks to the exact repository, workflow, and release ref', () => {
    const verification = workflow.slice(
      workflow.indexOf('- name: Verify both attestations before publication'),
      workflow.indexOf('- name: Wait for the draft release')
    );
    expect(verification.match(/gh attestation verify/g)).toHaveLength(2);
    expect(verification.match(/--repo "\$GITHUB_REPOSITORY"/g)).toHaveLength(2);
    expect(
      verification.match(
        /--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/publish-community\.yml"/g
      )
    ).toHaveLength(2);
    expect(verification.match(/--source-ref "\$GITHUB_REF"/g)).toHaveLength(2);
  });

  it('proves anonymous digest access before publishing the release manifest', () => {
    const logout = workflow.indexOf('docker logout "$REGISTRY"');
    const inspect = workflow.indexOf('docker buildx imagetools inspect');
    const generate = workflow.indexOf('Generate the release manifest');
    expect(logout).toBeGreaterThan(0);
    expect(logout).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(generate);
  });

  it('never replaces an existing version-to-digest release asset', () => {
    const publication = readFileSync(publisher, 'utf8');
    expect(publication).not.toContain('--clobber');
    expect(publication.indexOf('publish_or_reuse_bundle')).toBeLessThan(
      publication.indexOf('publish_or_verify_manifest')
    );
    expect(publication).toContain('cmp -s "$manifest" "$existing/$name"');
  });

  it('reuses a different valid bundle for the exact same manifest on retry', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'community-release-assets-'));
    const bin = join(fixture, 'bin');
    const remote = join(fixture, 'remote');
    mkdirSync(bin);
    mkdirSync(remote);
    const manifest = join(fixture, 'community-release-v1.json');
    const bundle = `${manifest}.sigstore.json`;
    writeFileSync(manifest, 'same manifest');
    writeFileSync(bundle, 'new valid bundle');
    writeFileSync(join(remote, 'community-release-v1.json'), 'same manifest');
    writeFileSync(join(remote, 'community-release-v1.json.sigstore.json'), 'old valid bundle');
    const calls = join(fixture, 'calls.log');
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALLS"
if [ "$1 $2" = 'release upload' ]; then exit 1; fi
if [ "$1 $2" = 'release download' ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --dir) destination="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$GH_REMOTE/$pattern" "$destination/$pattern"
  exit 0
fi
if [ "$1 $2" = 'attestation verify' ]; then exit 0; fi
exit 2
`
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      'bash',
      [
        publisher,
        'v1',
        'dork-labs/dorkos',
        manifest,
        bundle,
        'dork-labs/dorkos/.github/workflows/publish-community.yml',
        'refs/tags/v1',
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_CALLS: calls,
          GH_REMOTE: remote,
        },
        encoding: 'utf8',
      }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readFileSync(bundle, 'utf8')).toBe('old valid bundle');
    expect(readFileSync(calls, 'utf8')).toMatch(
      /attestation verify .*community-release-v1\.json --bundle .*\.sigstore\.json --repo dork-labs\/dorkos --signer-workflow dork-labs\/dorkos\/\.github\/workflows\/publish-community\.yml --source-ref refs\/tags\/v1/
    );
  });

  it('keeps the runtime non-root and the Docker build context allow-listed', () => {
    expect(dockerfile).toMatch(/\nUSER node\n/);
    expect(dockerignore.startsWith('**\n')).toBe(true);
    expect(dockerignore).not.toContain('!.env');
    expect(dockerignore).not.toContain('!**/.env');
  });

  it('derives migration metadata from the tagged corpus instead of a frozen migration name', () => {
    expect(generator).toContain(".filter((entry) => entry.endsWith('.sql'))");
    expect(generator).toContain('.sort()');
    expect(generator).toContain("migrationHash.update('\\0')");
    expect(generator).toContain('migrationCompatibilityId,');
    expect(generator).not.toMatch(/through-\d+/);
    expect(workflow).toContain('MINIMUM_FLYCTL_VERSION: 0.4.104');
    expect(workflow).toContain('MINIMUM_NEON_CLI_VERSION: 5.0.0');
  });
});
