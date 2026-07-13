/**
 * Anonymous daily heartbeat reporter (DOR-293; Tier 1 opt-out per ADR
 * 260713-143958).
 *
 * Sends one small, anonymous JSON ping to dorkos.ai roughly once a day so the
 * project can count "known daily-active instances". It is a Tier 1 opt-out
 * channel: `config.telemetry.heartbeat` defaults to `true`, but the caller must
 * still fold in the notice-before-first-send gate (`hasTier1SendGate`) so a
 * never-answered install sends nothing until its first-run notice has been
 * shown. When `consent` is false — because the user turned it off, an env kill
 * switch is set, or the notice has not yet been shown — no network call, timer,
 * or disk read happens.
 *
 * What the payload contains is documented verbatim at
 * https://dorkos.ai/telemetry and in `docs/self-hosting/telemetry.mdx`. It
 * carries an anonymous per-install id, the version, OS/arch, which runtimes are
 * configured, whether the tunnel and cloud link are on, and rough counts —
 * never prompts, code, file paths, or session content. The anonymization bar
 * (no IP, no fingerprint, no content, no paths) is what makes the opt-out
 * default defensible.
 *
 * Consent lives in the shared `telemetry` consent namespace so the install
 * channel, error reporting, and future usage counters reuse it. See ADR
 * 260713-143958 and 260711-141639.
 *
 * @module services/core/heartbeat-reporter
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { logger } from '../../lib/logger.js';

/** Where the daily heartbeat is delivered. */
export const HEARTBEAT_ENDPOINT = 'https://dorkos.ai/api/telemetry/heartbeat';

/** Minimum gap between heartbeats: one day in milliseconds. */
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** File (under dorkHome) recording when the last heartbeat was sent (epoch ms as text). */
export const LAST_SENT_FILENAME = 'heartbeat-last-sent';

/** Rough activity counts included in the heartbeat. Best-effort; may undercount. */
export interface HeartbeatCounts {
  /** Registered mesh agents. */
  agents: number;
  /** Scheduled tasks. */
  tasks: number;
  /** Configured relay adapters (e.g. Telegram). */
  relayAdapters: number;
}

/**
 * The exact wire-format payload POSTed to the heartbeat endpoint. Every field
 * is anonymous and aggregate-safe by construction — this is the complete set
 * of what may ever be sent, and the privacy test asserts nothing else leaks.
 */
export interface HeartbeatPayload {
  /** Anonymous per-install UUID (shared with install telemetry). NOT a user id. */
  instanceId: string;
  /** DorkOS version that produced the heartbeat (e.g. `0.46.0`). */
  dorkosVersion: string;
  /** Platform and CPU architecture, e.g. `darwin-arm64`. */
  os: string;
  /** Runtime ids the user has enabled, e.g. `["claude-code", "codex"]`. */
  runtimesConfigured: string[];
  /** Whether the public tunnel is enabled (the mobile-access signal). */
  tunnelEnabled: boolean;
  /** Whether this instance is device-linked to a DorkOS cloud account (the multi-instance/fleet signal). */
  cloudLinked: boolean;
  /** Rough activity counts. */
  counts: HeartbeatCounts;
}

/** Inputs needed to build a {@link HeartbeatPayload}, minus the derived OS string. */
export interface HeartbeatInput {
  instanceId: string;
  dorkosVersion: string;
  runtimesConfigured: string[];
  tunnelEnabled: boolean;
  cloudLinked: boolean;
  counts: HeartbeatCounts;
}

/**
 * Build the anonymous heartbeat payload. Pure except for reading
 * `process.platform`/`process.arch` for the `os` field — no PII is ever
 * introduced here.
 *
 * @param input - The anonymous facts to include.
 */
export function buildHeartbeatPayload(input: HeartbeatInput): HeartbeatPayload {
  return {
    instanceId: input.instanceId,
    dorkosVersion: input.dorkosVersion,
    os: `${process.platform}-${process.arch}`,
    runtimesConfigured: input.runtimesConfigured,
    tunnelEnabled: input.tunnelEnabled,
    cloudLinked: input.cloudLinked,
    counts: input.counts,
  };
}

/**
 * Whether a heartbeat is due given the last-sent time and the current time.
 * Due when it has never been sent (`null`) or at least a day has elapsed.
 *
 * @param lastSentMs - Epoch ms of the previous send, or `null` if never sent.
 * @param nowMs - Current epoch ms.
 */
export function isHeartbeatDue(lastSentMs: number | null, nowMs: number): boolean {
  if (lastSentMs === null) return true;
  return nowMs - lastSentMs >= HEARTBEAT_INTERVAL_MS;
}

/**
 * POST a heartbeat payload to the endpoint. Errors are swallowed — telemetry
 * must never surface to the user or destabilize the server.
 *
 * In debug mode (`DORKOS_TELEMETRY_DEBUG`), the exact payload is written to
 * stderr and the network call is skipped, so a power user can audit the wire
 * format for themselves.
 *
 * @param payload - The anonymous payload to send.
 * @param debug - When true, print the payload to stderr instead of sending it.
 */
