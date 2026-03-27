/** Map common ngrok errors to actionable messages. */
export function friendlyErrorMessage(raw: string): string {
  if (/auth|token|ERR_NGROK_105/i.test(raw)) {
    return 'Check your auth token at dashboard.ngrok.com';
  }
  if (/timeout|ETIMEDOUT/i.test(raw)) {
    return 'Connection timed out. Check your network.';
  }
  if (/limit|ERR_NGROK_108/i.test(raw)) {
    return 'Tunnel limit reached. Free ngrok accounts allow one active tunnel.';
  }
  if (/DNS|NXDOMAIN|ERR_NGROK_332/i.test(raw)) {
    return 'DNS resolution failed. Check your domain configuration.';
  }
  if (/gateway|502|ERR_NGROK_3200/i.test(raw)) {
    return 'Gateway error. The tunnel endpoint is unreachable.';
  }
  if (/upgrade|ERR_NGROK_120/i.test(raw)) {
    return 'Feature requires a paid ngrok plan.';
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return 'Connection refused. Ensure the server is running.';
  }
  return raw;
}

/** Determine quality color from latency. */
export function latencyColor(ms: number | null): string {
  if (ms === null) return 'bg-gray-400';
  if (ms < 200) return 'bg-green-500';
  if (ms < 500) return 'bg-amber-400';
  return 'bg-red-500';
}
