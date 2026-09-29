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
  /**
   * Whether agents can use it right now (the server's readiness). An app that
   * is paused, signed out or already cut off loses nothing more.
   */
  usable: boolean;
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
    usable: connection.readiness.state === 'ready',
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
    .filter((connection) => connection.readiness.state !== 'gone' && connection.mode === 'managed')
    .map(toImpactApp);
}

/**
 * Split a way's apps by what taking the way away would do to them: the ones
 * agents can use now stop; the rest (paused, signed out, or on a way that
 * already isn't working, as the server's readiness says) can't be used now
 * either way, so counting them as "will stop" would overstate the loss.
 *
 * @param apps - The way's apps.
 */
export function splitByImpact(apps: readonly ImpactApp[]): {
  stopping: ImpactApp[];
  idle: ImpactApp[];
} {
  return {
    stopping: apps.filter((app) => app.usable),
    idle: apps.filter((app) => !app.usable),
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
