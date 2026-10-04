/**
 * The messages DorkOS and an isolated extension's own process exchange
 * (DOR-2686), and the limits on them.
 *
 * Imported by the host (`isolated-host.ts`, `run-broker.ts`) and bundled into
 * the child (`child/bootstrap.ts`), so it must stay free of server-only
 * imports: no logger, no config, nothing that touches DorkOS's data directory.
 *
 * The child is untrusted input. Every message it sends is checked with
 * {@link isChildMessage} before the host reads a field, and every field is
 * re-checked where it is used. A message that does not parse is dropped.
 *
 * Phase 3 carries the lifecycle (`hello`, `init`, `loaded`, `ping`, `stop`),
 * the program broker (`run-*`) and a test-only `probe`. The `ctx` calls and
 * the HTTP byte streams join in later phases.
 *
 * @module services/extensions/isolation/ipc-protocol
 */

/** What the child reports about Node's permission model before any extension code runs. */
export interface PermissionReport {
  /** Whether `process.permission.has` exists, i.e. Node started with `--permission`. */
  present: boolean;
  /**
   * Whether the child may read its own bootstrap file. Must be `true`: it is
   * the control that proves `has()` answers truthfully rather than `false` for
   * everything (an unknown scope also answers `false`).
   */
  readsBootstrap: boolean;
  /** Whether the child may write to `/` (must be `false`). */
  fsWriteRoot: boolean;
  /** Whether the child may read `/` (must be `false`). */
  fsReadRoot: boolean;
  /** Whether the child may read DorkOS's data directory (must be `false`). */
  readsDorkHome: boolean;
  /** Whether the child may open the inspector (must be `false`). */
  inspector: boolean;
  /** Whether the child may start processes (must be `false`). */
  child: boolean;
  /** Whether the child may start worker threads (must be `false`). */
  worker: boolean;
  /** Whether the child may load native addons (must be `false`). */
  addon: boolean;
  /** Whether the child may use WASI (must be `false`). */
  wasi: boolean;
}

/** The first message a child sends: what it runs on, and what it may do. */
export interface HelloMessage {
  type: 'hello';
  /** `process.version` in the child. */
  node: string;
  /** What Node's permission model allows the child. */
  permission: PermissionReport;
}

/** The child loaded the extension's bundle (or could not). */
export interface LoadedMessage {
  type: 'loaded';
  ok: boolean;
  /** Why loading failed, when it did. */
  error?: string;
}

/** Answer to a {@link PingMessage}. */
export interface PongMessage {
  type: 'pong';
  n: number;
}

/** Ask the host to run an `allow.run` program. */
export interface RunSpawnMessage {
  type: 'run-spawn';
  rid: number;
  file: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string> | null;
  /** Whether the child will write to the program's standard input. */
  stdin: boolean;
}

/** Bytes for a running program's standard input; `null` closes it. */
export interface RunStdinMessage {
  type: 'run-stdin';
  rid: number;
  chunk: Uint8Array | null;
}

/** Stop a running program. */
export interface RunKillMessage {
  type: 'run-kill';
  rid: number;
  signal: string | null;
}

/** A test-only answer to a {@link ProbeMessage}. */
export interface ProbeResultMessage {
  type: 'probe-result';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message: string };
}

/** Every message a child may send. */
export type ChildMessage =
  | HelloMessage
  | LoadedMessage
  | PongMessage
  | RunSpawnMessage
  | RunStdinMessage
  | RunKillMessage
  | ProbeResultMessage;

/** Sent once the host accepted the self-check: what the child needs to start. */
export interface InitMessage {
  type: 'init';
  extensionId: string;
  /** The compiled bundle to load. */
  bundlePath: string;
  /** The `allow.net` list. */
  allowNet: string[];
  /** The `allow.run` list as declared, so `exec` can name the shell the same way. */
  allowRun: string[];
  /** DorkOS's own HTTP port, always refused on loopback. */
  dorkosPort: number;
  /** Whether the test-only `probe` message is answered. */
  testSeams: boolean;
}

/** Liveness check; the child answers with a {@link PongMessage}. */
export interface PingMessage {
  type: 'ping';
  n: number;
}

/** Ask the child to stop. */
export interface StopMessage {
  type: 'stop';
}

/** A program the host started for the child. */
export interface RunSpawnedMessage {
  type: 'run-spawned';
  rid: number;
  pid: number;
}

/** Output from a running program. */
export interface RunDataMessage {
  type: 'run-data';
  rid: number;
  stream: 'stdout' | 'stderr';
  chunk: Uint8Array;
}

