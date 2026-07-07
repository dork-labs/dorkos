/**
 * Pure command logic for the `dorkos cloud` subcommands (accounts-and-auth P2,
 * task 2.4).
 *
 * These functions orchestrate the headless device-link flow — request a code,
 * show it, poll to approval/denial/expiry, and persist the issued instance key
 * via the config layer — without importing the server device-flow client or the
 * config manager directly. Both the flow client and the config store are
 * injected, so tests exercise the full login/logout/status flows against fakes
 * with no real network and no hanging prompts (non-TTY safe). The token value is
 * never logged.
 *
 * The concrete server client is wired in by `cloud-dispatcher.ts`, which is the
 * only file in this package that reaches into `apps/server`.
 *
 * @module commands/cloud-commands
 */
import type { ConfigStore } from '../config-commands.js';

/** This instance's display metadata carried through the device-link flow. */
export interface InstanceDescriptor {
  name: string;
  platform: string;
  dorkosVersion: string;
}

/** The `POST /api/auth/device/code` success body (RFC 8628). */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Terminal outcome of the device-token poll loop. */
export type PollResult =
  | { status: 'approved'; accessToken: string }
  | { status: 'denied' }
  | { status: 'expired' };

/** Outcome of a single heartbeat call. */
export type HeartbeatResult =
  | { ok: true; instanceId: string; lastSeenAt: string }
  | { ok: false; unauthorized: true }
  | { ok: false; unauthorized: false; error: string };

/**
 * The injected device-flow client. The server's `cloud-link-client.ts` functions
 * satisfy this shape structurally (their extra optional `fetchImpl`/`sleep`/`now`
 * params are erased by the narrower signature here).
 */
export interface CloudFlowClient {
  resolveCloudBaseUrl(): string;
  buildInstanceDescriptor(): InstanceDescriptor;
  requestDeviceCode(opts: {
    baseUrl: string;
    descriptor: InstanceDescriptor;
  }): Promise<DeviceCodeResponse>;
  pollForToken(opts: {
    baseUrl: string;
    deviceCode: string;
    interval: number;
    expiresIn: number;
  }): Promise<PollResult>;
  sendHeartbeat(opts: {
    baseUrl: string;
    accessToken: string;
    descriptor: InstanceDescriptor;
  }): Promise<HeartbeatResult>;
  revokeInstanceKey(opts: { baseUrl: string; accessToken: string }): Promise<boolean>;
}

/** Command output routed to the console (injectable for tests). */
export interface CommandIO {
  log(message: string): void;
  error(message: string): void;
}

/** The runtime context the `dorkos cloud` command functions operate on. */
export interface CloudCommandDeps {
  client: CloudFlowClient;
  configStore: ConfigStore;
  io: CommandIO;
  /** Opens a URL in the user's browser; defaulted to a no-op when omitted. */
  openUrl?: (url: string) => void;
  /** Whether a TTY is attached; controls whether the browser is auto-opened. */
  isTty?: boolean;
}

/**
 * `dorkos cloud login` — run the device flow directly against the cloud (no
 * running server needed), print the user code + verification URL, poll to a
 * terminal state, and persist the issued instance key.
 *
 * @param deps - Injected flow client, config store, IO, and TTY/browser hooks.
 * @returns Process exit code (`0` linked, `1` denied/expired).
 */
export async function runCloudLogin(deps: CloudCommandDeps): Promise<number> {
  const { client, configStore, io } = deps;
  const openUrl = deps.openUrl ?? (() => {});
  const isTty = deps.isTty ?? false;

  if (configStore.getDot('cloud.instanceToken')) {
    io.log('This instance is already linked. Re-linking will replace the current link.');
  }

  const baseUrl = client.resolveCloudBaseUrl();
  const descriptor = client.buildInstanceDescriptor();
  const codes = await client.requestDeviceCode({ baseUrl, descriptor });

  io.log('');
  io.log('  To link this instance, open this URL and enter the code:');
  io.log(`    ${codes.verification_uri}`);
  io.log('');
  io.log(`    Code:  ${codes.user_code}`);
  io.log('');

  // Open the pre-filled URL for convenience, but only with a TTY. The URL is
  // always printed above, so headless environments are never blocked.
  if (isTty) openUrl(codes.verification_uri_complete);

  io.log('  Waiting for approval...');
  const result = await client.pollForToken({
    baseUrl,
    deviceCode: codes.device_code,
    interval: codes.interval,
    expiresIn: codes.expires_in,
  });

  if (result.status === 'denied') {
    io.error('Link request was denied.');
    return 1;
  }
  if (result.status === 'expired') {
    io.error('Link request expired before approval. Run `dorkos cloud login` to try again.');
    return 1;
  }

  // Persist the scoped instance key via the config layer (sensitive-field path).
  configStore.setDot('cloud.instanceToken', result.accessToken);
  configStore.setDot('cloud.instanceName', descriptor.name);

  // Best-effort registration heartbeat so the instance appears in the account
  // registry immediately. A failure here never undoes the successful link — the
  // server will retry on its next startup/interval.
  const beat = await client.sendHeartbeat({ baseUrl, accessToken: result.accessToken, descriptor });
  if (!beat.ok) {
    io.log('Linked — the first heartbeat has not confirmed yet; it will retry automatically.');
  }

  io.log(`Linked this instance (${descriptor.name}) to your DorkOS account.`);
  return 0;
}

/**
 * `dorkos cloud logout` — best-effort server-side revoke, then clear the local
 * cloud config fields.
 *
 * @param deps - Injected flow client, config store, and IO.
 * @returns Process exit code (`0`).
 */
export async function runCloudLogout(deps: CloudCommandDeps): Promise<number> {
  const { client, configStore, io } = deps;
  const token = configStore.getDot('cloud.instanceToken') as string | null;
  if (!token) {
    io.log('This instance is not linked.');
    return 0;
  }
  await client.revokeInstanceKey({ baseUrl: client.resolveCloudBaseUrl(), accessToken: token });
  configStore.setDot('cloud.instanceToken', null);
  configStore.setDot('cloud.instanceName', null);
  configStore.setDot('cloud.linkedAccountLabel', null);
  io.log('Unlinked this instance from your DorkOS account.');
  return 0;
}

/**
 * `dorkos cloud status` — print the linked account label, instance name, or a
 * "not linked" notice. Reads config only; no network.
 *
 * @param deps - Config store and IO.
 * @returns Process exit code (`0`).
 */
export function runCloudStatus(deps: Pick<CloudCommandDeps, 'configStore' | 'io'>): number {
  const { configStore, io } = deps;
  const token = configStore.getDot('cloud.instanceToken') as string | null;
  if (!token) {
    io.log('Not linked. Run `dorkos cloud login` to link this instance to a DorkOS account.');
    return 0;
  }
  const name = (configStore.getDot('cloud.instanceName') as string | null) ?? 'this instance';
  const label =
    (configStore.getDot('cloud.linkedAccountLabel') as string | null) ?? 'your DorkOS account';
  io.log(`Linked to ${label}`);
  io.log(`  Instance: ${name}`);
  return 0;
}
