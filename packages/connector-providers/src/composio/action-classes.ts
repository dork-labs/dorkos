import type { ConnectorOperationClassification } from '../connector-schemas.js';

/**
 * Whether otherwise clean deletes belong to Read and write. Flipping this
 * constant is the whole production change for the delete decision (DOR-4451).
 */
export const WRITE_INCLUDES_DELETES = false;

/**
 * Composio's safety verdicts are its tags that end in `Hint`. The same `tags`
 * list also carries category labels ("gmail", "messages", "Events
 * Management", "deprecated") and the `important` mark; those say nothing about
 * what an action does, so classification ignores them.
 */
const HINT_TAG = /Hint$/;

/** Hints that do not contradict an explicit read-only verdict. */
const READ_COMPATIBLE_HINTS = new Set(['readOnlyHint', 'idempotentHint', 'openWorldHint']);

/**
 * Composio's two verdicts for an action that makes or changes something
 * without removing it: `createHint` (sending an email, opening an issue) and
 * `updateHint` (editing something in place).
 */
const WRITE_VERDICT_HINTS = new Set(['createHint', 'updateHint']);

/**
 * Hints that do not contradict a create or update verdict. `destructiveHint`
 * and `readOnlyHint` are deliberately absent: Composio puts `destructiveHint`
 * on every irreversible action, including an irreversible update that also
 * carries `updateHint`, and a read verdict beside a write verdict is a
 * contradiction.
 */
const WRITE_COMPATIBLE_HINTS = new Set([
  'createHint',
  'updateHint',
  'idempotentHint',
  'openWorldHint',
]);

/**
 * Classify one action from the safety hints Composio sends, failing toward
 * the strictest tier. Only tags ending in `Hint` count; category tags are
 * ignored, but an unknown `…Hint` is treated as a verdict DorkOS does not
 * understand.
 *
 * - `read`: `readOnlyHint`, and every hint is one of `readOnlyHint`,
 *   `idempotentHint`, `openWorldHint`.
 * - `write`: `createHint` or `updateHint`, and every hint is one of those or
 *   `idempotentHint`, `openWorldHint` — so no `destructiveHint` and no
 *   `readOnlyHint`. Composio documents `destructiveHint` as "irreversibly
 *   removes, cancels or revokes data", so a delete never lands here.
 * - `destructive`: everything else — a destructive verdict, contradictory
 *   verdicts, no verdict at all, or an unknown hint. Idempotence does not
 *   prove read-only, and a missing hint never proves safety.
 *
 * @param tags - The action's `tags` exactly as Composio listed them.
 */
function classifyComposioTags(tags: readonly string[]): ConnectorOperationClassification {
  const hints = tags.filter((tag) => HINT_TAG.test(tag));
  if (hints.includes('readOnlyHint') && hints.every((hint) => READ_COMPATIBLE_HINTS.has(hint))) {
    return 'read';
  }
  if (
    hints.some((hint) => WRITE_VERDICT_HINTS.has(hint)) &&
    hints.every((hint) => WRITE_COMPATIBLE_HINTS.has(hint))
  ) {
    return 'write';
  }
  return 'destructive';
}

