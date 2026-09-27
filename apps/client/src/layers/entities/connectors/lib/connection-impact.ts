/**
 * What taking a way to reach apps away would do to those apps — the list every
 * destructive confirm in this area shows (remove a key, change a key, unlink
 * the DorkOS account), so each one names the same apps the same way.
 *
 * @module entities/connectors/lib/connection-impact
 */
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { serviceName } from './access-copy';

/** One connected app, as a confirmation lists it. */
export interface ImpactApp {
  /** Stable connection id. */
  connectionId: string;
  /** "Gmail (work)": the service name with the account's label. */
  name: string;
  /** How many agents may use this app today by name. */
  agentCount: number;
  /** Whether every agent may use it, including agents added later (DOR-2420). */
  everyAgent: boolean;
  /** Whether the app is switched on. A paused app is not in use either way. */
  active: boolean;
}

/**
 * Turn one connection into the line a confirmation lists for it.
 *
 * @param connection - The connection summary.
 */
export function toImpactApp(connection: ConnectorConnectionSummary): ImpactApp {
  return {
    connectionId: connection.connectionId,
    name: `${serviceName(connection.toolkit)} (${connection.label})`,
    agentCount: connection.agentCount,
    everyAgent: connection.everyAgent !== null,
    active: connection.lifecycle === 'connected',
  };
}

/**
 * The live apps that run through the DorkOS account (paid through it).
 * Disconnected apps count nowhere: taking a way away stops nothing for them.
 *
 * @param connections - Every connection the owner can see.
 */
export function dorkosAccountApps(connections: readonly ConnectorConnectionSummary[]): ImpactApp[] {
  return connections
    .filter(
      (connection) => connection.lifecycle !== 'disconnected' && connection.mode === 'managed'
    )
    .map(toImpactApp);
}

/**
 * Split a way's apps by what taking the way away would do to them: the ones
 * working now stop; the rest (paused, or on a way that already isn't working)
 * can't be used now either way, so counting them as "will stop" would overstate
 * the loss.
 *
 * @param apps - The way's apps.
 * @param wayWorking - Whether the way itself works right now.
 */
export function splitByImpact(
  apps: readonly ImpactApp[],
  wayWorking: boolean
): { stopping: ImpactApp[]; idle: ImpactApp[] } {
  if (!wayWorking) return { stopping: [], idle: [...apps] };
  return {
    stopping: apps.filter((app) => app.active),
    idle: apps.filter((app) => !app.active),
  };
}

/**
 * "1 app" / "4 apps".
 *
 * @param count - How many apps.
 */
export function appCount(count: number): string {
  return `${count} ${count === 1 ? 'app' : 'apps'}`;
}
