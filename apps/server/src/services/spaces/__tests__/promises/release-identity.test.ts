/**
 * Three promises the image's releases carry that the launcher, installed CLIs and Cloud check
 * (server-merge step 7, DOR-3006): the publish workflow's file name, the image name, and the
 * migration compatibility id. The program merge moves the code that makes all three; these fail
 * if the move changes one by accident. A deliberate change is its own PR, agreed with Cloud.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMUNITY_IMAGE_REPOSITORY,
  COMMUNITY_RELEASE_WORKFLOW,
} from '@dorkos/shared/community-release-manifest';
import { describe, expect, it } from 'vitest';
import { communityMigrationCompatibilityId } from '../../../../../../../scripts/lib/community-migration-id.mjs';
import { REPO_ROOT } from './image-imports.js';
import { MIGRATIONS_DIR } from '../space-paths.js';

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const WORKFLOW = '.github/workflows/publish-community.yml';
const workflow = read(WORKFLOW);
const cliBuild = read('packages/cli/scripts/build.ts');
const manifestGenerator = read('scripts/generate-community-release-manifest.ts');
/** The folder the server migrates from (`migrate.ts` reads `../migrations/`), from the root. */
const migrations = relative(REPO_ROOT, MIGRATIONS_DIR);

/** A workflow value with `$SPACE_DIR` read from ci/space-server.env, when that file exists. */
function expandSpaceDir(value: string): string {
  const env = join(REPO_ROOT, 'ci/space-server.env');
  const spaceDir = existsSync(env)
    ? /^SPACE_DIR=(.+)$/mu.exec(readFileSync(env, 'utf8'))?.[1]
    : undefined;
  return value.replace(/^"?\$\{?SPACE_DIR\}?/u, spaceDir ?? '$SPACE_DIR').replace(/"$/u, '');
}

describe('the release identity', () => {
  it('is published by the workflow file the launcher trusts', () => {
    // Purpose: fails if the publish workflow is renamed or moved; the launcher verifies a
    // release's attestation against this exact path and refuses any other.
    expect(existsSync(join(REPO_ROOT, WORKFLOW))).toBe(true);
    expect(COMMUNITY_RELEASE_WORKFLOW).toBe(`dork-labs/dorkos/${WORKFLOW}`);
    expect(read('packages/cli/src/commands/community-deploy/community-dispatcher.ts')).toContain(
      `workflowRef: '${WORKFLOW}'`
    );
  });

  it('keeps the image name', () => {
    // Purpose: fails if the image is published under another name; hosts pin it by digest.
    expect(COMMUNITY_IMAGE_REPOSITORY).toBe('ghcr.io/dork-labs/dorkos-community');
    expect(workflow).toMatch(/^ {2}REGISTRY: ghcr\.io$/mu);
    expect(workflow).toMatch(/^ {2}IMAGE_NAME: dork-labs\/dorkos-community$/mu);
  });

  it('computes the migration compatibility id from the migrations the server runs', () => {
    // Purpose: the CLI bakes this id in and every release manifest carries it; a launcher refuses
    // a release whose id differs. Fails if either producer stops calling the one shared function
    // on the folder the server migrates from, or the function stops hashing it as it always has.
    expect(cliBuild).toMatch(
      new RegExp(
        String.raw`communityMigrationCompatibilityId\(\s*path\.join\(ROOT, '${migrations}'\)\s*\)`,
        'u'
      )
    );
    expect(manifestGenerator).toContain('communityMigrationCompatibilityId(values.migrations!)');
    const named = /--migrations (\S+)/u.exec(workflow)?.[1];
    expect(named && expandSpaceDir(named)).toBe(migrations);
    const reference = createHash('sha256');
    for (const filename of readdirSync(join(REPO_ROOT, migrations)).sort())
      if (filename.endsWith('.sql'))
        reference
          .update(filename)
          .update('\0')
          .update(readFileSync(join(REPO_ROOT, migrations, filename)))
          .update('\0');
    expect(communityMigrationCompatibilityId(join(REPO_ROOT, migrations))).toBe(
      `sha256:${reference.digest('hex')}`
    );
  });
});
