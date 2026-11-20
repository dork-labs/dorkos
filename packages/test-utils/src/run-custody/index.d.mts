/** Contracts for the private Node run-custody entry. */
export const MAX_FRAME_BYTES: 65536;
export const MAX_LANE_CREDIT: 262144;

export type LaneRead =
  { kind: 'bytes'; frame: Uint8Array } | { kind: 'eof' } | { kind: 'error'; error: unknown };

export interface LaneReader {
  read(): Promise<LaneRead>;
}
export interface LaneWriter {
  /** Snapshots one frame at submission and resolves when admitted against credit. */
  write(frame: Uint8Array): Promise<void>;
  /** Disallows later writes and delivers the pending write ahead of EOF. */
  end(): boolean;
  /** Rejects the pending write and delivers the error after admitted frames. */
  fail(error: unknown): boolean;
}
export function createByteLane(): {
  reader: LaneReader;
  writer: LaneWriter;
  abandon(error: unknown): void;
  readonly creditUsed: number;
};

declare const mainRole: unique symbol;
declare const scopeRole: unique symbol;
export type MainLifeline = { readonly [mainRole]: true };
export type ScopeLifeline = { readonly [scopeRole]: true };
export interface RunAuthority {
  openMain(signal: AbortSignal): MainLifeline;
  openScope(main: MainLifeline, signal: AbortSignal): ScopeLifeline;
  signals(main: MainLifeline, scope: ScopeLifeline): [AbortSignal, AbortSignal];
  acquireScope(main: MainLifeline, scope: ScopeLifeline): (uncertain: boolean) => void;
}
export function createRunAuthority(): RunAuthority;
export function custodyAsset(name: string): URL;

type StdioMode = 'pipe' | 'ignore' | 'inherit';
export interface RunRequest {
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdio: { stdin: StdioMode; stdout: StdioMode; stderr: StdioMode };
  deadline?: number;
  observer?: {
    /** Check the selected native executable immediately before attempting native creation. */
    beforeSpawn?(executable: string): void | Promise<void>;
    onSpawn(fact: NativeIdentity): void | Promise<void>;
    onClose(fact: NativeClose): void | Promise<void>;
  };
}
export interface NativeIdentity {
  pid: number;
  executable: string;
  birth?: string;
}
export interface NativeExit {
  code: number | null;
  signal: string | null;
}
export interface NativeClose {
  integrity: 'verified' | 'failed' | 'unobserved';
}
type Unobserved = { kind: 'unobserved' };
export type Cleanup =
  | { kind: 'never-acquired'; reason: string }
  | { kind: 'cleaned-owned' }
  | { kind: 'cleanup-uncertain'; reason: string; error?: unknown };

export interface RunChild extends NativeIdentity {
  stdin?: LaneWriter;
  stdout?: LaneReader;
  stderr?: LaneReader;
  spawn: Promise<{ kind: 'spawned' } & NativeIdentity>;
  exit: Promise<({ kind: 'exited' } & NativeExit) | Unobserved>;
  close: Promise<
    ({ kind: 'native-closed' } & NativeClose) | { kind: 'transport-lost' } | Unobserved
  >;
  stopAndJoin(reason: string, deadline: number): Promise<Cleanup>;
}
export type StartFailure =
  | { kind: 'never-acquired'; reason: string; cleanup?: Cleanup }
  | { kind: 'interrupted'; reason: string; cleanup: Cleanup }
  | { kind: 'spawn-failed'; error: unknown; cleanup: Cleanup }
  | { kind: 'unsupported'; cleanup: Cleanup };

export class RunStartError extends Error {
  readonly outcome: StartFailure;
  constructor(outcome: StartFailure);
}

export interface RunSpawnPort {
  /** Return observed native custody or reject with a RunStartError for launch failure. */
  start(request: RunRequest, signal: AbortSignal): Promise<RunChild>;
}
export interface BackendEndpoint {
  signal: AbortSignal;
  stdin?: LaneReader;
  stdout?: LaneWriter;
  stderr?: LaneWriter;
  own(stop: (reason: string, deadline: number) => Cleanup | Promise<Cleanup>): void;
  spawned(fact: NativeIdentity): boolean;
  exited(fact: NativeExit): boolean;
  closed(fact: NativeClose): boolean;
  lost(): boolean;
}
export function createRunSpawnPort(options: {
  authority: RunAuthority;
  main: MainLifeline;
  scope: ScopeLifeline;
  cleanupMs: number;
  launch(
    request: RunRequest,
    endpoint: BackendEndpoint
  ): void | { kind: 'unsupported' } | Promise<void | { kind: 'unsupported' }>;
}): RunSpawnPort;
export function custodyReceipt<
  T extends {
    kind:
      | 'never-acquired'
      | 'interrupted'
      | 'spawn-failed'
      | 'native-closed'
      | 'cleaned-owned'
      | 'unsupported'
      | 'cleanup-uncertain';
  },
>(outcome: T): Pick<T, 'kind'>;
