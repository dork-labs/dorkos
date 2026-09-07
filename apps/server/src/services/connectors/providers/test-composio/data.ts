/** Synthetic values for the offline browser service; none are real credentials. */
export const COMPOSIO_FIXTURE_KEY = 'dorkos-offline-composio-project-key';
/** Entered through the real owner source form, never read from the credential store. */
export const COMPOSIO_FIXTURE_WEBHOOK_SECRET = 'whsec_dorkos_offline_browser_fixture';
/** Fixed server-owned account namespace exercised by the production factory. */
export const COMPOSIO_FIXTURE_USER = 'dorkos-operator';
/** Concrete immutable fixture toolkit version. */
export const COMPOSIO_FIXTURE_VERSION = '20260901_00';
/** Exact event slugs available to the browser fixture. */
export const COMPOSIO_FIXTURE_EVENTS = [
  'GMAIL_NEW_MESSAGE',
  'GMAIL_UNKNOWN_TIMING',
  'GMAIL_UNSUPPORTED_FILTER',
] as const;

/** Vendor DTOs consumed by the installed SDK, including intentionally unknown timing. */
export function fixtureDefinitions() {
  return COMPOSIO_FIXTURE_EVENTS.map((slug, index) => ({
    slug,
    name: ['New message', 'Message with unknown timing', 'Message with unsupported filter'][index],
    description: 'An offline test email',
    toolkit: { slug: 'gmail', name: 'Gmail', logo: '' },
    version: COMPOSIO_FIXTURE_VERSION,
    config:
      index === 2
        ? { type: 'object', patternProperties: { '.*': { type: 'string' } } }
        : {
            type: 'object',
            properties: { label: { type: 'string' } },
            additionalProperties: false,
          },
    payload: { type: 'object', properties: { subject: { type: 'string' } } },
    ...(index !== 1 && { type: 'webhook' }),
  }));
}

/** Exact read-operation metadata used by owner review and the real SDK execution preflight. */
export function fixtureOperation() {
  return {
    slug: 'GMAIL_FETCH_EMAILS',
    name: 'Fetch emails',
    description: 'Read offline test messages',
    human_description: 'Read offline test messages',
    version: COMPOSIO_FIXTURE_VERSION,
    available_versions: [COMPOSIO_FIXTURE_VERSION],
    toolkit: { slug: 'gmail', name: 'Gmail', logo: '' },
    tags: ['readOnlyHint'],
    input_parameters: { type: 'object', properties: {}, additionalProperties: false },
    output_parameters: { type: 'object' },
    no_auth: false,
    is_deprecated: false,
    scopes: [],
    scope_requirements: { all_of: [] },
    deprecated: {
      available_versions: [COMPOSIO_FIXTURE_VERSION],
      display_name: 'Fetch emails',
      is_deprecated: false,
      toolkit: { logo: '' },
      version: COMPOSIO_FIXTURE_VERSION,
    },
  };
}