/** Exact reach exceptions retained from the dated catalog when a family is insufficient. */
const ACCOUNT_REACH_ACTIONS = new Set([
  'GOOGLECALENDAR_ACL_INSERT',
  'GOOGLECALENDAR_ACL_PATCH',
  'GOOGLECALENDAR_ACL_UPDATE',
  'GOOGLECALENDAR_ACL_WATCH',
  'GOOGLECALENDAR_CALENDAR_LIST_WATCH',
  'GOOGLECALENDAR_EVENTS_MOVE',
  'GOOGLECALENDAR_EVENTS_WATCH',
  'GOOGLECALENDAR_SETTINGS_WATCH',
  'GMAIL_BATCH_MODIFY_MESSAGES',
  'GMAIL_CREATE_FILTER',
  'GMAIL_FORWARD_MESSAGE',
  'GMAIL_PATCH_SEND_AS',
  'GMAIL_UPDATE_SEND_AS',
  'GMAIL_UPDATE_IMAP_SETTINGS',
  'GMAIL_UPDATE_POP_SETTINGS',
  'GMAIL_IMPORT_MESSAGE',
  'GMAIL_INSERT_MESSAGE',
  'GMAIL_UPDATE_VACATION_SETTINGS',
  'GITHUB_CREATE_REPOSITORY',
  'GITHUB_CREATE_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER',
  'GITHUB_CREATE_A_REPOSITORY_USING_A_TEMPLATE',
  'GITHUB_UPDATE_A_REPOSITORY',
  'GITHUB_CREATE_A_FORK',
  'GITHUB_CREATE_A_TEMPORARY_PRIVATE_FORK',
  'GITHUB_UPDATE_THE_AUTHENTICATED_USER',
  'GITHUB_ADD_STATUS_CHECK_CONTEXTS',
  'GITHUB_SET_STATUS_CHECK_CONTEXTS',
  'GITHUB_CREATE_OR_UPDATE_AN_ENVIRONMENT',
  'GITHUB_CREATE_A_DEPLOYMENT_BRANCH_POLICY',
  'GITHUB_UPDATE_A_DEPLOYMENT_BRANCH_POLICY',
  'GOOGLEDRIVE_UPDATE_DRIVE',
  'SLACK_SET_CONVERSATION_PREFS',
  'GOOGLEDRIVE_UPDATE_FILE_REVISION_METADATA',
  'SLACK_SET_STATUS',
  'GITHUB_UPDATE_USER_STATUS',
  'SLACK_CREATE_CHANNEL_BASED_CONVERSATION',
  'GITHUB_UPDATE_A_PROJECT',
  'GITHUB_UPDATE_USER_LIST',
  'TWITTER_UPDATE_LIST',
  'GOOGLEDRIVE_MOVE_FILE',
  'GOOGLEDRIVE_ADD_PARENT',
  'GOOGLEDRIVE_INSERT_CHILD',
  'GOOGLEDRIVE_UPDATE_FILE_PUT',
  'GOOGLEDRIVE_COPY_FILE_ADVANCED',
  'NOTION_MOVE_PAGE',
  'GOOGLEDRIVE_DELETE_CHILD',
  'GOOGLEDRIVE_DELETE_PARENT',
  'GOOGLEDRIVE_UPDATE_FILE_METADATA_PATCH',
  'GITHUB_UPLOAD_SARIF_ANALYSIS',
  'GITHUB_DISMISS_A_REVIEW_FOR_A_PULL_REQUEST',
  'GITHUB_CREATE_A_SNAPSHOT_OF_DEPENDENCIES_FOR_A_REPOSITORY',
  'GITHUB_CREATE_A_COMMIT_STATUS',
  'GITHUB_CREATE_A_CHECK_RUN',
  'GITHUB_UPDATE_A_CHECK_RUN',
  'GITHUB_CREATE_A_CHECK_SUITE',
  'GITHUB_UPDATE_REPOSITORY_PREFERENCES_FOR_CHECK_SUITES',
  'GITHUB_CREATE_ISSUE_TYPE',
  'GITHUB_UPDATE_ISSUE_TYPE',
  'GITHUB_CREATE_A_DEPLOYMENT',
  'GITHUB_CREATE_A_DEPLOYMENT_STATUS',
]);

// Composio-described permanent deletes, whole-container deletes and updates
// hiding an archive, permanent data loss or batch deletions stay explicit with
// deletes on too.
// The remaining pinned delete-on list is what DOR-4451 would admit and review.
const ALWAYS_EXPLICIT_DELETES = new Set([
  'GOOGLEDOCS_UPDATE_DOCUMENT_BATCH',
  'GOOGLECALENDAR_BATCH_EVENTS',
  'GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT',
  'GITHUB_DELETE_A_RELEASE',
  'GITHUB_DELETE_A_REPOSITORY',
  'GITHUB_DELETE_DEPLOYMENT',
  'GITHUB_DELETE_ISSUE_COMMENT',
  'GITHUB_DELETE_ISSUE_REACTION',
  'GITHUB_DELETE_LABEL',
  'GITHUB_DELETE_PACKAGE',
  'GITHUB_DELETE_PROJECT',
  'GMAIL_BATCH_DELETE_MESSAGES',
  'GMAIL_DELETE_DRAFT',
  'GMAIL_DELETE_LABEL',
  'GMAIL_DELETE_MESSAGE',
  'GMAIL_DELETE_THREAD',
  'GMAIL_REMOVE_LABEL',
  'GOOGLECALENDAR_CALENDARS_DELETE',
  'GOOGLEDOCS_DELETE_TAB',
  'GOOGLEDRIVE_DELETE_COMMENT',
  'GOOGLEDRIVE_DELETE_DRIVE',
  'GOOGLEDRIVE_DELETE_FILE',
  'GOOGLEDRIVE_DELETE_REPLY',
  'GOOGLEDRIVE_DELETE_REVISION',
  'GOOGLEDRIVE_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION',
  'LINEAR_DELETE_LINEAR_ISSUE',
  'SLACK_DELETE_CHANNEL',
  'SLACK_DELETE_FILE',
  'SLACK_DELETE_FILE_COMMENT',
  'SLACK_DELETE_REMINDER',
  'TWITTER_DELETE_DM',
  'TWITTER_DELETE_LIST',
  'TWITTER_POST_DELETE_BY_POST_ID',
  'GITHUB_DELETE_USER_PACKAGE',
  'GITHUB_DELETE_USER_LIST',
  'LINEAR_ARCHIVE_PROJECT',
  'SLACK_ARCHIVE_CONVERSATION',
  'NOTION_UPDATE_PAGE',
  'NOTION_UPDATE_SCHEMA_DATABASE',
]);

// Named reach families apply to every app, including future catalog entries.
const MAIL_REACH =
  /FORWARD|SEND_AS|_IMAP_|_POP_|FILTER|VACATION|AUTO_REPL|MAILBOX_SETTINGS|DELEGAT|IMPORT_MESSAGE|INSERT_MESSAGE|_RULE/;
