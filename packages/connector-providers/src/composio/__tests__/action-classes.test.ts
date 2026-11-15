import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accessLevelRevisionIds } from '../../connector-schemas.js';
import {
  classifyComposioAction,
  isAccountReachAction,
  WRITE_INCLUDES_DELETES,
} from '../action-classes.js';

const live = JSON.parse(
  readFileSync(new URL('./fixtures/live-tool-tags.json', import.meta.url), 'utf8')
) as Record<string, Array<{ slug: string; tags: string[] }>>;
const actions = Object.values(live).flat();

// Real slugs, checked for presence before classifying with their actual tags.
const excluded = [
  'GMAIL_FORWARD_MESSAGE', // mail
  'GMAIL_CREATE_FILTER', // mail
  'GMAIL_UPDATE_SEND_AS', // mail
  'GMAIL_PATCH_SEND_AS', // mail
  'GMAIL_UPDATE_IMAP_SETTINGS', // mail
  'GMAIL_UPDATE_POP_SETTINGS', // mail
  'GMAIL_UPDATE_VACATION_SETTINGS', // mail
  'GMAIL_IMPORT_MESSAGE', // mail
  'GMAIL_INSERT_MESSAGE', // mail
  'GMAIL_BATCH_MODIFY_MESSAGES', // reach, retained exact exclusion
  'GOOGLECALENDAR_EVENTS_MOVE', // reach, destination calendar
  'GOOGLEDRIVE_CREATE_PERMISSION', // sharing
  'GOOGLEDRIVE_UPDATE_PERMISSION', // sharing
  'GOOGLEDRIVE_PATCH_PERMISSION', // sharing
  'GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE', // sharing
  'GOOGLEDRIVE_WATCH_CHANGES', // hooks
  'GOOGLEDRIVE_WATCH_FILE', // hooks
  'GOOGLEDRIVE_UPDATE_DRIVE', // reach, drive settings
  'SLACK_ENABLE_PUBLIC_SHARING_OF_A_FILE', // sharing
  'SLACK_SHARE_REMOTE_FILE', // sharing
  'SLACK_INVITE_USER_TO_WORKSPACE', // sharing
  'SLACK_INVITE_USERS_TO_A_SLACK_CHANNEL', // sharing
  'SLACK_INVITE_USER_TO_CHANNEL', // sharing
  'SLACK_ADD_ENTERPRISE_USER_TO_WORKSPACE', // people
  'SLACK_SET_ADMIN_USER', // people
  'SLACK_SET_WORKSPACE_OWNER', // people
  'SLACK_SET_CANVAS_ACCESS', // sharing
  'SLACK_SET_SLACK_LIST_ACCESS', // sharing
  'SLACK_RESTRICT_APP_INSTALLATION', // credentials
  'SLACK_CREATE_USER_GROUP', // people
  'SLACK_UPDATE_USER_GROUP', // people
  'SLACK_ENABLE_USER_GROUP', // people
  'SLACK_DISABLE_USER_GROUP', // people
  'SLACK_SET_USER_PROFILE', // people
  'SLACK_SET_PROFILE_PHOTO', // people
  'SLACK_SET_CONVERSATION_PREFS', // reach, conversation settings
  'GITHUB_CREATE_A_REPOSITORY_WEBHOOK', // hooks
  'GITHUB_CREATE_AN_ORGANIZATION_WEBHOOK', // hooks
  'GITHUB_ADD_A_REPOSITORY_COLLABORATOR', // sharing
  'GITHUB_ADD_OR_UPDATE_TEAM_MEMBERSHIP_FOR_USER', // sharing
  'GITHUB_CREATE_A_DEPLOY_KEY', // credentials
  'GITHUB_CREATE_A_SCOPED_ACCESS_TOKEN', // credentials
  'GITHUB_CREATE_A_GITHUB_APP_FROM_A_MANIFEST', // credentials
  'GITHUB_ASSIGN_ORGANIZATION_ROLE_TO_USER', // people
  'GITHUB_TRANSFER_A_REPOSITORY', // sharing
  'GITHUB_SET_EMAIL_VISIBILITY', // sharing
  'GITHUB_CREATE_A_GIST', // sharing
  'GITHUB_CREATE_REPOSITORY', // reach, visibility or destination
  'GITHUB_CREATE_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER', // reach, visibility
  'GITHUB_CREATE_A_REPOSITORY_USING_A_TEMPLATE', // reach, visibility
  'GITHUB_UPDATE_A_REPOSITORY', // reach, visibility
  'GITHUB_CREATE_A_FORK', // reach, destination
  'GITHUB_CREATE_A_TEMPORARY_PRIVATE_FORK', // reach, destination
  'GITHUB_UPDATE_THE_AUTHENTICATED_USER', // people
  'GITHUB_ADD_STATUS_CHECK_CONTEXTS', // controls
  'GITHUB_SET_STATUS_CHECK_CONTEXTS', // controls
  'GITHUB_CREATE_OR_UPDATE_AN_ENVIRONMENT', // controls
  'GITHUB_CREATE_A_DEPLOYMENT_BRANCH_POLICY', // controls
  'GITHUB_UPDATE_A_DEPLOYMENT_BRANCH_POLICY', // controls
  'GITHUB_CREATE_SPONSORSHIP', // money
  'GITHUB_CREATE_A_CODESPACE_IN_A_REPOSITORY', // money
  'GITHUB_UPDATE_A_REFERENCE', // irreversible, force move
  'LINEAR_CREATE_TEAM', // people
  'LINEAR_UPDATE_TEAM', // people
  'LINEAR_ARCHIVE_ISSUE', // deletes
  'LINEAR_ARCHIVE_PROJECT', // deletes
  'GOOGLEDOCS_UPDATE_DOCUMENT_BATCH', // deletes, batch
] as const;

