import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyComposioAction } from '../action-classes.js';

// Real catalog tags: GitHub's dated fixture plus read-only GitLab/Gitea/MCP lists.
const catalog = JSON.parse(
  readFileSync(new URL('./fixtures/repository-persistence-actions.json', import.meta.url), 'utf8')
) as Record<string, { slug: string; tags: string[] }[]>;
const actions = Object.entries(catalog).flatMap(([toolkit, rows]) =>
  rows.map((row) => ({ toolkit, ...row }))
);

describe('Security repository persistence choices', () => {
  it('pins the verified persistence action names exactly', () => {
    expect(actions.map((row) => row.slug).sort()).toEqual([
      'GITEA_CREATE_BRANCH',
      'GITEA_MERGE_PULL_REQUEST',
      'GITHUB_CREATE_A_REFERENCE',
      'GITHUB_MCP_CREATE_BRANCH',
      'GITHUB_MCP_MERGE_PULL_REQUEST',
      'GITHUB_MERGE_A_BRANCH',
      'GITHUB_MERGE_A_PULL_REQUEST',
      'GITLAB_CHERRY_PICK_COMMIT',
      'GITLAB_CREATE_REPOSITORY_BRANCH',
      'GITLAB_MERGE_MERGE_REQUEST',
      'GITLAB_REBASE_MERGE_REQUEST',
      'GITLAB_REVERT_COMMIT',
    ]);
  });
  it.each(actions)(
    'keeps $slug a one-by-one pick under either delete setting',
    ({ toolkit, slug, tags }) => {
      for (const hints of [tags, ['createHint'], ['updateHint'], ['readOnlyHint']]) {
        for (const writeIncludesDeletes of [false, true]) {
          expect(classifyComposioAction(toolkit, slug, hints, { writeIncludesDeletes })).toBe(
            'destructive'
          );
          expect(
            classifyComposioAction(toolkit, slug.toLowerCase().replaceAll('_', '-'), hints, {
              writeIncludesDeletes,
            })
          ).toBe('destructive');
        }
      }
    }
  );
  it.each(['GOOGLEDOCS_MERGE_TABLE_CELLS', 'FUTUREAPP_MERGE_RECORDS'])(
    'does not turn %s into a repository action by name alone',
    (slug) => {
      expect(classifyComposioAction('futureapp', slug, ['updateHint'])).toBe('write');
    }
  );
});