/** A program ended. */
export interface RunExitMessage {
  type: 'run-exit';
  rid: number;
  code: number | null;
  signal: string | null;
}

/** A program could not be started, or failed. */
export interface RunErrorMessage {
  type: 'run-error';
  rid: number;
  code: string;
  message: string;
}

/** A test-only request to run one of the bundle's exported probes. */
export interface ProbeMessage {
  type: 'probe';
  id: number;
  name: string;
  args: unknown[];
}

/** Every message the host may send. */
export type HostMessage =
  | InitMessage
  | PingMessage
  | StopMessage
  | RunSpawnedMessage
  | RunDataMessage
  | RunExitMessage
  | RunErrorMessage
  | ProbeMessage;

/** Limits on the channel and on the child (spec §9). */
export const ISOLATION_LIMITS = {
  /** Largest message either side accepts, in bytes. */
  maxMessageBytes: 4 * 1024 * 1024,
  /** Most requests a child may have waiting on the host at once. */
  maxOutstandingCalls: 256,
  /** Host-to-child messages not yet written before the child counts as unresponsive. */
  maxBacklog: 1_000,
  /** Most programs one extension may run at once. */
  maxPrograms: 8,
  /** How long the child has to send its self-check. */
  helloTimeoutMs: 5_000,
  /** How long a child has to exit after `stop` before it is killed. */
  stopGraceMs: 3_000,
  /** How often the host pings a running child. */
  pingIntervalMs: 5_000,
  /** How long without a pong before the child is killed as unresponsive. */
  pongTimeoutMs: 15_000,
  /** Output lines forwarded to the log per window. */
  logLinesPerWindow: 200,
  /** The output window, in milliseconds. */
  logWindowMs: 10_000,
  /** Longest output line forwarded, in characters; the rest is cut. */
  logLineMaxChars: 4_000,
} as const;

/** Error code a refused connection carries. */
export const NET_DENIED_CODE = 'ERR_EXTENSION_NET_DENIED';

/** Error code a refused program carries. */
export const RUN_DENIED_CODE = 'ERR_EXTENSION_RUN_DENIED';

/** The message a synchronous child-process call throws in an isolated extension. */
export const SYNC_RUN_REFUSAL =
  "Isolated extensions can't run programs synchronously; use the async form.";

/**
 * The message an import outside the bundle throws.
 *
 * @param name - The module the bundle asked for.
 */
export function bundleDependencyRefusal(name: string): string {
  return `Isolated extensions must bundle their dependencies: ${name}`;
}

/**
 * Whether a value is a plain record (not null, not an array).
 *
 * @param value - Anything.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is a non-negative safe integer, as ids and counters are.
 *
 * @param value - Anything.
 */
function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether every value of a record is a string.
 *
 * @param value - Anything.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

/**
 * Check the shape of a message from the child. Pure: it never trusts a field
 * it has not checked, and it does not check meaning (whether a program is
 * allowed is the broker's question).
 *
 * @param value - What arrived on the channel.
 * @returns `true` when it is a well-formed {@link ChildMessage}.
 */
export function isChildMessage(value: unknown): value is ChildMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'hello': {
      const p = value.permission;
      return (
        typeof value.node === 'string' &&
        isRecord(p) &&
        [
          'present',
          'readsBootstrap',
          'fsWriteRoot',
          'fsReadRoot',
          'readsDorkHome',
          'inspector',
          'child',
          'worker',
          'addon',
          'wasi',
        ].every((key) => typeof p[key] === 'boolean')
      );
    }
    case 'loaded':
      return (
        typeof value.ok === 'boolean' &&
        (value.error === undefined || typeof value.error === 'string')
      );
    case 'pong':
      return isId(value.n);
    case 'run-spawn':
      return (
        isId(value.rid) &&
        typeof value.file === 'string' &&
        Array.isArray(value.args) &&
        value.args.every((a) => typeof a === 'string') &&
        (value.cwd === null || typeof value.cwd === 'string') &&
        (value.env === null || isStringRecord(value.env)) &&
        typeof value.stdin === 'boolean'
      );
    case 'run-stdin':
      return isId(value.rid) && (value.chunk === null || value.chunk instanceof Uint8Array);
    case 'run-kill':
      return isId(value.rid) && (value.signal === null || typeof value.signal === 'string');
    case 'probe-result':
      return (
        isId(value.id) &&
        typeof value.ok === 'boolean' &&
        (value.error === undefined ||
          (isRecord(value.error) && typeof value.error.message === 'string'))
      );
    default:
      return false;
  }
}
