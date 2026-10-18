/**
 * Three promises the image's releases carry that the launcher, installed CLIs and Cloud check
 * (server-merge step 7, DOR-3006): the publish workflow's file name, the image name, and the
 * migration compatibility id. The program merge moves the code that makes all three; these fail
 * if the move changes one by accident. A deliberate change is its own PR, agreed with Cloud.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMUNITY_IMAGE_REPOSITORY,
  COMMUNITY_RELEASE_WORKFLOW,
} from '@dorkos/shared/community-release-manifest';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './image-imports.js';

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const WORKFLOW = '.github/workflows/publish-community.yml';
const workflow = read(WORKFLOW);
const cliBuild = read('packages/cli/scripts/build.ts');
const manifestGenerator = read('scripts/generate-community-release-manifest.ts');
/** The folder the server migrates from (`migrate.ts` reads `../migrations/`), from the root. */
const migrations = relative(
  REPO_ROOT,
  fileURLToPath(new URL('../../../migrations/', import.meta.url))
);

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
    // Purpose: the CLI bakes this id in and the release manifest carries it; a launcher refuses
    // a release whose id differs. Fails if either stops reading the folder the server migrates
    // from, or the two stop hashing it the same way: each sorted .sql file's name, a NUL, its
    // bytes, a NUL.
    expect(cliBuild).toContain(`path.join(ROOT, '${migrations}')`);
    const named = /--migrations (\S+)/u.exec(workflow)?.[1];
    expect(named && expandSpaceDir(named)).toBe(migrations);
    for (const source of [cliBuild, manifestGenerator]) {
      expect(source).toMatch(/\.filter\(\(entry\) => entry\.endsWith\('\.sql'\)\)\s*\.sort\(\)/u);
      expect(source).toMatch(
        /\.update\(filename\);\s*\w+\.update\('\\0'\);\s*\w+\.update\([^\n]*readFile(?:Sync)?\([^\n]*filename\)\)\)?;\s*\w+\.update\('\\0'\);/u
      );
      expect(source).toContain('`sha256:${');
    }
  });
});
