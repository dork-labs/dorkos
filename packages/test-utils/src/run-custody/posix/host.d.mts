import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

type Connection = Readonly<{ endpointId: string; token: string }>;
type OwnedGuardian = {
  connection: Connection;
  scopeConnected: Promise<void>;
  scopeEnded: Promise<void>;
  closeMain(): void;
  join(deadline: number): Promise<'closed' | 'cleanup-uncertain'>;
};
export function openPosixGuardian(options: {
  directory: string;
  observer?: string;
  signal: AbortSignal;
  /** Optional test-fixture output FD. Caller owns an open, empty0600 regular file. */
  terminalCleanupReceiptFd?: number;
}): Promise<OwnedGuardian>;
export function bindPosixGuardian(
  child: Pick<EventEmitter, 'once'> & { stdin: Writable; stdout: Readable },
  connection: Connection,
  signal: AbortSignal
): Promise<OwnedGuardian>;
