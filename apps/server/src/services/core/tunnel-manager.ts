/**
 * Opt-in ngrok tunnel lifecycle manager (singleton).
 *
 * Wraps `@ngrok/ngrok` SDK with dynamic import for zero cost when disabled.
 * Extends EventEmitter to broadcast `status_change` events for SSE and
 * cross-tab sync. Configured via env vars: `TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`,
 * `TUNNEL_PORT`, `TUNNEL_AUTH`, `TUNNEL_DOMAIN`. Tunnel failure is non-blocking.
 *
 * @module services/tunnel-manager
 */
import { EventEmitter } from 'node:events';
import type { TunnelStatus } from '@dorkos/shared/types';
import { configManager } from './config-manager.js';

/** Configuration for starting an ngrok tunnel. */
export interface TunnelConfig {
  port: number;
  authtoken?: string;
  basicAuth?: string;
  domain?: string;
}

/** Options passed to `ngrok.forward()`. */
interface NgrokForwardOpts {
  addr: number;
  authtoken_from_env?: boolean;
  authtoken?: string;
  basic_auth?: string[];
  domain?: string;
  on_status_change?: (addr: string, status: string) => void;
}

const DEFAULT_STATUS: TunnelStatus = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
  passcodeEnabled: false,
};

/** Singleton manager for ngrok tunnel lifecycle (start, stop, status). */
export class TunnelManager extends EventEmitter {
  private listener: { close(): Promise<void>; url(): string | null } | null = null;
  private _status: TunnelStatus = { ...DEFAULT_STATUS };

  get status(): TunnelStatus {
    const tunnelConfig = configManager.get('tunnel');
    return {
      ...this._status,
      passcodeEnabled: !!(tunnelConfig?.passcodeEnabled && tunnelConfig?.passcodeHash),
    };
  }

  /** Emit status_change to broadcast passcode config changes via SSE. */
  refreshStatus(): void {
    this.emit('status_change', this.status);
  }

  private updateStatus(partial: Partial<TunnelStatus>): void {
    this._status = { ...this._status, ...partial };
    this.emit('status_change', this.status);
  }

  async start(config: TunnelConfig): Promise<string> {
    if (this.listener) throw new Error('Tunnel is already running');

    const ngrok = await import('@ngrok/ngrok');

    const forwardOpts: NgrokForwardOpts = {
      addr: config.port,
      authtoken_from_env: true,
    };

    if (config.authtoken) {
      forwardOpts.authtoken = config.authtoken;
      delete forwardOpts.authtoken_from_env;
    }
    if (config.basicAuth) forwardOpts.basic_auth = [config.basicAuth];
    if (config.domain) forwardOpts.domain = config.domain;

    forwardOpts.on_status_change = (_addr: string, status: string) => {
      if (status === 'connected') {
        this.updateStatus({ connected: true });
      } else if (status === 'closed') {
        this.updateStatus({ connected: false });
      }
    };

    this.listener = await ngrok.forward(forwardOpts);
    const url = this.listener.url() ?? '';

    this.updateStatus({
      enabled: true,
      connected: true,
      url,
      port: config.port,
      startedAt: new Date().toISOString(),
      authEnabled: !!config.basicAuth,
      tokenConfigured: !!config.authtoken,
      domain: config.domain ?? null,
    });
    return url;
  }

  async stop(): Promise<void> {
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
    }
    this.updateStatus({ ...DEFAULT_STATUS });
  }
}

export const tunnelManager = new TunnelManager();
