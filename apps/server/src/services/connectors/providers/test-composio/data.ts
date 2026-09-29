/** Synthetic values for the offline browser service; none are real credentials. */
export const COMPOSIO_FIXTURE_KEY = 'dorkos-offline-composio-project-key';
/** Entered through the real owner source form, never read from the credential store. */
export const COMPOSIO_FIXTURE_WEBHOOK_SECRET = 'whsec_dorkos_offline_browser_fixture';
/** Fixed server-owned account namespace exercised by the production factory. */
export const COMPOSIO_FIXTURE_USER = 'dorkos-operator';
/** Concrete immutable fixture toolkit version. */
export const COMPOSIO_FIXTURE_VERSION = '20260901_00';
/**
 * Gmail's logo address in Composio's live toolkit list (`meta.logo`), real
 * shape. The browser never asks for it: Gmail shows its bundled mark first.
 */
export const COMPOSIO_FIXTURE_LOGO = 'https://logos.composio.dev/api/gmail';
/** Gmail's description in Composio's live toolkit list (`meta.description`), verbatim. */
export const COMPOSIO_FIXTURE_DESCRIPTION =
  'Gmail is Google’s email service, featuring spam protection, search functions, and seamless integration with other G Suite apps for productivity';
/** Exact event slugs available to the browser fixture. */
export const COMPOSIO_FIXTURE_EVENTS = [
  'GMAIL_NEW_MESSAGE',
  'GMAIL_UNKNOWN_TIMING',
  'GMAIL_UNSUPPORTED_FILTER',
  'GMAIL_NEW_GMAIL_MESSAGE',
] as const;

function fixtureFilterSchema(index: number) {
  if (index === 3) {
    // Observed Gmail shape only; values are synthetic, not captured defaults
    // or a promise about actual polling cadence.
    return {
      type: 'object',
      properties: {
        interval: { type: 'number', title: 'Interval', default: 1.5 },
        labelIds: {
          type: 'string',
          title: 'Labels',
          default: 'INBOX',
          examples: ['SENT', 'STARRED', 'DRAFT'],
        },
        query: {
          type: 'string',
          title: 'Query',
          default: '',
          examples: ['is:unread', 'has:attachment', 'from:sender@example.test'],
        },
        userId: {
          type: 'string',
          title: 'User',
          default: 'me',
          examples: ['reader@example.test'],
        },
      },
    };
  }
  if (index === 2) return { type: 'object', patternProperties: { '.*': { type: 'string' } } };
  return { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false };
}

/** Vendor DTOs consumed by the installed SDK, including intentionally unknown timing. */
export function fixtureDefinitions() {
  return COMPOSIO_FIXTURE_EVENTS.map((slug, index) => ({
    slug,
    name: [
      'New message',
      'Message with unknown timing',
      'Message with unsupported filter',
      'New Gmail message',
    ][index],
    description: 'An offline test email',
    toolkit: { slug: 'gmail', name: 'Gmail', logo: '' },
    version: COMPOSIO_FIXTURE_VERSION,
    config: fixtureFilterSchema(index),
    payload: { type: 'object', properties: { subject: { type: 'string' } } },
    ...(index !== 1 && { type: index === 3 ? 'poll' : 'webhook' }),
  }));
}

/** One Composio tool DTO in the installed SDK's shape. */
function fixtureTool(slug: string, name: string, description: string, tags: string[]) {
  return {
    slug,
    name,
    description,
    human_description: description,
    version: COMPOSIO_FIXTURE_VERSION,
    available_versions: [COMPOSIO_FIXTURE_VERSION],
    toolkit: { slug: 'gmail', name: 'Gmail', logo: '' },
    tags,
    input_parameters: { type: 'object', properties: {}, additionalProperties: false },
    output_parameters: { type: 'object' },
    no_auth: false,
    is_deprecated: false,
    scopes: [],
    scope_requirements: { all_of: [] },
    deprecated: {
      available_versions: [COMPOSIO_FIXTURE_VERSION],
      display_name: name,
      is_deprecated: false,
      toolkit: { logo: '' },
      version: COMPOSIO_FIXTURE_VERSION,
    },
  };
}

/** Exact read-operation metadata used by owner review and the real SDK execution preflight. */
export function fixtureOperation() {
  return fixtureTool('GMAIL_FETCH_EMAILS', 'Fetch emails', 'Read offline test messages', [
    'readOnlyHint',
  ]);
}

/**
 * The whole offline Gmail action list, one per Composio verdict, with the tag
 * shapes Composio uses: reading, sending (`createHint`, so "Read and write"),
 * and deleting (`destructiveHint`, so no level). Only reading can run offline.
 */
export function fixtureOperations() {
  return [
    fixtureOperation(),
    fixtureTool('GMAIL_SEND_EMAIL', 'Send email', 'Send an offline test message', [
      'important',
      'openWorldHint',
      'createHint',
    ]),
    fixtureTool('GMAIL_DELETE_MESSAGE', 'Delete message', 'Delete an offline test message', [
      'destructiveHint',
    ]),
  ];
}