describe('Composio action classes', () => {
  it('pins the complete dated fixture, with only sorted slugs and tags', () => {
    expect(Object.keys(live)).toEqual([
      'github',
      'gmail',
      'googlecalendar',
      'googledocs',
      'googledrive',
      'linear',
      'notion',
      'slack',
      'twitter',
    ]);
    expect(Object.values(live).map((rows) => rows.length)).toEqual([
      905, 63, 50, 48, 105, 48, 60, 174, 84,
    ]);
    for (const rows of Object.values(live)) {
      expect(rows.map(({ slug }) => slug)).toEqual(rows.map(({ slug }) => slug).sort());
      expect(new Set(rows.map(({ slug }) => slug)).size).toBe(rows.length);
      for (const row of rows) expect(Object.keys(row).sort()).toEqual(['slug', 'tags']);
    }
  });

  it.each(excluded)(
    'keeps the pinned exception %s out of write with either delete setting',
    (slug) => {
      const action = actions.find((row) => row.slug === slug);
      expect(action, 'must be a real action in the dated catalog').toBeDefined();
      // Batch and plain archive actions follow the delete flag; the rest never do.
      const deleteOnly = [
        'LINEAR_ARCHIVE_ISSUE',
        'LINEAR_ARCHIVE_PROJECT',
        'GOOGLEDOCS_UPDATE_DOCUMENT_BATCH',
      ].includes(slug);
      expect(classifyComposioAction(slug, action!.tags, { writeIncludesDeletes: false })).toBe(
        'destructive'
      );
      expect(classifyComposioAction(slug, action!.tags, { writeIncludesDeletes: true })).toBe(
        deleteOnly ? 'write' : 'destructive'
      );
    }
  );

  it.each(['googledocs', 'notion'])(
    'pins that %s has no reach actions in this catalog',
    (toolkit) => {
      expect(live[toolkit]).toHaveLength(toolkit === 'googledocs' ? 48 : 60);
      // The catalog includes permission/filter queries, but no changing reach action.
      const named = live[toolkit]!.filter(({ slug }) => isAccountReachAction(slug));
      expect(named.map(({ slug }) => slug)).toEqual(
        toolkit === 'googledocs'
          ? ['GOOGLEDOCS_LIST_DRIVE_ITEM_PERMISSIONS']
          : ['NOTION_QUERY_DATABASE_WITH_FILTER']
      );
      expect(named.map(({ slug, tags }) => classifyComposioAction(slug, tags))).toEqual(['read']);
      expect(named.filter(({ tags }) => !tags.includes('readOnlyHint'))).toEqual([]);
    }
  );

  it.each([
    'GOOGLEDOCS_SHARE_DOCUMENT',
    'GOOGLEDOCS_CREATE_PERMISSION',
    'NOTION_SHARE_PAGE',
    'NOTION_INVITE_MEMBER',
    'NOTION_CREATE_WEBHOOK',
    'LINEAR_CREATE_WEBHOOK',
    'LINEAR_INVITE_USER',
    'LINEAR_CREATE_API_KEY',
  ])('keeps the synthetic future reach action %s explicit', (slug) => {
    expect(actions.some((row) => row.slug === slug)).toBe(false);
    expect(classifyComposioAction(slug, ['createHint'])).toBe('destructive');
  });

  it('puts Linear issue creation and editing in Read and write, without deletes or teams', () => {
    const candidates = live.linear!.map(({ slug, tags }) => ({
      operationRevisionId: slug,
      operationSlug: slug,
      toolkit: 'linear',
      supported: true,
      capabilityClassification: classifyComposioAction(slug, tags),
    }));
    const ids = accessLevelRevisionIds(candidates, 'read-write');
    for (const slug of ['LINEAR_CREATE_LINEAR_ISSUE', 'LINEAR_UPDATE_ISSUE']) {
      expect(candidates.find((row) => row.operationSlug === slug)?.capabilityClassification).toBe(
        'write'
      );
      expect(ids).toContain(slug);
    }
    const excludedLinear = live.linear!.filter(({ slug }) =>
      /DELETE|(?<!UN)ARCHIVE|TEAM/.test(slug)
    );
    expect(excludedLinear.map(({ slug }) => slug)).toEqual([
      'LINEAR_ARCHIVE_ISSUE',
      'LINEAR_ARCHIVE_PROJECT',
      'LINEAR_ARCHIVE_PROJECT_UPDATE',
      'LINEAR_CREATE_TEAM',
      'LINEAR_DELETE_LINEAR_ISSUE',
      'LINEAR_GET_ALL_LINEAR_TEAMS',
      'LINEAR_GET_CYCLES_BY_TEAM_ID',
      'LINEAR_LIST_ISSUES_BY_TEAM_ID',
      'LINEAR_LIST_LINEAR_TEAMS',
      'LINEAR_UPDATE_TEAM',
    ]);
    for (const { slug, tags } of excludedLinear) {
      if (!tags.includes('readOnlyHint')) expect(ids).not.toContain(slug);
    }
  });

  it('gives a clean write verdict to an app outside the dated fixture too', () => {
    expect(classifyComposioAction('FUTUREAPP_CREATE_ITEM', ['createHint'])).toBe('write');
  });
});

