/**
 * The registry entries a domain declares beside its own code, gathered in one
 * place so the registry spreads one set and names one payload type.
 *
 * @module services/notifications/domain-notification-entries
 */
import {
  CONNECTOR_HOLD_ENTRIES,
  type ConnectorHoldPayloads,
} from './connector-hold-notifications.js';
import { DOC_COMMENT_ENTRIES, type DocCommentPayloads } from './doc-comment-notifications.js';

/** Every domain-declared kind's payload. */
export interface DomainPayloads extends ConnectorHoldPayloads, DocCommentPayloads {}

/** Every domain-declared entry. */
export const DOMAIN_ENTRIES = { ...CONNECTOR_HOLD_ENTRIES, ...DOC_COMMENT_ENTRIES };
