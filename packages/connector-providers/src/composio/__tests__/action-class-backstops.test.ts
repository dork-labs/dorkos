/**
 * Name backstops for actions nobody has reviewed yet (DOR-4505, DOR-4506,
 * DOR-4509): a new money app, a camel-case OAuth action and a new repository
 * merge, branch, tag or release action stay one-by-one picks without a code
 * change, and ordinary look-alikes stay writes.
 */
import { describe, expect, it } from 'vitest';
import { classifyComposioAction } from '../action-classes.js';

const WRITE = ['createHint'];

describe('money apps by name (DOR-4505)', () => {
  it('lists PayPal Zettle as a money app', () => {
    expect(classifyComposioAction('zettle', 'ZETTLE_CREATE_PRODUCT', WRITE)).toBe('destructive');
  });

  it.each([
    ['paystack_mcp', 'PAYSTACK_MCP_CREATE_NOTE'],
    ['acme_wallet', 'ACME_WALLET_UPDATE_LABEL'],
    ['hitpay_v2', 'HITPAY_V2_CREATE_LINK'],
    ['open_banking', 'OPEN_BANKING_CREATE_NOTE'],
    ['Coin_Ledger', 'COIN_LEDGER_UPDATE_TAG'],
  ])('keeps every change on unreviewed %s a one-by-one pick', (toolkit, slug) => {
    expect(classifyComposioAction(toolkit, slug, WRITE)).toBe('destructive');
  });

  it('still lets a money app read', () => {
    expect(classifyComposioAction('acme_wallet', 'ACME_WALLET_LIST_LABELS', ['readOnlyHint'])).toBe(
      'read'
    );
  });

  it.each([
    ['campayn', 'CAMPAYN_CREATE_LIST'],
    ['gmail', 'GMAIL_SEND_EMAIL'],
    ['spotify', 'SPOTIFY_CREATE_PLAYLIST'],
  ])('leaves %s, whose name only contains a stem mid-word, an ordinary app', (toolkit, slug) => {
    expect(classifyComposioAction(toolkit, slug, WRITE)).toBe('write');
  });
});

describe('camel-case OAuth names (DOR-4506)', () => {
  it.each(['createOAuthApp', 'updateOAuthClientSecret', 'GitHubCreateOAuthApp'])(
    'reads %s as a credentials action',
    (slug) => {
      expect(classifyComposioAction('github', slug, WRITE)).toBe('destructive');
    }
  );

  it('does not read a word ending in O, like REPO_AUTHORS, as OAuth', () => {
    expect(classifyComposioAction('github', 'GITHUB_UPDATE_REPO_AUTHORS', WRITE)).toBe('write');
  });
});

describe('repository persistence by name (DOR-4509)', () => {
  it.each([
    ['github', 'GITHUB_MERGE_UPSTREAM_INTO_FORK'],
    ['github', 'GITHUB_CREATE_A_TAG'],
    ['github', 'GITHUB_REBASE_A_PULL_REQUEST'],
    ['github_mcp', 'GITHUB_MCP_CREATE_RELEASE'],
    ['gitlab', 'GITLAB_UPDATE_REPOSITORY_BRANCH'],
    ['gitea', 'GITEA_CREATE_TAG'],
    ['bitbucket', 'BITBUCKET_CREATE_BRANCH'],
    ['bitbucket', 'bitbucket-merge-pull-request'],
  ])('keeps a new %s action %s a one-by-one pick', (toolkit, slug) => {
    for (const hints of [WRITE, ['updateHint']]) {
      for (const writeIncludesDeletes of [false, true]) {
        expect(classifyComposioAction(toolkit, slug, hints, { writeIncludesDeletes })).toBe(
          'destructive'
        );
      }
    }
  });

  it.each([
    ['gitlab', 'GITLAB_CREATE_MERGE_REQUEST'],
    ['gitlab', 'GITLAB_UPDATE_MERGE_REQUEST'],
    ['github', 'GITHUB_CREATE_AN_AUTOLINK_REFERENCE_FOR_A_REPOSITORY'],
    ['github', 'GITHUB_CREATE_REACTION_FOR_A_RELEASE'],
    ['github', 'GITHUB_CREATE_A_TAG_OBJECT'],
  ])('leaves ordinary %s action %s a write', (toolkit, slug) => {
    expect(classifyComposioAction(toolkit, slug, WRITE)).toBe('write');
  });

  it.each([
    ['github', 'GITHUB_LIST_BRANCHES'],
    ['github', 'GITHUB_GET_A_RELEASE'],
    ['gitlab', 'GITLAB_GET_MERGE_REQUEST'],
  ])('keeps %s read %s a read', (toolkit, slug) => {
    expect(classifyComposioAction(toolkit, slug, ['readOnlyHint'])).toBe('read');
  });

  it('applies only to repository apps', () => {
    expect(classifyComposioAction('futureapp', 'FUTUREAPP_MERGE_BRANCH', ['updateHint'])).toBe(
      'write'
    );
  });
});
