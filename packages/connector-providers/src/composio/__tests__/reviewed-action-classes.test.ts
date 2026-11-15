import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyComposioAction } from '../action-classes.js';
import { PINNED_WRITE_SLUGS_WITH_DELETES } from './pinned-write-slugs.js';
import { PINNED_READ_SLUGS } from './pinned-read-slugs.js';

const live = JSON.parse(
  readFileSync(new URL('./fixtures/live-tool-tags.json', import.meta.url), 'utf8')
) as Record<string, Array<{ slug: string; tags: string[] }>>;
const actions = Object.values(live).flat();
// Each slug was reviewed against its description in the 2026-11-15 catalog.
const explicit = [
  'GOOGLEDRIVE_UPDATE_FILE_REVISION_METADATA', // reach
  'SLACK_SET_STATUS', // reach
  'GITHUB_UPDATE_A_PROJECT', // reach
  'GITHUB_UPDATE_USER_LIST', // reach
  'TWITTER_UPDATE_LIST', // reach
  'GOOGLEDRIVE_MOVE_FILE', // reach
  'GOOGLEDRIVE_ADD_PARENT', // reach
  'GOOGLEDRIVE_INSERT_CHILD', // reach
  'GOOGLEDRIVE_UPDATE_FILE_PUT', // reach
  'GOOGLEDRIVE_COPY_FILE_ADVANCED', // reach
  'NOTION_MOVE_PAGE', // reach
  'GOOGLEDRIVE_CREATE_FILE', // reach
  'GOOGLEDRIVE_CREATE_FILE_FROM_TEXT', // reach
  'GOOGLEDRIVE_CREATE_FOLDER', // reach
  'GOOGLEDRIVE_UPLOAD_FILE', // reach
  'NOTION_CREATE_DATABASE', // reach
  'NOTION_CREATE_NOTION_PAGE', // reach
  'NOTION_DUPLICATE_PAGE', // reach
  'GOOGLEDRIVE_DELETE_CHILD', // reach
  'GOOGLEDRIVE_DELETE_PARENT', // reach
  'GOOGLEDRIVE_UPDATE_FILE_METADATA_PATCH', // reach
  'GITHUB_UPLOAD_SARIF_ANALYSIS', // security controls
  'GITHUB_CREATE_A_COMMIT_STATUS', // security controls
  'GITHUB_CREATE_A_CHECK_RUN', // security controls
  'GITHUB_UPDATE_A_CHECK_RUN', // security controls
  'GITHUB_CREATE_A_CHECK_SUITE', // security controls
  'GITHUB_UPDATE_REPOSITORY_PREFERENCES_FOR_CHECK_SUITES', // security controls
  'GITHUB_CREATE_ISSUE_TYPE', // security controls
  'GITHUB_UPDATE_ISSUE_TYPE', // security controls
  'GITHUB_CREATE_A_DEPLOYMENT', // security controls
  'GITHUB_CREATE_A_DEPLOYMENT_STATUS', // security controls
  'GITHUB_DELETE_A_RELEASE', // irreversible delete
  'GITHUB_DELETE_A_REPOSITORY', // irreversible delete
  'GITHUB_DELETE_DEPLOYMENT', // irreversible delete
  'GITHUB_DELETE_ISSUE_COMMENT', // irreversible delete
  'GITHUB_DELETE_ISSUE_REACTION', // irreversible delete
  'GITHUB_DELETE_LABEL', // irreversible delete
  'GITHUB_DELETE_PACKAGE', // irreversible delete
  'GITHUB_DELETE_PROJECT', // irreversible delete
  'GMAIL_BATCH_DELETE_MESSAGES', // irreversible delete
  'GMAIL_DELETE_DRAFT', // irreversible delete
  'GMAIL_DELETE_LABEL', // irreversible delete
  'GMAIL_DELETE_MESSAGE', // irreversible delete
  'GMAIL_DELETE_THREAD', // irreversible delete
  'GMAIL_REMOVE_LABEL', // irreversible delete
  'GOOGLECALENDAR_CALENDARS_DELETE', // irreversible delete
  'GOOGLEDOCS_DELETE_TAB', // irreversible delete
  'GOOGLEDRIVE_DELETE_COMMENT', // irreversible delete
  'GOOGLEDRIVE_DELETE_DRIVE', // irreversible delete
  'GOOGLEDRIVE_DELETE_FILE', // irreversible delete
  'GOOGLEDRIVE_DELETE_REPLY', // irreversible delete
  'GOOGLEDRIVE_DELETE_REVISION', // irreversible delete
  'GOOGLEDRIVE_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION', // irreversible delete
  'LINEAR_DELETE_LINEAR_ISSUE', // irreversible delete
  'SLACK_DELETE_CHANNEL', // irreversible delete
  'SLACK_DELETE_FILE', // irreversible delete
  'SLACK_DELETE_FILE_COMMENT', // irreversible delete
  'SLACK_DELETE_REMINDER', // irreversible delete
  'TWITTER_DELETE_DM', // irreversible delete
  'TWITTER_DELETE_LIST', // irreversible delete
  'TWITTER_POST_DELETE_BY_POST_ID', // irreversible delete
  'GITHUB_DELETE_USER_PACKAGE', // whole container or hidden archive
  'GITHUB_DELETE_USER_LIST', // whole container or hidden archive
  'LINEAR_ARCHIVE_PROJECT', // whole container or hidden archive
  'SLACK_ARCHIVE_CONVERSATION', // whole container or hidden archive
  'NOTION_UPDATE_PAGE', // whole container or hidden archive
  'GITHUB_CREATE_AN_ENVIRONMENT_VARIABLE', // security controls
  'GITHUB_CREATE_A_REPOSITORY_VARIABLE', // security controls
  'GITHUB_UPDATE_AN_ENVIRONMENT_VARIABLE', // security controls
  'GITHUB_UPDATE_A_REPOSITORY_VARIABLE', // security controls
  'GITHUB_DELETE_APP_AUTHORIZATION', // credentials
];

