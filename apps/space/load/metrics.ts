/** One `/metrics` scrape: the raw Prometheus text, and a few figures pulled out of it. */
export interface MetricsSnapshot {
  raw: string;
  openStreams: number | null;
  refusedHost: number | null;
  refusedCommunity: number | null;
  refusedMember: number | null;
  postsPerMinute: number | null;
  listenerReconnects: number | null;
  poolWaiting: number | null;
  /** The server's own delivery-lag histogram count and sum (seconds), for a cross-check. */
  serverLagCount: number | null;
  serverLagSumSeconds: number | null;
}

/** The first sample matching `name` (optionally with a label set), or `null` if it is absent. */
function sample(text: string, name: string, labelFragment = ''): number | null {
  const pattern = new RegExp(
    `^${name}${labelFragment ? `\\{[^}]*${labelFragment}[^}]*\\}` : ''}\\s+([0-9.eE+-]+)$`,
    'm'
  );
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
}

/** Parse the handful of figures the load report cares about out of a `/metrics` scrape. */
export function parseMetrics(raw: string): MetricsSnapshot {
  return {
    raw,
    openStreams: sample(raw, 'community_live_streams'),
    refusedHost: sample(raw, 'community_live_streams_refused_total', 'limit="host"'),
    refusedCommunity: sample(raw, 'community_live_streams_refused_total', 'limit="community"'),
    refusedMember: sample(raw, 'community_live_streams_refused_total', 'limit="member"'),
    postsPerMinute: sample(raw, 'community_posts_per_minute'),
    listenerReconnects: sample(raw, 'community_live_listener_reconnects_total'),
    poolWaiting: sample(raw, 'community_db_pool_waiting'),
    serverLagCount: sample(raw, 'community_live_delivery_lag_seconds_count'),
    serverLagSumSeconds: sample(raw, 'community_live_delivery_lag_seconds_sum'),
  };
}

/** Scrape `/metrics` with the host API key the fixture minted. */
export async function fetchMetrics(
  url: string,
  metricsKey: string,
  timeoutMs = 10_000
): Promise<MetricsSnapshot> {
  const response = await fetch(`${url}/metrics`, {
    headers: { authorization: `Bearer ${metricsKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GET /metrics returned ${response.status}`);
  return parseMetrics(await response.text());
}
