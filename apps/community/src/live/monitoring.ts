import type { Hono } from 'hono';
import { Client, type Pool } from 'pg';
import type { HostAuthority } from '../host/authority.js';
import type { LiveHub } from './hub.js';

/** How long the readiness probe waits for its database round trip. */
const READY_DATABASE_MS = 2_000;

/** Escape a Prometheus label value. */
function label(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/** Render the hub and pool figures as Prometheus text exposition format 0.0.4. */
export function renderMetrics(hub: LiveHub, pool: Pool): string {
  const figures = hub.snapshot();
  const lines: string[] = [];
  const metric = (
    name: string,
    type: 'gauge' | 'counter' | 'histogram',
    help: string,
    samples: Array<[string, number]>
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [suffix, value] of samples) lines.push(`${name}${suffix} ${value}`);
  };
  metric('community_live_streams', 'gauge', 'Live channel streams open on this server.', [
    ['', figures.streams],
  ]);
  metric(
    'community_live_streams_by_community',
    'gauge',
    'Live channel streams open on this server, by community.',
    figures.perCommunity.map(({ communityId, streams }) => [
      `{community_id="${label(communityId)}"}`,
      streams,
    ])
  );
  metric(
    'community_live_streams_refused_total',
    'counter',
    'Live streams refused with 503, by the limit that refused them.',
    [
      ['{limit="host"}', figures.refused.host],
      ['{limit="community"}', figures.refused.community],
      ['{limit="member"}', figures.refused.member],
    ]
  );
  metric('community_posts_per_minute', 'gauge', 'Messages posted in the last minute.', [
    ['', figures.postsPerMinute],
  ]);
  metric('community_joins_per_minute', 'gauge', 'People who joined a space in the last minute.', [
    ['', figures.joinsPerMinute],
  ]);
  metric(
    'community_db_pool_waiting',
    'gauge',
    'Requests waiting for a database connection right now.',
    [['', pool.waitingCount]]
  );
  metric('community_db_pool_connections', 'gauge', 'Database connections the pool holds.', [
    ['{state="total"}', pool.totalCount],
    ['{state="idle"}', pool.idleCount],
  ]);
  metric(
    'community_live_listener_up',
    'gauge',
    '1 while the live-notice listener is connected and listening.',
    [['', figures.listenerUp ? 1 : 0]]
  );
  metric(
    'community_live_listener_reconnects_total',
    'counter',
    'Times the live-notice listener reconnected after its connection dropped.',
    [['', figures.listenerReconnects]]
  );
  metric(
    'community_live_delivery_lag_seconds',
    'histogram',
    'Time from a message being written to a live stream sending it.',
    [
      ...figures.lag.buckets.map(
        ({ le, count }) => [`_bucket{le="${le}"}`, count] as [string, number]
      ),
      ['_bucket{le="+Inf"}', figures.lag.count],
      ['_sum', figures.lag.sum],
      ['_count', figures.lag.count],
    ]
  );
  return `${lines.join('\n')}\n`;
}

/**
 * One database round trip that never queues behind the request pool, so a storm of live-stream
 * rechecks cannot fail readiness. It uses the listen connection when that is up, and otherwise a
 * short-lived connection of its own.
 */
async function databaseAnswers(hub: LiveHub, databaseUrl: string): Promise<boolean> {
  if (hub.listenerState === 'listening') return hub.ping();
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: READY_DATABASE_MS,
    query_timeout: READY_DATABASE_MS,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Register `/health/ready` and `/metrics`. `/health` stays a pure liveness probe elsewhere.
 *
 * Readiness needs a database round trip and, once the server pinned it at boot, a listening
 * live-notice connection. Metrics need host authority with `communities:read`: they name
 * communities by id, which is what that scope already lists.
 */
export function registerMonitoringRoutes(
  app: Hono,
  {
    pool,
    hub,
    authority,
    databaseUrl,
  }: { pool: Pool; hub: LiveHub; authority: HostAuthority; databaseUrl: string }
): void {
  app.get('/health/ready', async (c) => {
    const database = (await databaseAnswers(hub, databaseUrl)) ? 'ok' : 'unavailable';
    const listener = hub.listenerState;
    const ready = database === 'ok' && (listener === 'listening' || !hub.listenerRequired);
    c.header('Cache-Control', 'no-store');
    return c.json({ status: ready ? 'ok' : 'unavailable', database, listener }, ready ? 200 : 503);
  });
  app.get('/metrics', async (c) => {
    await authority.require(c, 'communities:read');
    c.header('Cache-Control', 'no-store');
    return c.body(renderMetrics(hub, pool), 200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });
}