describe('delete decision', () => {
  it('defaults to keeping deletes explicit until the owner decides', () => {
    expect(WRITE_INCLUDES_DELETES).toBe(false);
  });

  it.each([
    ['LINEAR_DELETE_LINEAR_ISSUE', ['destructiveHint']],
    ['GMAIL_MOVE_TO_TRASH', ['updateHint', 'openWorldHint']],
    ['GMAIL_DELETE_MESSAGE', ['destructiveHint', 'idempotentHint', 'openWorldHint']],
    ['SLACK_ARCHIVE_CONVERSATION', ['updateHint']],
    ['SLACK_CLOSE_DM', ['updateHint']],
    ['SLACK_LEAVE_CONVERSATION', ['updateHint']],
    ['GOOGLEDOCS_UPDATE_DOCUMENT_BATCH', ['updateHint']],
  ] as const)('flips only the delete decision for %s', (slug, tags) => {
    expect(classifyComposioAction(slug, tags)).toBe('destructive');
    expect(classifyComposioAction(slug, tags, { writeIncludesDeletes: false })).toBe('destructive');
    expect(classifyComposioAction(slug, tags, { writeIncludesDeletes: true })).toBe('write');
  });

  it.each([
    ['GMAIL_DELETE_FILTER', ['destructiveHint']], // reach + delete
    ['GITHUB_DELETE_AN_INVOICE', ['destructiveHint']], // money + delete, synthetic
    ['GITHUB_DELETE_A_REFERENCE_PERMANENTLY', ['destructiveHint']], // irreversible + delete, synthetic
    ['SLACK_REVOKE_TOKEN', ['updateHint']], // credentials + irreversible, synthetic
    ['GITHUB_TRANSFER_A_REPOSITORY', ['updateHint']], // reach
    ['GMAIL_DELETE_MESSAGE', []], // missing verdict
    ['GMAIL_DELETE_MESSAGE', ['destructiveHint', 'createHint']], // conflicting verdicts
    ['GMAIL_DELETE_MESSAGE', ['destructiveHint', 'futureEffectHint']], // unknown hint
    ['GMAIL_DELETE_MESSAGE', ['readOnlyHint', 'destructiveHint']], // conflicting verdicts
    ['GMAIL_SEND_DRAFT', ['updateHint', 'destructiveHint']], // irreversible hint, no delete
  ] as const)('does not widen a second exclusion or unknown verdict for %s (%j)', (slug, tags) => {
    expect(classifyComposioAction(slug, tags, { writeIncludesDeletes: true })).toBe('destructive');
  });

  it.each(['GMAIL_UNTRASH_MESSAGE', 'LINEAR_UNARCHIVE_PROJECT_UPDATE'])(
    'keeps restoring %s in write',
    (slug) => {
      expect(classifyComposioAction(slug, ['updateHint'])).toBe('write');
    }
  );

  it('keeps every catalog delete with a changing verdict explicit by default', () => {
    const deletes = actions.filter(
      ({ slug, tags }) =>
        /DELETE|REMOVE|(?<!UN)TRASH|(?<!UN)ARCHIVE|_LEAVE(?:_|$)|CLOSE_DM|(?:^|_)BATCH(?:_|$)/.test(
          slug
        ) && tags.some((tag) => ['createHint', 'updateHint', 'destructiveHint'].includes(tag))
    );
    expect(deletes.length).toBeGreaterThan(0);
    for (const { slug, tags } of deletes) {
      expect([slug, classifyComposioAction(slug, tags)]).toEqual([slug, 'destructive']);
    }
  });
});

