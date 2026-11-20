/** Private POSIX building blocks. Importing this module does not launch. */
import type { Readable, Writable } from 'node:stream';
import type { RunRequest, RunSpawnPort } from '../index.mjs';
export type PosixIdentity = {
  pid: number;
  parent: number;
  group: number;
  session?: number;
  birth: string;
  executable: string;
};
type OwnedAnchor = Readonly<{ pid: number; group: number; birth: string }>;
type ControlDirection = 'guardian-to-anchor' | 'anchor-to-guardian';
export function createControlWriter(
  secret: string,
  channel: string,
  direction: ControlDirection
): (kind: string, payload: unknown) => Uint8Array;
export function createControlReader(
  secret: string,
  channel: string,
  direction: ControlDirection,
  receive: (kind: string, payload: unknown) => void
): { push(bytes: Uint8Array): void; end(): void };
export function createAnchorPolicy(options: {
  now(): number;
  schedule(deadline: number, callback: () => void): () => void;
  signalCurrentGroup(signal: 'SIGTERM' | 'SIGKILL'): void;
  observeMembers():
    'anchor-alone' | 'members-or-unknown' | Promise<'anchor-alone' | 'members-or-unknown'>;
  leave(result: 'never-started' | 'drained'): void;
}): {
  authorize(): boolean;
  stop(settings: { graceMs: number; deadline: number }): boolean;
};
export function observeLinuxIdentity(
  pid: number,
  read?: (path: string, encoding: 'utf8') => Promise<string>,
  image?: (path: string) => Promise<string>
): Promise<PosixIdentity | undefined>;
export function confirmAnchor(
  snapshot: PosixIdentity | undefined,
  ownedPid: number,
  guardianPid: number
): OwnedAnchor | undefined;
export function observeClosedGroup(
  anchor: OwnedAnchor | undefined,
  anchorWaited: boolean,
  queryGroupPresence: (group: number) => 'present' | 'absent' | 'unknown'
): 'cleaned-owned' | 'cleanup-uncertain';
export function queryGroupPresence(group: number): 'present' | 'absent' | 'unknown';

type AnchorClose = { code: number | null; signal: NodeJS.Signals | null };
export function openGuardianAnchor(options: {
  main: AbortSignal;
  scope: AbortSignal;
  observer?: string;
  receive(kind: 'pid' | 'spawn-failed' | 'exit' | 'child-close', payload: unknown): void;
}): {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  anchorClose: Promise<AnchorClose>;
  ready(deadline?: number): Promise<void>;
  authorize(request: RunRequest, graceMs: number): Promise<void>;
  observeTarget(pid: number): Promise<PosixIdentity | undefined>;
  stopAndJoin(deadline: number): Promise<{
    kind: 'never-acquired' | 'cleaned-owned' | 'cleanup-uncertain';
    anchorClose?: AnchorClose;
  }>;
};

type ScopeConnection = Readonly<{ endpointId: string; token: string }>;
export { openPosixGuardian } from './host.mjs';
export function connectPosixScope(options: {
  directory: string;
  connection: ScopeConnection;
  signal: AbortSignal;
  graceMs?: number;
}): Promise<{ port: RunSpawnPort; close(): void }>;
export { validateDarwinObserver } from './darwin-build.mjs';
export { allocatePosixSocketDirectory } from './socket-directory.mjs';
