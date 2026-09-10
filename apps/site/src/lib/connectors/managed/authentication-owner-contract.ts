/** Internal seams between the hosted owner page and authentication service. */
import type { ComposioAuthenticationDescriptor } from '@dorkos/connector-providers/composio';
import type { ManagedConnectorDatabase } from './authority-service';

/** Hosted-only field page; OAuth keeps its existing callback endpoint. */
export const MANAGED_AUTHENTICATION_FIELDS_PATH = '/connectors/managed/fields';
/** Same-origin credential POST; never exposed by a local transport. */
export const MANAGED_AUTHENTICATION_FIELDS_SUBMIT_PATH = '/api/connectors/managed/credentials';
/** Separate opaque field-flow cookie; OAuth callback cookie scope is unchanged. */
export const MANAGED_AUTHENTICATION_FIELDS_COOKIE = 'dorkos_managed_account_fields';

/** Credential-free server-rendered page data after an owner has bound a field flow. */
export interface ManagedAuthenticationFieldsPage {
  kind: 'fields' | 'none';
  descriptor: ComposioAuthenticationDescriptor;
  descriptorDigest: string;
  csrfToken: string;
}

/** Server-only resolved authorization page; credential fields never enter local transports. */
export type ManagedAuthenticationOwnerPage =
  | { kind: 'oauth'; redirectUrl: string; cookieValue: string; cookieMaxAgeSeconds: number }
  | (ManagedAuthenticationFieldsPage & { cookieValue: string; cookieMaxAgeSeconds: number });

/** Trusted session identity plus untrusted flow selectors, validated by the service. */
export interface ManagedAuthenticationOwnerPageInput {
  ownerId: string;
  flowId: string;
  nonce: string;
  signal: AbortSignal;
}

/** Same-origin POST inputs; ownerId/origin are supplied by the authenticated route, not JSON. */
export interface ManagedAuthenticationFieldsInput {
  ownerId: string;
  cookieValue: string;
  requestOrigin: string;
  expectedOrigin: string;
  csrfToken: string;
  descriptorDigest: string;
  fields: unknown;
  signal: AbortSignal;
}

/** Track A supplies these services; Track B only renders and submits on dorkos.ai. */
export interface ManagedAuthenticationOwnerService {
  authorize(
    input: ManagedAuthenticationOwnerPageInput
  ): Promise<ManagedAuthenticationOwnerPage | null>;
  /** Revalidate the exact bound owner/flow/material before rendering; OAuth rows return null. */
  readFieldsPage(input: {
    ownerId: string;
    cookieValue: string;
    signal: AbortSignal;
  }): Promise<ManagedAuthenticationFieldsPage | null>;
  completeFields(input: ManagedAuthenticationFieldsInput): Promise<{ connectionId: string }>;
}

/** Track A exports createManagedAuthenticationOwnerService with this factory signature. */
export type ManagedAuthenticationOwnerServiceFactory = (
  db: ManagedConnectorDatabase
) => ManagedAuthenticationOwnerService;