const LIVE_CONNECTION_REACH = /WEBHOOK|_HOOK|SUBSCRI|WATCH|_RTM_|DISPATCH|UNFURL/;
const SHARING_REACH =
  /_ACL_|PERMISSION|SHARING|SHARE|PUBLIC|PUBLISH|VISIBILITY|COLLABORAT|MEMBER|INVIT|PARTICIPANT|_ACCESS|FOLLOW|TRANSFER|GIST|PAGES/;
const CREDENTIAL_REACH =
  /SECRET|TOKEN|_KEY|OAUTH|CREDENTIAL|GITHUB_APP|APP_INSTALLATION|RUNNER|OIDC|EMAIL_ADDRESS|SOCIAL_ACCOUNT/;
const PEOPLE_REACH =
  /ADMIN|OWNER|_ROLE|ROLE_|_USER_TO_|USERS_TO_|_TEAM(?:_|$)|ENTERPRISE|WORKSPACE|ORGANIZATION|_ORG(?:_|$)|DEFAULT_CHANNELS|USER_GROUP|USER_PROFILE|PROFILE_PHOTO/;
const SECURITY_CONTROLS =
  /PROTECTION|RESTRICT|RULESET|ALLOWED_ACTIONS|GITHUB_ACTIONS|WORKFLOW|CODE_SCANNING|VULN|INTERACTION|SECURITY|LFS|CUSTOM_PROPERT|_VARIABLE|ENVIRONMENT|DEPLOYMENT_BRANCH_POLICY|AUTHORIZATION/;
const MONEY_ACTIONS =
  /SPONSOR|CODESPACE|PAYMENT|CHARGE|REFUND|INVOICE|PAYOUT|PURCHASE|ORDER|BILLING|CHECKOUT|PRICE|DONAT/;
const IRREVERSIBLE_ACTIONS =
  /PURGE|WIPE|RESET|REVOKE|CANCEL|EMPTY|FORCE|DESTROY|TERMINATE|PERMANENT|^GITHUB_UPDATE_A_REFERENCE$/;
const DELETE_ACTIONS = /DELETE|REMOVE|(?<!UN)TRASH|(?<!UN)ARCHIVE|_LEAVE(?:_|$)|CLOSE_DM/;
// Reviewed catalog exception: removing paragraph bullets changes formatting only.
// It still needs a clean write verdict; this never promotes destructive hints.
const FORMATTING_ONLY_ACTIONS = new Set(['GOOGLEDOCS_DELETE_PARAGRAPH_BULLETS']);
const DELETE_COMPATIBLE_HINTS = new Set(['destructiveHint', 'idempotentHint', 'openWorldHint']);

/**
 * Whether a name matches an account-reach family. Callers preserve read verdicts.
 *
 * @param slug - Composio's action slug.
 * @internal Also exposed to pin catalogs with no reach actions.
 */
export function isAccountReachAction(slug: string): boolean {
  return (
    ACCOUNT_REACH_ACTIONS.has(slug) ||
    [
      MAIL_REACH,
      LIVE_CONNECTION_REACH,
      SHARING_REACH,
      CREDENTIAL_REACH,
      PEOPLE_REACH,
      SECURITY_CONTROLS,
    ].some((pattern) => pattern.test(slug))
  );
}

function hasOnlyDeleteHints(tags: readonly string[]): boolean {
  const hints = tags.filter((tag) => HINT_TAG.test(tag));
  return (
    hints.includes('destructiveHint') && hints.every((hint) => DELETE_COMPATIBLE_HINTS.has(hint))
  );
}

/**
 * Classify a Composio action for any app, then tighten write verdicts by name.
 * Reads stay reads. Reach, money and irreversible writes stay explicit.
 * Only the delete decision can admit a destructive verdict: a named delete
 * with solely destructive/idempotent/open-world hints, when enabled. Reviewed
 * permanent deletes, whole-container deletes and updates hiding an archive or
 * permanent data loss remain explicit with either setting.
 *
 * @param slug - Composio's action slug.
 * @param tags - Tags exactly as Composio listed them.
 * @param options - Inject the delete decision for tests; production uses the constant.
 */
export function classifyComposioAction(
  slug: string,
  tags: readonly string[],
  options: { writeIncludesDeletes?: boolean } = {}
): ConnectorOperationClassification {
  const classification = classifyComposioTags(tags);
  if (classification === 'read') return classification;
  if (
    isAccountReachAction(slug) ||
    MONEY_ACTIONS.test(slug) ||
    IRREVERSIBLE_ACTIONS.test(slug) ||
    ALWAYS_EXPLICIT_DELETES.has(slug)
  ) {
    return 'destructive';
  }
  if (DELETE_ACTIONS.test(slug) && !FORMATTING_ONLY_ACTIONS.has(slug)) {
    const includesDeletes = options.writeIncludesDeletes ?? WRITE_INCLUDES_DELETES;
    return includesDeletes && (classification === 'write' || hasOnlyDeleteHints(tags))
      ? 'write'
      : 'destructive';
  }
  return classification;
}