describe('reviewed Composio exceptions', () => {
  it.each(explicit)('keeps %s explicit with deletes off and on', (slug) => {
    const action = actions.find((row) => row.slug === slug);
    expect(action, 'must exist in the dated catalog').toBeDefined();
    for (const writeIncludesDeletes of [false, true]) {
      expect(classifyComposioAction(slug, action!.tags, { writeIncludesDeletes })).toBe(
        'destructive'
      );
    }
  });

  it.each([
    'GITHUB_CREATE_A_RELEASE',
    'GITHUB_UPDATE_A_RELEASE',
    'GITHUB_UPLOAD_RELEASE_ASSET',
    'GITHUB_MERGE_A_BRANCH',
    'GITHUB_MERGE_A_PULL_REQUEST',
    'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS',
    'GOOGLEDRIVE_COPY_FILE',
    'GOOGLEDRIVE_CREATE_SHORTCUT_TO_FILE',
  ])('retains the reviewed write %s', (slug) => {
    const action = actions.find((row) => row.slug === slug);
    expect(action).toBeDefined();
    for (const writeIncludesDeletes of [false, true]) {
      expect(classifyComposioAction(slug, action!.tags, { writeIncludesDeletes })).toBe('write');
    }
  });

  it.each(Object.keys(live))('pins every %s write when deletes are enabled', (toolkit) => {
    expect(
      live[toolkit]!.filter(
        ({ slug, tags }) =>
          classifyComposioAction(slug, tags, { writeIncludesDeletes: true }) === 'write'
      )
        .map(({ slug }) => slug)
        .sort()
    ).toEqual(PINNED_WRITE_SLUGS_WITH_DELETES[toolkit]);
  });

  it.each(Object.keys(live))('pins every %s read with either delete setting', (toolkit) => {
    for (const writeIncludesDeletes of [false, true]) {
      expect(
        live[toolkit]!.filter(
          ({ slug, tags }) =>
            classifyComposioAction(slug, tags, { writeIncludesDeletes }) === 'read'
        )
          .map(({ slug }) => slug)
          .sort()
      ).toEqual(PINNED_READ_SLUGS[toolkit]);
    }
  });
});
