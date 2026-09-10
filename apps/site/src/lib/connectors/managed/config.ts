/**
 * Fail-closed deployment configuration for the hosted connector service.
 *
 * @module lib/connectors/managed/config
 */
import { z } from 'zod';

import { env } from '@/env';
import { managedEventProtector } from './event-protection';

const RawManagedConnectorConfigSchema = z
  .object({
    DORKOS_MANAGED_CONNECTORS_ENABLED: z.enum(['0', '1']).default('0'),
    DORKOS_MANAGED_CONNECTORS_LIVE_READY: z.enum(['0', '1']).default('0'),
    DORKOS_MANAGED_CONNECTOR_EVENTS_LIVE_READY: z.enum(['0', '1']).default('0'),
    DORKOS_MANAGED_CONNECTOR_EVENT_PAYLOAD_KEYS: z.string().optional(),
    DORKOS_MANAGED_COMPOSIO_PROJECT_KEY: z.string().min(1).optional(),
    DORKOS_MANAGED_COMPOSIO_API_ORIGIN: z.string().url().optional(),
    DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN: z.string().url().optional(),
    DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS: z.string().default('{}'),
    DORKOS_MANAGED_CONNECTOR_WEBHOOK_SECRET: z.string().min(16).optional(),
  })
  .passthrough();

const AuthConfigMapSchema = z.record(z.string().min(1).max(200), z.string().min(1).max(500));

/** Parsed server-only hosted connector configuration. */
export interface ManagedConnectorConfig {
  enabled: boolean;
  liveReady: boolean;
  eventsLiveReady?: boolean;
  eventPayloadProtectionReady?: boolean;
  projectApiKey?: string;
  apiOrigin?: string;
  callbackOrigin?: string;
  authConfigByToolkit: Record<string, string>;
  webhookSecret?: string;
}

/** Plain availability result for one managed capability. */
export type ManagedConnectorCapabilityAvailability =
  { status: 'available' } | { status: 'unavailable'; reason: string };

/** Safe configuration error whose message never contains parsed secret values. */
export class ManagedConnectorConfigError extends Error {
  constructor() {
    super('Managed connector configuration is invalid.');
    this.name = 'ManagedConnectorConfigError';
  }
}

function deploymentConfigSource(): Record<string, string | undefined> {
  return {
    DORKOS_MANAGED_CONNECTORS_ENABLED: env.DORKOS_MANAGED_CONNECTORS_ENABLED,
    DORKOS_MANAGED_CONNECTORS_LIVE_READY: env.DORKOS_MANAGED_CONNECTORS_LIVE_READY,
    DORKOS_MANAGED_CONNECTOR_EVENTS_LIVE_READY: env.DORKOS_MANAGED_CONNECTOR_EVENTS_LIVE_READY,
    DORKOS_MANAGED_CONNECTOR_EVENT_PAYLOAD_KEYS: env.DORKOS_MANAGED_CONNECTOR_EVENT_PAYLOAD_KEYS,
    DORKOS_MANAGED_COMPOSIO_PROJECT_KEY: env.DORKOS_MANAGED_COMPOSIO_PROJECT_KEY,
    DORKOS_MANAGED_COMPOSIO_API_ORIGIN: env.DORKOS_MANAGED_COMPOSIO_API_ORIGIN,
    DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN: env.DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN,
    DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS: env.DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS,
    DORKOS_MANAGED_CONNECTOR_WEBHOOK_SECRET: env.DORKOS_MANAGED_CONNECTOR_WEBHOOK_SECRET,
  };
}

/** Parse server-only deployment values without exposing them to a public DTO. */
export function readManagedConnectorConfig(
  source: Record<string, string | undefined> = deploymentConfigSource()
): ManagedConnectorConfig {
  const parsed = RawManagedConnectorConfigSchema.safeParse(source);
  if (!parsed.success) throw new ManagedConnectorConfigError();
  const raw = parsed.data;
  let authConfigValue: unknown;
  try {
    authConfigValue = JSON.parse(raw.DORKOS_MANAGED_CONNECTOR_AUTH_CONFIGS);
  } catch {
    authConfigValue = null;
  }
  const authConfigByToolkit = AuthConfigMapSchema.safeParse(authConfigValue);
  if (!authConfigByToolkit.success) {
    throw new ManagedConnectorConfigError();
  }
  let callbackOrigin: string | undefined;
  if (raw.DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN) {
    const callback = new URL(raw.DORKOS_MANAGED_CONNECTOR_CALLBACK_ORIGIN);
    if (
      (callback.protocol !== 'https:' &&
        callback.hostname !== 'localhost' &&
        callback.hostname !== '127.0.0.1') ||
      callback.username !== '' ||
      callback.password !== '' ||
      callback.pathname !== '/' ||
      callback.search !== '' ||
      callback.hash !== ''
    ) {
      throw new ManagedConnectorConfigError();
    }
    callbackOrigin = callback.origin;
  }
  return {
    enabled: raw.DORKOS_MANAGED_CONNECTORS_ENABLED === '1',
    liveReady: raw.DORKOS_MANAGED_CONNECTORS_LIVE_READY === '1',
    eventsLiveReady: raw.DORKOS_MANAGED_CONNECTOR_EVENTS_LIVE_READY === '1',
    eventPayloadProtectionReady: Boolean(
      raw.DORKOS_MANAGED_CONNECTOR_EVENT_PAYLOAD_KEYS &&
      managedEventProtector(raw.DORKOS_MANAGED_CONNECTOR_EVENT_PAYLOAD_KEYS)
    ),
    ...(raw.DORKOS_MANAGED_COMPOSIO_PROJECT_KEY && {
      projectApiKey: raw.DORKOS_MANAGED_COMPOSIO_PROJECT_KEY,
    }),
    ...(raw.DORKOS_MANAGED_COMPOSIO_API_ORIGIN && {
      apiOrigin: raw.DORKOS_MANAGED_COMPOSIO_API_ORIGIN,
    }),
    ...(callbackOrigin && { callbackOrigin }),
    authConfigByToolkit: authConfigByToolkit.data,
    ...(raw.DORKOS_MANAGED_CONNECTOR_WEBHOOK_SECRET && {
      webhookSecret: raw.DORKOS_MANAGED_CONNECTOR_WEBHOOK_SECRET,
    }),
  };
}

/** Report availability for one capability without weakening unrelated ones. */
export function managedCapabilityAvailability(
  config: ManagedConnectorConfig,
  capability: 'catalog' | 'authentication' | 'execution' | 'events',
  toolkit?: string
): ManagedConnectorCapabilityAvailability {
  if (!config.enabled) {
    return { status: 'unavailable', reason: 'Managed connections are not enabled here.' };
  }
  if (!config.liveReady) {
    return {
      status: 'unavailable',
      reason: 'Managed connections are awaiting production verification.',
    };
  }
  if (!config.projectApiKey) {
    return { status: 'unavailable', reason: 'Managed connections are not configured yet.' };
  }
  if (capability === 'authentication') {
    if (!config.callbackOrigin) {
      return { status: 'unavailable', reason: 'Managed account sign-in is not configured yet.' };
    }
    if (!toolkit) {
      return {
        status: 'unavailable',
        reason: 'Choose a service before connecting an account.',
      };
    }
  }
  if (capability === 'events') {
    if (!config.eventsLiveReady)
      return {
        status: 'unavailable',
        reason: 'Managed account events are awaiting production verification.',
      };
    if (!config.webhookSecret || !config.eventPayloadProtectionReady)
      return { status: 'unavailable', reason: 'Managed account events are not configured yet.' };
  }
  return { status: 'available' };
}
