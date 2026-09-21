/**
 * Shared validation grammar for non-secret provider identifiers.
 *
 * @module commands/community-deploy/provider-identifiers
 */

/** Provider identifiers accepted in plans, journals, and structured provider readback. */
export const SAFE_PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