export async function sendHeartbeat(payload: HeartbeatPayload, debug = false): Promise<void> {
  if (debug) {
    process.stderr.write(
      `[Telemetry] DORKOS_TELEMETRY_DEBUG: heartbeat NOT sent. Would POST to ${HEARTBEAT_ENDPOINT}:\n` +
        `${JSON.stringify(payload, null, 2)}\n`
    );
    return;
  }
  try {
    await fetch(HEARTBEAT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry must never fail user operations.
  }
}

/** Read the last-sent epoch ms from disk, or `null` if absent/unreadable. */
async function readLastSent(dorkHome: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(dorkHome, LAST_SENT_FILENAME), 'utf8');
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the last-sent epoch ms to disk. Best-effort; errors are swallowed. */
async function writeLastSent(dorkHome: string, nowMs: number): Promise<void> {
  try {
    await fs.mkdir(dorkHome, { recursive: true });
    await fs.writeFile(path.join(dorkHome, LAST_SENT_FILENAME), String(nowMs), 'utf8');
  } catch {
    // Best-effort — a failed write just means we may send again sooner.
  }
}

/** Options for {@link maybeSendHeartbeat} and {@link registerHeartbeat}. */
export interface HeartbeatOptions {
  /**
   * The final send decision for the heartbeat. Must already fold in the channel
   * flag, the env kill switch (`DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED`) via
   * `resolveTelemetryConsent`, AND the Tier 1 notice-before-first-send gate
   * (`hasTier1SendGate`) at the call site — this module treats it as the final
   * word.
   */
  consent: boolean;
  /**
   * Debug mode (`DORKOS_TELEMETRY_DEBUG`): print the exact payload to stderr
   * instead of sending it, and do not persist the last-sent marker so it can be
   * re-inspected on every start.
   */
  debug: boolean;
  /** Resolved dorkHome path (for the instance id and last-sent marker). */
  dorkHome: string;
  /** Current DorkOS version. */
  dorkosVersion: string;
  /** Enabled runtime ids. */
  runtimesConfigured: string[];
  /** Whether the tunnel is enabled. */
  tunnelEnabled: boolean;
  /** Whether this instance is cloud-linked. */
  cloudLinked: boolean;
  /** Lazily gather activity counts at send time. Best-effort; may throw (guarded). */
  collectCounts: () => HeartbeatCounts | Promise<HeartbeatCounts>;
}

/**
 * Send a heartbeat if consent is on and one is due. No-op (zero disk, zero
 * network) when `consent` is false. Returns whether a heartbeat was sent.
 *
 * @param options - Consent, identity, and count-collection inputs.
 */
export async function maybeSendHeartbeat(options: HeartbeatOptions): Promise<boolean> {
  if (!options.consent) return false;

  const now = Date.now();
  const lastSent = await readLastSent(options.dorkHome);
  // Debug mode always builds and prints the payload so it can be audited every
  // start; a real send still honors the once-a-week cadence.
  if (!options.debug && !isHeartbeatDue(lastSent, now)) return false;

  let counts: HeartbeatCounts = { agents: 0, tasks: 0, relayAdapters: 0 };
  try {
    counts = await options.collectCounts();
  } catch {
    // Counts are best-effort; a failure just sends zeros.
  }

  const instanceId = await getOrCreateInstanceId(options.dorkHome);
  const payload = buildHeartbeatPayload({
    instanceId,
    dorkosVersion: options.dorkosVersion,
    runtimesConfigured: options.runtimesConfigured,
    tunnelEnabled: options.tunnelEnabled,
    cloudLinked: options.cloudLinked,
    counts,
  });

  await sendHeartbeat(payload, options.debug);
  // Don't advance the cadence marker in debug mode — the payload was printed,
  // not sent, so a real send is still due.
  if (!options.debug) {
    await writeLastSent(options.dorkHome, now);
  }
  return true;
}

/**
 * Register the daily heartbeat for the lifetime of the server.
 *
 * No-op when `options.consent` is false — no timer is scheduled and nothing is
 * read or sent. `consent` must already fold in the channel flag, the env kill
 * switches, and the Tier 1 notice-before-first-send gate at the call site. When
 * consent is on, it sends immediately if one is due (the once-a-day cadence is
 * enforced by the on-disk marker, so a restart storm cannot spam the endpoint)
 * and then re-checks daily. The interval is `unref()`ed so it never keeps the
 * process alive.
 *
 * @param options - Consent, identity, and count-collection inputs.
 */
export function registerHeartbeat(options: HeartbeatOptions): void {
  if (!options.consent) return;

  void maybeSendHeartbeat(options).catch(() => {
    // Swallowed — never let telemetry crash startup.
  });

  const timer = setInterval(() => {
    void maybeSendHeartbeat(options).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();

  logger.info('[Telemetry] Daily heartbeat registered');
}
