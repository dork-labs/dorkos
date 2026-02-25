/**
 * Opt-in ngrok tunnel lifecycle manager (singleton).
 *
 * Wraps `@ngrok/ngrok` SDK with dynamic import for zero cost when disabled.
 * Configured via env vars: `TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`, `TUNNEL_PORT`,
 * `TUNNEL_AUTH`, `TUNNEL_DOMAIN`. Tunnel failure is non-blocking.
 *
 * @module services/tunnel-manager
 */

/** Configuration for starting an ngrok tunnel. */
export interface TunnelConfig {
  port: number;
  authtoken?: string;
  basicAuth?: string;
  domain?: string;
}

export interface TunnelStatus {
  enabled: boolean;
  connected: boolean;
  url: string | null;
  port: number | null;
  startedAt: string | null;
}

/** Singleton manager for ngrok tunnel lifecycle (start, stop, status). */
export class TunnelManager {
  private listener: { close(): Promise<void>; url(): string | null } | null = null;
  private _status: TunnelStatus = {
    enabled: false,
    connected: false,
    url: null,
    port: null,
    startedAt: null,
  };

  get status(): TunnelStatus {
    return { ...this._status };
  }

  async start(config: TunnelConfig): Promise<string> {
    if (this.listener) throw new Error('Tunnel is already running');

    const ngrok = await import('@ngrok/ngrok');

    const forwardOpts: Record<string, unknown> = {
      addr: config.port,
      authtoken_from_env: true,
    };

    if (config.authtoken) {
      forwardOpts.authtoken = config.authtoken;
      delete forwardOpts.authtoken_from_env;
    }
    if (config.basicAuth) forwardOpts.basic_auth = [config.basicAuth];
    if (config.domain) forwardOpts.domain = config.domain;

    this.listener = await ngrok.forward(forwardOpts);
    const url = this.listener.url() ?? '';

    this._status = {
      enabled: true,
      connected: true,
      url,
      port: config.port,
      startedAt: new Date().toISOString(),
    };
    return url;
  }

  async stop(): Promise<void> {
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
    }
    this._status = {
      enabled: this._status.enabled,
      connected: false,
      url: null,
      port: this._status.port,
      startedAt: this._status.startedAt,
    };
  }
}

export const tunnelManager = new TunnelManager();
