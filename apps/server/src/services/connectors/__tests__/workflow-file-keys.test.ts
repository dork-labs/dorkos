/**
 * Keeps the repository control-file check honest about which arguments it
 * reads (DOR-4508). The check reads only keys matching `path` (and nested
 * values under them) plus `deletes`; file content is never read as a path.
 * This test walks a snapshot of every write or destructive action of the
 * repository apps and fails when a string argument whose name looks like a
 * location is neither read by the check nor listed below with the reason it
 * is not a repository file location. Refresh the snapshot from Composio's
 * live schemas, and a new upload or commit schema can't slip past unseen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changesRepositoryControlFiles } from '../execution/workflow-files.js';

/** Per action, the key path of each string argument; `[]` marks an array item. */
const snapshot = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'repository-write-arguments.json'), 'utf8')
) as { checkedAt: string; toolkits: Record<string, Record<string, string[] | null>> };

/** Argument key spelled without case or separators. */
const loose = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Leaf names that could hold a location (Security's list, DOR-4508). */
function looksLikeLocation(leaf: string): boolean {
  return /path|file|dest|target/.test(leaf) || ['to', 'from', 'name', 'ref'].includes(leaf);
}

/** These leaf names never hold a repository file location in a write action of these apps. */
const NOT_A_PATH_LEAF: Readonly<Record<string, string>> = {
  name: 'names a label, repository, team, variable, release, field or person',
  ref: 'a git ref or commit to act on, not a file; new branches are the history check',
  targetcommitish: 'the commit a release points at',
  targethash: 'the commit a new branch starts from',
  targetbranch: 'the branch a merge request targets',
  destinationbranch: 'the branch a pull request targets',
  target: 'a ruleset or token target type (branch, tag, repository)',
  targeturl: 'a web link shown on a status',
  targetissueiid: 'an issue number',
  targetprojectid: 'a project id',
  permissionsprofile: 'a token permission level',
};

/** Single fields that look like files but aren't repository files, each with why. */
const NOT_A_REPOSITORY_FILE: Readonly<Record<string, string>> = {
  'GITHUB_CREATE_A_GIST files': 'a gist, not a repository',
  'GITHUB_UPDATE_A_GIST files': 'a gist, not a repository',
  'GITLAB_CREATE_PERSONAL_SNIPPET file_name': 'a snippet, not a repository file',
  'GITLAB_CREATE_PROJECT_SNIPPET file_name': 'a snippet, not a repository file',
  'GITLAB_UPDATE_PERSONAL_SNIPPET file_name': 'a snippet, not a repository file',
  'GITLAB_UPDATE_PROJECT_SNIPPET file_name': 'a snippet, not a repository file',
  'GITLAB_UPLOAD_GROUP_WIKI_ATTACHMENT file': 'a wiki attachment, not a repository file',
  'GITLAB_UPLOAD_PROJECT_WIKI_ATTACHMENT file': 'a wiki attachment, not a repository file',
  'GITHUB_CREATE_A_SCOPED_ACCESS_TOKEN permissions__single__file':
    'a token scope; minting a token is already a one-by-one pick',
};

/** `{ a: [{ b: value }] }` from the key path `a[].b`. */
function argumentsAt(path: string, value: string): Record<string, unknown> {
  const parts = path
    .split('.')
    .flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), '[]'] : [part]));
  let node: unknown = value;
  for (const part of parts.reverse()) node = part === '[]' ? [node] : { [part]: node };
  return node as Record<string, unknown>;
}

const fields = Object.values(snapshot.toolkits).flatMap((actions) =>
  Object.entries(actions).flatMap(([slug, paths]) => (paths ?? []).map((path) => ({ slug, path })))
);
const leafOf = (path: string) => loose(path.replaceAll('[]', '').split('.').pop()!);

describe('which repository arguments the control-file check reads (DOR-4508)', () => {
  it('has a complete snapshot of the repository apps', () => {
    expect(Object.keys(snapshot.toolkits).sort()).toEqual([
      'bitbucket',
      'gitea',
      'github',
      'github_mcp',
      'gitlab',
    ]);
    for (const actions of Object.values(snapshot.toolkits)) {
      expect(Object.values(actions).filter((paths) => paths === null)).toEqual([]);
    }
  });

  it('reads every location-like argument, or knows why it is not a repository file', () => {
    const unexplained = fields
      .filter(({ path }) => looksLikeLocation(leafOf(path)))
      .filter(
        ({ path }) => !changesRepositoryControlFiles(argumentsAt(path, '.github/workflows/ci.yml'))
      )
      .filter(
        ({ slug, path }) =>
          !NOT_A_PATH_LEAF[leafOf(path)] && !NOT_A_REPOSITORY_FILE[`${slug} ${path}`]
      )
      .map(({ slug, path }) => `${slug} ${path}`);
    expect(unexplained).toEqual([]);
  });

  it('reads the real path keys it is meant to', () => {
    for (const [slug, path] of [
      ['GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS', 'path'],
      ['GITLAB_CREATE_COMMIT', 'actions[].file_path'],
      ['GITLAB_CREATE_COMMIT', 'actions[].previous_path'],
    ] as const) {
      expect(fields).toContainEqual({ slug, path });
      expect(changesRepositoryControlFiles(argumentsAt(path, '.github/workflows/ci.yml'))).toBe(
        true
      );
    }
  });

  it.each([
    { ci_config_path: 'ci/x.yml' },
    { ciConfigPath: ' build.yml ' },
    { CI_CONFIG_PATH: '.gitlab-ci.yml@other/project' },
    { settings: [{ ci_config_path: 'a.yml' }] },
    { ci_config_path: 7 },
    { ci_config_path: { file: 'x.yml' } },
  ])('treats moving the CI config to anywhere as a control change: %o', (args) => {
    expect(changesRepositoryControlFiles(args)).toBe(true);
  });

  it.each([
    { ci_config_path: '' },
    { ci_config_path: '   ' },
    { ci_config_path: null },
    { name: 'ci' },
  ])('leaves a project update that keeps the CI config where it is alone: %o', (args) => {
    expect(changesRepositoryControlFiles(args)).toBe(false);
  });

  it('lists no exception the snapshot no longer has', () => {
    const present = new Set(fields.map(({ slug, path }) => `${slug} ${path}`));
    expect(Object.keys(NOT_A_REPOSITORY_FILE).filter((entry) => !present.has(entry))).toEqual([]);
    const leaves = new Set(fields.map(({ path }) => leafOf(path)));
    expect(Object.keys(NOT_A_PATH_LEAF).filter((leaf) => !leaves.has(leaf))).toEqual([]);
  });
});
