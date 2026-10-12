/** The short names no community may take, kept apart from the admin wire schemas. */
/**
 * Top-level paths the Community server or its browser already owns or may soon own. No
 * community can take one as its short name; a host can add more by configuration.
 */
export const COMMUNITY_RESERVED_SHORT_NAMES: readonly string[] = [
  'api',
  'assets',
  'c',
  'claim',
  'host',
  'join',
  'pairing',
  'health',
  // The host's monitoring scrape.
  'metrics',
  'auth',
  'login',
  'logout',
  'signin',
  'signup',
  'settings',
  'admin',
  'static',
  'public',
  'www',
  'help',
  'docs',
  'status',
  'well-known',
  'favicon',
  'robots',
  'sitemap',
  'new',
  'import',
  'invite',
  'deletion',
  // The owner's link to keep ownership, and the new owner's claim, when a host replaces an owner.
  'keep-ownership',
  'owner-replacement',
  // The pages a mailed reset, sign-in or confirmation link opens.
  'reset-password',
  'email-sign-in',
  'confirm-email',
  // First-host setup is reached through the browser app, and a host would expect the word kept.
  'setup',
  // Pages a host is likely to publish, and words that would let a community pose as the host.
  'terms',
  'privacy',
  'abuse',
  'report',
  'legal',
  'security',
  'account',
  'recovery',
  'oauth',
  'callback',
  'verify',
  'reset',
  'communities',
  'community',
  'support',
  'billing',
  'official',
  'dorkos',
];

/**
 * The built-in reserved names no page or route of the Community server owns: they are reserved
 * only so no community can pose as the host. A host operator may still give one to a space,
 * such as the host's own official space, through the reserved-name creation route; every other
 * built-in name is a path and can never open a space.
 */
export const COMMUNITY_HOST_GRANTABLE_SHORT_NAMES: readonly string[] = [
  'support',
  'billing',
  'official',
  'dorkos',
];

/**
 * The built-in reserved names that are paths: no address under one ever opens a space, so the
 * server and the browser never read one as a short address.
 */
export const COMMUNITY_PATH_SHORT_NAMES: readonly string[] = COMMUNITY_RESERVED_SHORT_NAMES.filter(
  (name) => !COMMUNITY_HOST_GRANTABLE_SHORT_NAMES.includes(name)
);