describe('money and irreversible names', () => {
  it.each([
    'SPONSORSHIP',
    'CODESPACE',
    'PAYMENT',
    'CHARGE',
    'REFUND',
    'INVOICE',
    'PAYOUT',
    'PURCHASE',
    'ORDER',
    'BILLING',
    'CHECKOUT',
    'PRICE',
    'DONATION',
    'PURGE',
    'WIPE',
    'RESET',
    'REVOKE',
    'CANCEL',
    'EMPTY',
    'FORCE',
    'DESTROY',
    'TERMINATE',
    'PERMANENT',
  ])('keeps the synthetic %s action explicit', (name) => {
    for (const writeIncludesDeletes of [false, true]) {
      expect(
        classifyComposioAction(`FUTUREAPP_CREATE_${name}`, ['createHint'], { writeIncludesDeletes })
      ).toBe('destructive');
    }
  });

  it('keeps every money-family catalog action out of write', () => {
    const money = actions.filter(({ slug }) =>
      /SPONSOR|CODESPACE|PAYMENT|CHARGE|REFUND|INVOICE|PAYOUT|PURCHASE|ORDER|BILLING|CHECKOUT|PRICE|DONAT/.test(
        slug
      )
    );
    expect(money.length).toBeGreaterThan(0);
    for (const { slug, tags } of money)
      expect([slug, classifyComposioAction(slug, tags)]).not.toEqual([slug, 'write']);
  });

  it('never promotes a read just because its name matches a family', () => {
    for (const slug of ['GMAIL_LIST_FILTERS', 'GITHUB_LIST_INVOICES', 'GOOGLECALENDAR_ACL_LIST']) {
      expect(classifyComposioAction(slug, ['readOnlyHint'])).toBe('read');
    }
  });
});
